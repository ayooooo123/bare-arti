//! Standalone runner: boots embedded Arti and prints the SOCKS5 port.
//!
//! Verifies the Tor core without the Bare toolchain:
//!   cargo run --bin arti-socks
//! then point any SOCKS5 client (curl --socks5-hostname 127.0.0.1:<port>, or
//! dht-relay-tor with proxyPort=<port>) at the printed port.

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    eprintln!("bootstrapping embedded tor (this can take ~10-30s the first time)...");
    let client = bare_arti::bootstrap().await?;
    let (port, handle) = bare_arti::serve_socks(client, "127.0.0.1").await?;

    println!("{port}"); // machine-readable on stdout
    eprintln!("embedded arti SOCKS5 proxy listening on 127.0.0.1:{port}");

    handle.await?;
    Ok(())
}
