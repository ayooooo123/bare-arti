//! Bare native-addon glue (in-process backend).
//!
//! Compiled only through `addon/Cargo.toml` (via bare-make with cmake-cargo), so
//! it never affects the plain `cargo build` that verifies the Tor core. It owns a
//! multi-thread tokio runtime, bootstraps the embedded client once, starts the
//! SOCKS proxy, and hands the bound port back to JS as `start()` / `stop()`.
//!
//! NOTE: this layer targets the bare-rust addon API and is built/run on a real
//! Bare target (see CMakeLists.txt + CI prebuilds); it is not exercised by the
//! cargo-based verification in this repo. The sidecar backend in index.js is the
//! portable, already-verified path.

use std::sync::Mutex;

use bare_rust::{bare_exports, Env, Error, Function, Number, Object, Undefined, Value};
use tokio::runtime::Runtime;

struct Embedded {
    _runtime: Runtime,
    handle: tokio::task::JoinHandle<()>,
    port: u16,
}

static STATE: Mutex<Option<Embedded>> = Mutex::new(None);

bare_exports!(bare_arti_exports, |env| {
    let mut exports = Object::new(&env)?;

    let start = Function::new(&env, |env, _args| {
        let mut guard = STATE.lock().unwrap();
        if guard.is_none() {
            let runtime = Runtime::new().map_err(|err| js_error(&env, err))?;
            let (port, handle) = runtime
                .block_on(async {
                    let client = bare_arti::bootstrap().await?;
                    bare_arti::serve_socks(client, "127.0.0.1").await
                })
                .map_err(|err| js_error(&env, err))?;
            *guard = Some(Embedded {
                _runtime: runtime,
                handle,
                port,
            });
        }
        let port = guard.as_ref().unwrap().port;
        Ok(Number::with_u32(&env, port as u32).into())
    })?;
    exports.set_named_property("start", start)?;

    let stop = Function::new(&env, |env, _args| {
        if let Some(state) = STATE.lock().unwrap().take() {
            state.handle.abort();
        }
        Ok(Undefined::new(&env).into())
    })?;
    exports.set_named_property("stop", stop)?;

    Ok(exports.into())
});

fn js_error(env: &Env, err: impl std::fmt::Display) -> Value {
    Error::new(env, &err.to_string()).into()
}
