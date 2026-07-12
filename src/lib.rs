//! Embedded Arti (Rust Tor) SOCKS5 proxy.
//!
//! Boots an in-process Tor client and runs a tiny SOCKS5 CONNECT proxy on
//! localhost. Every CONNECT is dialed through Tor (including `.onion`
//! addresses), so a consumer only has to point an ordinary SOCKS5 client at the
//! returned port — no external `tor` daemon required.
//!
//! This is the "bundled Tor" half of the dht-relay-tor stack: dht-relay-tor's
//! SOCKS5 client already speaks to any SOCKS proxy, so pointing its `proxyPort`
//! at the port returned here removes the external-daemon dependency entirely.
//!
//! The core here builds and runs with plain `cargo` (see `src/bin/arti-socks.rs`)
//! so the Tor embedding is verifiable without the Bare toolchain. The Rust C ABI
//! lives in the staticlib crate under `addon/`; `binding.c` bridges that ABI to
//! Bare promises and thread-safe functions.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};

use anyhow::{anyhow, Context, Result};
use arti_client::config::{BoolOrAuto, CfgPath};
use arti_client::{StreamPrefs, TorClient, TorClientConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::{JoinHandle, JoinSet};
use tor_netdoc::types::policy::AddrPortPattern;
use tor_rtcompat::PreferredRuntime;

pub mod service;

// TorClient isn't Clone; share it across connections behind an Arc.
pub type Client = Arc<TorClient<PreferredRuntime>>;

/// Bootstrap an embedded Tor client, storing Tor state/cache under a default app
/// directory (`$BARE_ARTI_DATA`, else `<tmp>/bare-arti`). This contacts the Tor
/// network and can take a handful of seconds; do it once and reuse the client.
pub async fn bootstrap() -> Result<Client> {
    let dir = std::env::var("BARE_ARTI_DATA").unwrap_or_else(|_| {
        std::env::temp_dir()
            .join("bare-arti")
            .to_string_lossy()
            .into_owned()
    });
    let reachable_addresses = reachable_addresses_from_serialized(
        std::env::var("BARE_ARTI_REACHABLE_ADDRESSES")
            .map(Some)
            .or_else(|error| match error {
                std::env::VarError::NotPresent => Ok(None),
                std::env::VarError::NotUnicode(_) => Err(anyhow!(
                    "BARE_ARTI_REACHABLE_ADDRESSES must contain valid UTF-8"
                )),
            })?
            .as_deref(),
    )?;
    bootstrap_in_with_reachable_addresses(&dir, reachable_addresses.as_deref()).await
}

fn reachable_addresses_from_serialized(value: Option<&str>) -> Result<Option<Vec<String>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_empty() {
        return Err(anyhow!("BARE_ARTI_REACHABLE_ADDRESSES must not be empty"));
    }
    let patterns = value.split(',').map(str::to_owned).collect::<Vec<_>>();
    if patterns.iter().any(|pattern| pattern.is_empty()) {
        return Err(anyhow!(
            "reachable relay address patterns must not be empty"
        ));
    }
    Ok(Some(patterns))
}

fn parse_reachable_address_patterns(patterns: &[String]) -> Result<Vec<AddrPortPattern>> {
    if patterns.is_empty() {
        return Err(anyhow!("reachable relay addresses must not be empty"));
    }
    patterns
        .iter()
        .map(|pattern| {
            pattern
                .parse::<AddrPortPattern>()
                .with_context(|| format!("invalid reachable relay address pattern {pattern:?}"))
        })
        .collect()
}

/// Bootstrap an embedded Tor client with an explicit data directory (state +
/// cache live under it). Use this to give a Pear/app its own persistent Tor
/// storage so reconnects are fast.
pub async fn bootstrap_in(data_dir: &str) -> Result<Client> {
    bootstrap_in_with_reachable_addresses(data_dir, None).await
}

/// Bootstrap with an optional allow-list of relay addresses Arti may contact
/// directly. This constrains Tor relay reachability, not SOCKS destinations.
pub async fn bootstrap_in_with_reachable_addresses(
    data_dir: &str,
    reachable_addresses: Option<&[String]>,
) -> Result<Client> {
    // rustls 0.23 needs a process-level crypto provider chosen explicitly.
    // Ignore the error if one is already installed (idempotent across calls).
    let _ = rustls::crypto::ring::default_provider().install_default();

    std::fs::create_dir_all(data_dir).context("creating Arti data directory")?;

    let mut builder = TorClientConfig::builder();
    builder
        .storage()
        .state_dir(CfgPath::new(format!("{data_dir}/state")))
        .cache_dir(CfgPath::new(format!("{data_dir}/cache")));
    if let Some(reachable_addresses) = reachable_addresses {
        let patterns = parse_reachable_address_patterns(reachable_addresses)?;
        *builder.path_rules().reachable_addrs() = patterns;
    }
    let config = builder.build().context("building tor config")?;

    // create_bootstrapped already returns an Arc<TorClient>.
    let client = TorClient::create_bootstrapped(config)
        .await
        .context("bootstrapping embedded tor client")?;
    Ok(client)
}

/// Bind a localhost SOCKS5 listener and serve CONNECT requests over Tor.
/// Returns the bound port and an owned service whose shutdown joins every task.
pub async fn serve_socks(client: Client, host: &str) -> Result<(u16, SocksService)> {
    serve_socks_with(host, move |sock| {
        let client = client.clone();
        async move {
            // Best-effort: drop the connection on any protocol or Tor error.
            let _ = handle_conn(client, sock).await;
        }
    })
    .await
}

async fn serve_socks_with<H, F>(host: &str, handle: H) -> Result<(u16, SocksService)>
where
    H: Fn(TcpStream) -> F + Send + Sync + 'static,
    F: Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind((host, 0))
        .await
        .context("binding socks listener")?;
    let port = listener.local_addr()?.port();
    let (shutdown, mut shutdown_rx) = oneshot::channel();
    let (terminal_tx, terminal) = oneshot::channel();
    let handle = Arc::new(handle);

    let accept_task = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        let mut outcome = loop {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => break Ok(()),
                accepted = listener.accept() => match accepted {
                Ok((sock, _)) => {
                        let handle = handle.clone();
                        connections.spawn(async move { handle(sock).await });
                }
                    Err(error) => break Err(anyhow!("accepting SOCKS connection: {error}")),
                },
                Some(completed) = connections.join_next(), if !connections.is_empty() => {
                    if let Err(error) = completed {
                        break Err(anyhow!("SOCKS connection task failed: {error}"));
                    }
                }
            }
        };
        // Stop accepting before connection destructors run. Cleanup may block
        // or take time, but no new peer can enter once shutdown has begun.
        drop(listener);
        connections.abort_all();
        while let Some(completed) = connections.join_next().await {
            if let Err(error) = completed {
                if !error.is_cancelled() && outcome.is_ok() {
                    outcome = Err(anyhow!("SOCKS connection task failed: {error}"));
                }
            }
        }
        let _ = terminal_tx.send(());
        outcome
    });

    Ok((
        port,
        SocksService {
            port,
            shutdown: Some(shutdown),
            terminal: Some(terminal),
            accept_task: Some(accept_task),
        },
    ))
}

pub struct SocksService {
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    terminal: Option<oneshot::Receiver<()>>,
    accept_task: Option<JoinHandle<Result<()>>>,
}

impl SocksService {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub async fn wait(&mut self) -> Result<()> {
        let terminal = self
            .terminal
            .as_mut()
            .ok_or_else(|| anyhow!("SOCKS service terminal signal is unavailable"))?;
        terminal
            .await
            .map_err(|_| anyhow!("SOCKS service task ended without a terminal signal"))
    }

    pub async fn shutdown(mut self) -> Result<()> {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let task = self
            .accept_task
            .take()
            .ok_or_else(|| anyhow!("SOCKS service task is unavailable"))?;
        match task.await {
            Ok(result) => result,
            Err(error) => Err(anyhow!("SOCKS service shutdown failed: {error}")),
        }
    }
}

impl Future for SocksService {
    type Output = Result<()>;

    fn poll(mut self: Pin<&mut Self>, context: &mut TaskContext<'_>) -> Poll<Self::Output> {
        let task = match self.accept_task.as_mut() {
            Some(task) => task,
            None => return Poll::Ready(Err(anyhow!("SOCKS service task is unavailable"))),
        };
        match Pin::new(task).poll(context) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Ok(result)) => Poll::Ready(result),
            Poll::Ready(Err(error)) => {
                Poll::Ready(Err(anyhow!("SOCKS service task failed: {error}")))
            }
        }
    }
}

async fn handle_conn(client: Client, mut sock: TcpStream) -> Result<()> {
    // --- SOCKS5 greeting (RFC 1928, no-auth) ---
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        return Err(anyhow!("not a SOCKS5 client"));
    }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods).await?;
    sock.write_all(&[0x05, 0x00]).await?; // select "no authentication"

    // --- request ---
    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await?;
    if req[0] != 0x05 || req[1] != 0x01 {
        // only CONNECT is supported
        sock.write_all(&reply(0x07)).await?;
        return Err(anyhow!("unsupported SOCKS command"));
    }

    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            sock.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            sock.read_exact(&mut name).await?;
            String::from_utf8(name).context("invalid domain name")?
        }
        0x04 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            sock.write_all(&reply(0x08)).await?;
            return Err(anyhow!("unknown address type"));
        }
    };
    let mut p = [0u8; 2];
    sock.read_exact(&mut p).await?;
    let port = u16::from_be_bytes(p);

    // --- dial through Tor (allow .onion) and splice ---
    let mut prefs = StreamPrefs::new();
    prefs.connect_to_onion_services(BoolOrAuto::Explicit(true));

    match client
        .connect_with_prefs((host.as_str(), port), &prefs)
        .await
    {
        Ok(mut tor_stream) => {
            sock.write_all(&reply(0x00)).await?; // succeeded
            tokio::io::copy_bidirectional(&mut sock, &mut tor_stream).await?;
            Ok(())
        }
        Err(e) => {
            sock.write_all(&reply(0x04)).await?; // host unreachable
            Err(anyhow!("tor connect failed: {e}"))
        }
    }
}

// SOCKS5 reply with the given status and a zeroed IPv4 bind address.
fn reply(status: u8) -> [u8; 10] {
    [0x05, status, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn relay_reachability_serialization_and_arti_patterns_fail_closed() {
        assert_eq!(reachable_addresses_from_serialized(None).unwrap(), None);
        assert!(reachable_addresses_from_serialized(Some("")).is_err());
        assert!(reachable_addresses_from_serialized(Some("*:80,,*:443")).is_err());

        let patterns = reachable_addresses_from_serialized(Some("*:80,*:443"))
            .unwrap()
            .unwrap();
        let parsed = parse_reachable_address_patterns(&patterns).unwrap();
        assert_eq!(parsed[0].to_string(), "*:80");
        assert_eq!(parsed[1].to_string(), "*:443");
        assert!(parse_reachable_address_patterns(&[]).is_err());
        assert!(parse_reachable_address_patterns(&["localhost:443".into()]).is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn socks_service_shutdown_aborts_and_joins_active_connections() {
        struct Joined(mpsc::Sender<()>);

        impl Drop for Joined {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }

        let (started_tx, started) = mpsc::sync_channel(0);
        let (joined_tx, joined) = mpsc::channel();
        let (port, service) = serve_socks_with("127.0.0.1", move |_socket| {
            let started_tx = started_tx.clone();
            let joined_tx = joined_tx.clone();
            async move {
                let _joined = Joined(joined_tx);
                let _ = tokio::task::block_in_place(|| started_tx.send(()));
                std::future::pending::<()>().await;
            }
        })
        .await
        .unwrap();
        let _connection = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        tokio::task::block_in_place(|| started.recv_timeout(Duration::from_secs(1))).unwrap();

        service.shutdown().await.unwrap();

        tokio::task::block_in_place(|| joined.recv_timeout(Duration::from_secs(1))).unwrap();
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn socks_service_closes_listener_before_connection_cleanup_finishes() {
        struct BlockingCleanup {
            started: mpsc::Sender<()>,
            release: mpsc::Receiver<()>,
        }

        impl Drop for BlockingCleanup {
            fn drop(&mut self) {
                let _ = self.started.send(());
                let _ = self.release.recv();
            }
        }

        let (handler_started_tx, handler_started) = mpsc::sync_channel(0);
        let (cleanup_started_tx, cleanup_started) = mpsc::channel();
        let (release_tx, release) = mpsc::sync_channel(0);
        let cleanup = Arc::new(std::sync::Mutex::new(Some(BlockingCleanup {
            started: cleanup_started_tx,
            release,
        })));
        let (port, service) = serve_socks_with("127.0.0.1", move |_socket| {
            let handler_started_tx = handler_started_tx.clone();
            let cleanup = cleanup.lock().unwrap().take().unwrap();
            async move {
                let _cleanup = cleanup;
                let _ = tokio::task::block_in_place(|| handler_started_tx.send(()));
                std::future::pending::<()>().await;
            }
        })
        .await
        .unwrap();
        let _connection = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        tokio::task::block_in_place(|| handler_started.recv_timeout(Duration::from_secs(1)))
            .unwrap();

        let shutdown = tokio::spawn(service.shutdown());
        tokio::task::block_in_place(|| cleanup_started.recv_timeout(Duration::from_secs(1)))
            .unwrap();
        let new_connection = TcpStream::connect(("127.0.0.1", port)).await;
        release_tx.send(()).unwrap();

        assert!(
            new_connection.is_err(),
            "listener closes before connection cleanup is released"
        );
        shutdown.await.unwrap().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn socks_service_surfaces_panicking_connection_task() {
        let (port, mut service) = serve_socks_with("127.0.0.1", |_socket| async move {
            panic!("injected connection panic")
        })
        .await
        .unwrap();
        let _connection = TcpStream::connect(("127.0.0.1", port)).await.unwrap();

        service.wait().await.unwrap();
        let error = service.shutdown().await.unwrap_err();

        assert!(error.to_string().contains("panicked"));
    }
}
