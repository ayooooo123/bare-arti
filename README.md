# bare-arti

Embedded **Arti** (the Rust implementation of Tor) as a bundled SOCKS5 proxy for
the [dht-relay-tor](https://github.com/ayooooo123/dht-relay-tor) stack — so "run
the DHT over Tor" needs **no external `tor` daemon** installed on the machine.

It boots an in-process Tor client and exposes a localhost SOCKS5 port; dht-relay-tor's
SOCKS5 client points at that port, and nothing else in the stack changes.

> :test_tube: Experimental. Uses [Arti](https://gitlab.torproject.org/tpo/core/arti)
> (`arti-client`) behind a native Bare addon and a portable sidecar.

## Two backends, one API

`acquire()` returns an independent `{ port, backend, release() }` lease from
whichever backend is available. Matching leases share one physical Arti service,
which stops only after the final lease is released. `release()` is idempotent.

The legacy `start()` API remains available and returns
`{ port, backend, stop() }`:

1. **In-process Bare addon** — a Rust `staticlib` exposed through the C ABI in
   `binding.c`, wrapped as a Bare module, and loaded via `require.addon()`.
   Fully embedded, no subprocess. Built with `bare-make` (Pear/Bare targets).
2. **Sidecar binary** — a prebuilt `arti-socks` executable spawned as a child
   process. Portable across Node and Bare. The binary is exactly what
   `cargo build` produces.

```js
const arti = require('bare-arti')

const tor = await arti.acquire({ dataDir: absoluteAppPrivateDirectory })
console.log('embedded Tor SOCKS5 on 127.0.0.1:' + tor.port)

// hand the port to dht-relay-tor:
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('dht-relay-tor')
const dht = new DHT(await Stream.connect({ onion, proxyPort: tor.port }))

// ...later
await tor.release()
```

Or in one call via the integration entry:

```js
const { connect } = require('dht-relay-tor/arti')
const dht = new (require('@hyperswarm/dht-relay'))(await connect({ onion }))
```

## `acquire(options)` and `start(options)`

- `dataDir` — where Tor keeps its state/cache. An explicit absolute path takes
  precedence over `$BARE_ARTI_DATA`. The mobile addon fails closed when neither
  is supplied; it never guesses a directory from the current working directory,
  `/tmp`, or shared storage. The desktop sidecar alone retains Arti's no-data
  default.
- `insecureFsPermissions` (default `false`) — relax Arti's filesystem-ownership
  hardening. Arti refuses to use a state dir if an ancestor is owned by another
  user; in containers (where `/` may be owned by a different uid) the desktop
  sidecar may need this. It is a security downgrade, so it is opt-in and is
  rejected by the in-process addon rather than weakening mobile validation.
- `reachableAddresses` — an optional non-empty list of relay endpoints that
  Arti may contact directly. The currently supported public form is a wildcard
  address plus one port, for example `['*:80', '*:443']`. Values are validated,
  copied, sorted, deduplicated, and frozen before either backend starts. Omit
  this option to preserve Arti's unrestricted `*:*` default. This is useful on
  constrained mobile or CI networks, but it can reduce the relays Arti can use.
  It limits **direct connections to Tor relays**, not the destinations that an
  application can reach through the SOCKS proxy.
- `timeout` — bootstrap timeout in ms; the first bootstrap can take 10–30s.
  The addon defaults to `600000` (10 minutes), while the desktop sidecar
  defaults to `60000` (1 minute). Both backends enforce bounded startup.

An absolute path is not automatically app-private. The host platform adapter
must choose a directory inside its application container and own that semantic
guarantee. For PearTube, pass its app-private directory explicitly; use
`BARE_ARTI_DATA` as the portable fallback in hosts that configure environment
variables.

For example, a mobile host that only permits common web egress can combine its
app-private directory with a constrained relay policy:

```js
const tor = await arti.acquire({
  dataDir: absoluteAppPrivateDirectory,
  reachableAddresses: ['*:80', '*:443']
})
```

Each `acquire()` call creates a distinct owner. The compatibility `start()` API
represents one legacy owner even when called repeatedly with matching options;
`stop()` releases only that owner. Acquired leases and the legacy owner cannot
stop one another prematurely.

Duplicate `bare-arti` installations in one JavaScript realm coordinate through
a versioned `Symbol.for('bare-arti.ownership')` registry. A conflicting registry
record rejects with `ERR_ARTI_CONFIG_CONFLICT`. The JavaScript registry is
same-realm only; separate Bare worker realms remain protected by the native
singleton and reject incompatible ownership with `ERR_ARTI_REALM_CONFLICT`.

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

CI assembles all five sidecars into a verified publication staging tree,
creates and inspects the future npm tarball, and
uploads that tarball plus the platform archives as a workflow artifact. A `v*`
tag also attaches the bundle to its GitHub Release. The workflow does **not**
publish to npm. A future npm publication must use the CI-assembled tarball, for
example `npm publish bare-arti-0.0.1.tgz`. Never run `npm publish` from a source
checkout, even after a local build; otherwise the published package could omit
one or more supported sidecars.

The in-process addon now builds and loads through `require.addon()` on the host
Bare runtime. Startup and shutdown settle native promises without blocking the
Bare loop, and worker-realm teardown is covered by lifecycle stress tests.

Native addons expose an exact ABI/capability handshake. This release requires
addon ABI `2` with the `reachableAddresses` capability; older or unexpected
binaries fail with `ERR_ARTI_ADDON_INCOMPATIBLE` before native `start()` is
called.

The `Mobile addons` workflow cross-compiles three experimental addon modules:

```text
prebuilds/android-arm64/bare-arti.bare
prebuilds/ios-arm64/bare-arti.bare
prebuilds/ios-arm64-simulator/bare-arti.bare
```

Each target-native job checks the binary architecture, preserves both Cargo
lockfiles, and emits a SHA-256 manifest. Assembly enforces an exact allowlist,
checks every hash, limits each deterministically gzipped module to 30 MiB, and
inspects a mobile-only npm tarball. That tarball is a CI inspection artifact,
not a publishable release: a future release workflow must combine these modules
with every verified desktop sidecar.

These jobs prove complete cross-compilation only. Android and iOS support stays
experimental until BareKit loads the addon in emulator/simulator tests and real
devices pass Tor bootstrap, onion/Hyperswarm connectivity, and process-scoped
socket/IP-leak audits.

## Test

```sh
npm test   # launcher logic (spawn / port-parse / stop) against a fake proxy
npm run test:addon   # after a BARE_ARTI_TESTING debug addon build
```

The launcher tests don't require Tor. The Tor core is verified by building and
running `arti-socks` (above); a full circuit additionally needs Tor network
reachability.

## Package prebuild provenance

The source checkout is marked `private` and its package allowlist excludes
`prebuilds/`, so direct packing cannot capture accumulated local binaries and
direct npm publication is refused even when lifecycle scripts are disabled.
`npm run assemble:package -- <empty-destination> <full-source-sha>` is the only
path that creates non-private publication metadata and adds prebuilds to the
allowlist. It first runs a fail-closed verifier. A publishable staging tree must
contain `prebuilds/provenance.json` tied to the full source commit,
the five production sidecars, exact SHA-256 hashes for every shipped prebuild,
and ABI/capability metadata for any addon. Missing, extra, duplicate, stale, or
locally modified artifacts abort packaging. Build workflows assemble this
manifest; developers should not hand-author it or publish from an accumulated
local `prebuilds/` directory. The staged package retains the `prepack` check as
defense in depth.

Addon provenance accepts only `prebuilds/<target>/bare-arti.bare` for the
explicit tier-1 target set: Linux x64/arm64, macOS x64/arm64, Windows x64,
Android arm64, iOS arm64, and iOS Simulator arm64. Arbitrary basenames, nested
paths, target/path mismatches, and unsupported targets are rejected.

## Status / what's verified here

- ✅ The Arti core (`src/lib.rs`, `arti-socks` bin) **compiles and runs** — it
  initialises rustls, sets up the state manager, and begins Tor bootstrap.
- ✅ The JS launcher (spawn, port parsing, teardown) is unit-tested.
- ✅ The C ABI and host Bare addon bridge are asynchronous and lifecycle-tested.
- ⚠️ A completed Tor circuit needs network egress to the Tor network.
- ⚠️ Android and iOS CI proves cross-compilation, not runtime support; BareKit
  emulator/simulator and physical-device privacy proofs remain release gates.

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
`target/`, `build*/`, `prebuilds/`, and `node_modules/` directories must not be
committed.

## License

MIT
