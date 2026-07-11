# Mobile Tor Privacy Design

## Purpose

Make embedded Arti a production-capable Tor backend for PearTube on Android
arm64 and iOS arm64. When PearTube enables Tor mode, its Hyperswarm client must
reach peers through a Tor v3 onion relay without revealing the device IP to the
relay or any swarm peer. Failure to start Tor must leave the P2P stack offline;
there is no direct fallback.

This design covers the reusable `bare-arti` addon, its mobile build and runtime
tests, and the end-to-end privacy contract exercised through `dht-relay-tor`.
PearTube UI integration and routing non-P2P HTTP traffic are separate follow-up
projects.

## Current State

- The Rust Arti core and desktop sidecar build and run.
- Desktop sidecars ship for Linux x64/arm64, macOS x64/arm64, and Windows x64.
- The addon Rust crate type-checks against `bare-rust` 0.0.18.
- The addon currently calls `Runtime::block_on()` from `start()`, holding the
  global state lock while Tor bootstraps. This blocks Bare's JavaScript thread
  and is not suitable for a mobile UI process.
- `bare-rust` 0.0.18 wraps synchronous values and functions but does not expose
  promise or thread-safe callback wrappers. Bare's C `js.h` API does expose
  promises and thread-safe functions, so asynchronous completion belongs in the
  existing C shim.
- The real-Tor workflow proves that a high-level Hyperswarm topic join and Noise
  payload can cross `dht-relay-tor` through a v3 onion service while the relay
  sees only loopback.

## Goals

1. Build one in-process addon implementation for Android arm64 and iOS arm64.
2. Keep the Bare JavaScript and mobile UI threads responsive during bootstrap.
3. Give Node, Bare desktop, BareKit Android, and BareKit iOS one asynchronous JS
   contract.
4. Bind the local SOCKS service only to loopback.
5. Cancel startup and shut down cleanly during app lifecycle transitions.
6. Prove that Tor mode never constructs or selects a direct peer transport.
7. Gate mobile support on compilation, addon loading, responsiveness, and a real
   onion/Hyperswarm privacy test.

## Non-goals

- Routing arbitrary renderer HTTP, WebRTC, DNS, analytics, or Pear platform
  update traffic. Those require a PearTube-wide egress design.
- Hiding the fact that the device uses Tor.
- Defending against global traffic correlation.
- Shipping pluggable transports in the first mobile milestone.
- Publishing the packages to npm as part of this work.
- Enabling `insecureFsPermissions` on consumer devices.

## Selected Approach

Use a shared asynchronous Bare addon on Android and iOS. Keep the verified
sidecar as the default desktop backend until the addon also passes desktop load
tests.

Rejected alternatives:

- An Android sidecar plus iOS addon creates two lifecycle and packaging paths.
- Direct Kotlin and Swift FFI duplicates the Bare boundary and makes the npm
  package less reusable.
- Running synchronous bootstrap in a Bare worker avoids the UI block but still
  leaves addon ownership and mobile packaging split across processes.

## Public JavaScript Contract

```js
const arti = require('bare-arti')

const tor = await arti.start({
  backend: 'addon',
  dataDir: appPrivateTorDirectory,
  timeout: 10 * 60 * 1000
})

// { port, backend: 'addon', stop() }
await tor.stop()
```

Contract rules:

- `start()` always returns a promise.
- Concurrent starts share one startup operation and resolve to the same local
  SOCKS port.
- Calling `start()` while running returns the existing service.
- `stop()` is idempotent and waits for the bootstrap thread or running service
  to terminate.
- Stop during bootstrap rejects outstanding starts with a stable cancellation
  error.
- The addon accepts `dataDir` explicitly; it does not communicate configuration
  by mutating process-global environment variables.
- Mobile requests for the addon fail with an explicit unsupported/missing
  prebuild error. They never try the desktop sidecar or a debug Cargo binary.
- Desktop remains sidecar-first until the addon is independently promoted.

## Native Architecture

### Rust service state

The Rust static library owns a process-wide state machine:

```text
Stopped -> Starting -> Running
              |           |
              v           v
           Stopping <- Stopping
              |
              v
            Stopped
```

`Starting` owns a cancellation signal and a join handle. `Running` owns the
Tokio runtime, SOCKS accept-loop handle, and bound port. The global mutex is held
only for state transitions; it is never held during network bootstrap or thread
join.

Bootstrap executes on a dedicated native thread with its own Tokio runtime.
Completion is reported exactly once as either a port, an error, or cancellation.
The SOCKS listener continues to bind to `127.0.0.1` with an ephemeral port.

### Bare bridge

`binding.c` owns the JavaScript-facing asynchronous bridge:

1. Create a JS promise and deferred handle.
2. Create a Bare thread-safe function for completion delivery.
3. Call the Rust C ABI start function with explicit options and an opaque
   completion context.
4. Rust bootstraps on its native thread and invokes the C completion callback.
5. The callback queues the result through the thread-safe function.
6. Bare settles the promise on the JS thread and releases all native handles.

No Rust worker thread may call a JavaScript or `bare-rust` value directly.
Environment teardown registers a deferred teardown callback that requests stop
and releases the thread-safe function without accessing a destroyed JS realm.

The Rust C ABI is intentionally small:

```c
bare_arti_start(options, completion_callback, context)
bare_arti_stop(completion_callback, context)
```

The exact ownership structs live in `binding.c`; Rust receives copied strings
and primitive options only.

## Mobile Build Targets

Required release targets:

- Android `arm64-v8a` / Rust `aarch64-linux-android`
- iOS device arm64 / Rust `aarch64-apple-ios`
- iOS Simulator arm64 / Rust `aarch64-apple-ios-sim` for CI runtime tests

The workflow must build through the Bare toolchain, not merely compile the root
Rust `rlib`. A target is considered supported only when the complete Bare module
is installed into the expected prebuild layout and loaded by a BareKit harness.

Android builds use a pinned NDK and minimum SDK. iOS builds use a pinned Xcode
runner and deployment target. All Rust and npm dependency graphs remain locked.

## Test Strategy

Implementation follows red-green-refactor. Each production behavior begins with
a test that fails for the expected missing behavior.

### 1. JavaScript contract tests

- `start()` treats addon startup as asynchronous.
- Concurrent calls share startup and do not mutate environment variables.
- Stop during startup rejects with cancellation.
- Repeated stop is safe.
- Mobile addon load failure is explicit and never invokes sidecar spawn.
- Desktop backend selection remains sidecar-first.

The binding is injected through the module cache, following the existing
launcher tests. These tests run on Node without Tor egress.

### 2. Rust state-machine tests

Factor bootstrap behind an internal async operation so tests can use a
controlled delayed result without contacting Tor. Verify:

- one bootstrap for concurrent starts;
- mutex is not held while bootstrapping;
- successful transition to running;
- cancellation while starting;
- idempotent stop;
- restart after stop;
- all worker/runtime resources are joined or dropped.

Protocol parsing remains covered independently from live Tor reachability.

### 3. Cross-compilation gates

CI builds the root core and complete addon for all three mobile targets. It
checks binary architecture and verifies that expected prebuild files are the
only produced artifacts. Build success alone does not mark a platform runtime
supported.

### 4. Bare and BareKit runtime tests

- A host Bare test loads the addon with `require.addon()` and uses an injected
  delayed bootstrap to prove the event loop continues ticking.
- Android emulator arm64 loads the packaged addon through BareKit.
- iOS Simulator arm64 loads the packaged addon through BareKit.
- Each harness verifies async resolution, loopback binding, stop, and restart.

The event-loop test runs a short JS heartbeat while bootstrap is pending and
fails if heartbeats pause beyond the allowed scheduling tolerance.

### 5. Real Tor privacy test

At least one mobile runtime job performs the full proof against a temporary v3
onion relay:

1. Start embedded Arti through the addon.
2. Connect `dht-relay-tor` to the onion relay through its SOCKS port.
3. Construct `RelayedDHT` and inject it into Hyperswarm.
4. Announce and discover a topic.
5. Exchange a Noise payload.
6. Assert the relay sees only its Tor-side loopback connection.
7. Install a direct-transport sentinel that throws on construction or connect;
   assert it was never invoked.

Normal unit CI does not depend on Tor reachability. The protected mobile release
workflow does require a successful real-network proof with bounded retries and
diagnostic logs.

## PearTube Integration Boundary

PearTube will later own a single network-profile factory. In Tor mode it starts
Arti first, verifies the onion relay, and only then creates RelayedDHT and
Hyperswarm. The direct DHT implementation is not constructed. Any bootstrap,
relay, or addon failure leaves the profile offline.

Mobile lifecycle handling must stop or suspend networking when the OS revokes
execution time, then revalidate Tor before restoring the swarm. A Wi-Fi/cellular
transition may rebuild Tor circuits but must never temporarily enable direct
HyperDHT.

Separate Tor-mode peer keys should be supported so peers cannot trivially link
a user's prior direct transport identity to their masked transport identity.

## Security Invariants

- No direct P2P fallback in Tor mode.
- No UDP DHT or holepunch socket in Tor mode.
- SOCKS listens only on loopback.
- Mobile state/cache lives in an app-owned private directory.
- `insecureFsPermissions` is unavailable in normal mobile configuration.
- JS values are touched only on the Bare JS thread.
- Native callbacks complete at most once and remain safe during realm teardown.
- The relay never receives the client's network address from the application
  socket; payloads remain protected by the peer-to-peer Noise session.
- Logs never include onion private keys, Tor state, peer secret keys, or full
  user filesystem paths.

## CI and Release Gates

Mobile support may be documented or published only after all of the following
are green on the exact release commit:

- JavaScript launcher and fail-closed tests;
- Rust state-machine tests;
- Android arm64 full addon build;
- iOS arm64 full addon build;
- iOS Simulator addon load and responsiveness test;
- Android emulator addon load and responsiveness test;
- real Arti/onion/Hyperswarm privacy proof;
- package tarball inspection containing the expected mobile prebuilds;
- checksums and provenance for every native artifact.

Until then, README and package metadata continue to identify mobile/addon support
as experimental and pending.

## Implementation Sequence

1. Add failing JS tests for asynchronous startup, explicit backend selection,
   cancellation, and fail-closed mobile behavior.
2. Add failing Rust tests for the service state machine.
3. Refactor the Rust core into the tested nonblocking service controller.
4. Implement the promise/thread-safe-function bridge in `binding.c` and the
   minimal Rust C ABI.
5. Make the host Bare addon build and load test pass.
6. Add Android and iOS cross-compilation jobs.
7. Add BareKit emulator/simulator load and heartbeat harnesses.
8. Extend the real onion workflow to the addon and direct-transport sentinel.
9. Add mobile prebuild assembly, inspection, checksums, and attestations.

## Success Criterion

On both Android arm64 and iOS arm64, enabling the future PearTube Tor profile can
start embedded Arti without freezing the app, join a Hyperswarm topic through an
onion relay, exchange a Noise payload, and prove that no direct transport was
created and no peer or relay learned the device IP.
