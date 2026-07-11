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
//! so the Tor embedding is verifiable without the Bare toolchain. The Bare addon
//! glue lives in `binding.rs` and is compiled by the staticlib manifest under
//! `addon/`.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use arti_client::config::{BoolOrAuto, CfgPath};
use arti_client::{StreamPrefs, TorClient, TorClientConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
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
    bootstrap_in(&dir).await
}

/// Bootstrap an embedded Tor client with an explicit data directory (state +
/// cache live under it). Use this to give a Pear/app its own persistent Tor
/// storage so reconnects are fast.
pub async fn bootstrap_in(data_dir: &str) -> Result<Client> {
    // rustls 0.23 needs a process-level crypto provider chosen explicitly.
    // Ignore the error if one is already installed (idempotent across calls).
    let _ = rustls::crypto::ring::default_provider().install_default();

    std::fs::create_dir_all(data_dir).ok();

    let mut builder = TorClientConfig::builder();
    builder
        .storage()
        .state_dir(CfgPath::new(format!("{data_dir}/state")))
        .cache_dir(CfgPath::new(format!("{data_dir}/cache")));
    let config = builder.build().context("building tor config")?;

    // create_bootstrapped already returns an Arc<TorClient>.
    let client = TorClient::create_bootstrapped(config)
        .await
        .context("bootstrapping embedded tor client")?;
    Ok(client)
}

/// Bind a localhost SOCKS5 listener and serve CONNECT requests over Tor.
/// Returns the bound port and the accept-loop task handle.
pub async fn serve_socks(client: Client, host: &str) -> Result<(u16, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind((host, 0))
        .await
        .context("binding socks listener")?;
    let port = listener.local_addr()?.port();

    let handle = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((sock, _)) => {
                    let client = client.clone();
                    tokio::spawn(async move {
                        // Best-effort: drop the connection on any error.
                        let _ = handle_conn(client, sock).await;
                    });
                }
                Err(_) => break,
            }
        }
    });

    Ok((port, handle))
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
