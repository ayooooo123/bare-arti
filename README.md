# bare-arti

Embedded **Arti** (the Rust implementation of Tor) as a bundled SOCKS5 proxy for
the [dht-relay-tor](https://github.com/ayooooo123/dht-relay-tor) stack — so "run
the DHT over Tor" needs **no external `tor` daemon** installed on the machine.

It boots an in-process Tor client and exposes a localhost SOCKS5 port; dht-relay-tor's
SOCKS5 client points at that port, and nothing else in the stack changes.

> :test_tube: Experimental. Uses [Arti](https://gitlab.torproject.org/tpo/core/arti)
> (`arti-client`) and Holepunch's [bare-rust](https://github.com/holepunchto/bare-rust)
> Bare-addon bindings.

## Two backends, one API

`start()` returns `{ port, backend, stop() }` from whichever backend is available:

1. **In-process Bare addon** — a Rust `staticlib` + `bare-rust` binding, wrapped
   as a Bare module and loaded via `require.addon()`. Fully embedded, no
   subprocess. Built with `bare-make` (Pear/Bare targets).
2. **Sidecar binary** — a prebuilt `arti-socks` executable spawned as a child
   process. Portable across Node and Bare. The binary is exactly what
   `cargo build` produces.

```js
const arti = require('bare-arti')

const tor = await arti.start({ insecureFsPermissions: true }) // see note below
console.log('embedded Tor SOCKS5 on 127.0.0.1:' + tor.port)

// hand the port to dht-relay-tor:
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('dht-relay-tor')
const dht = new DHT(await Stream.connect({ onion, proxyPort: tor.port }))

// ...later
tor.stop()
```

Or in one call via the integration entry:

```js
const { connect } = require('dht-relay-tor/arti')
const dht = new (require('@hyperswarm/dht-relay'))(await connect({ onion }))
```

## `start(options)`

- `dataDir` — where Tor keeps its state/cache (default `$BARE_ARTI_DATA` or
  `<tmp>/bare-arti`). Give each app its own dir for fast reconnects.
- `insecureFsPermissions` (default `false`) — relax Arti's filesystem-ownership
  hardening. Arti refuses to use a state dir if an ancestor is owned by another
  user; in containers (where `/` may be owned by a different uid) you need this.
  It is a security downgrade (it stops Arti from checking that no one else can
  read your Tor state), so it is opt-in.
- `timeout` (default `60000`) — sidecar bootstrap timeout in ms; the first
  bootstrap can take 10–30s. The addon does not support this option yet.

## Build

The Rust **core** builds and runs with plain cargo (this is what verifies the Tor
embedding):

```sh
cargo build --release --bin arti-socks   # the sidecar binary
cargo run --bin arti-socks               # boots Tor, prints the SOCKS port
```

The **in-process addon** is built with the Bare toolchain:

```sh
npm run build:addon   # bare-make generate && build && install  → prebuilds/
```

GitHub Actions builds native sidecars for Linux x64/arm64, macOS x64/arm64, and
Windows x64. Each build is archived as
`sidecar-<platform>-<arch>.tar.gz`, preserving executable modes. Each platform
archive contains `<platform>-<arch>/arti-socks[.exe]`; CI extracts those paths
beneath `prebuilds/` to assemble:

```text
prebuilds/linux-x64/arti-socks
prebuilds/linux-arm64/arti-socks
prebuilds/darwin-x64/arti-socks
prebuilds/darwin-arm64/arti-socks
prebuilds/win32-x64/arti-socks.exe
```

Linux sidecars are built in Ubuntu 22.04 containers and require glibc 2.35 or
newer. Alpine Linux and other musl-based distributions are not currently
supported.

CI assembles all five sidecars, creates and inspects the future npm tarball, and
uploads that tarball plus the platform archives as a workflow artifact. A `v*`
tag also attaches the bundle to its GitHub Release. The workflow does **not**
publish to npm. A future npm publication must use the CI-assembled tarball, for
example `npm publish bare-arti-0.0.1.tgz`. Never run `npm publish` from a source
checkout, even after a local build; otherwise the published package could omit
one or more supported sidecars.

The in-process Bare addon remains a TODO. Its Rust layer type-checks locally,
but its cmake-bare build/install and `require.addon()` load path are not yet
verified, so no addon prebuild ships. Its current bootstrap is synchronous and
blocks the calling thread, and the `timeout` option is unsupported by this
backend.

## Test

```sh
npm test   # launcher logic (spawn / port-parse / stop) against a fake proxy
```

The launcher tests don't require Tor. The Tor core is verified by building and
running `arti-socks` (above); a full circuit additionally needs Tor network
reachability.

## Status / what's verified here

- ✅ The Arti core (`src/lib.rs`, `arti-socks` bin) **compiles and runs** — it
  initialises rustls, sets up the state manager, and begins Tor bootstrap.
- ✅ The JS launcher (spawn, port parsing, teardown) is unit-tested.
- ⚠️ A completed Tor circuit needs network egress to the Tor network.
- ⚠️ The `bare-rust` addon binding (`src/binding.rs`, `binding.js`, `CMakeLists.txt`)
  targets the Bare toolchain and is built/run there — it is scaffolding, not
  exercised by the cargo build.

## Why bundle at all?

External-daemon Tor means "install and run `tor`, then use it." Bundling Arti
makes a Pear/Bare app self-contained: it ships the Tor client, so a user just
runs the app and gets IP-masked DHT connectivity with nothing else to set up.

## Contributing

Clone the repository, then install and verify the JavaScript package:

```sh
npm install
npm run format
npm test
```

Verify the release sidecar separately with a locked Rust dependency graph:

```sh
cargo build --locked --release --bin arti-socks
```

For local integration work, run `npm link` here and then `npm link bare-arti` in
a checkout of
[dht-relay-tor](https://github.com/ayooooo123/dht-relay-tor). Generated
`target/`, `build/`, `prebuilds/`, and `node_modules/` directories must not be
committed.

## License

MIT
