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
  SOCKS port only when `backend`, canonical `dataDir`, and `timeout` match the
  first request. A conflicting request rejects with `ERR_ARTI_CONFIG_CONFLICT`.
- Calling `start()` while running returns the existing service.
- The process has one service owner. All handles for the current generation
  refer to that same service; calling `stop()` on any current handle stops it
  for every caller. A handle from an older generation cannot stop a restarted
  service and resolves as an idempotent no-op.
- `stop()` is idempotent, generation-tagged, and waits for the bootstrap thread
  or running service to terminate.
- Stop during bootstrap rejects outstanding starts with a stable cancellation
  error. The configured timeout has the same global semantics: it requests
  cancellation, joins the worker, transitions to `Stopped`, and rejects every
  shared caller with `ERR_ARTI_TIMEOUT`. A late worker result is discarded by
  generation and cannot start a service after timeout.
- The addon accepts `dataDir` explicitly; it does not communicate configuration
  by mutating process-global environment variables.
- Mobile requests for the addon fail with an explicit unsupported/missing
  prebuild error. They never try the desktop sidecar or a debug Cargo binary.
- Desktop remains sidecar-first until the addon is independently promoted.

Errors expose a stable `code` property:

| Code | Meaning | Retryable after returning to `Stopped` |
| --- | --- | --- |
| `ERR_ARTI_UNSUPPORTED_PLATFORM` | No supported backend for this target | No |
| `ERR_ARTI_ADDON_MISSING` | Required mobile addon prebuild cannot load | No |
| `ERR_ARTI_CONFIG_CONFLICT` | Concurrent start options differ | Yes, after stop |
| `ERR_ARTI_CANCELLED` | Stop or realm teardown cancelled startup | Yes |
| `ERR_ARTI_TIMEOUT` | Bootstrap exceeded the configured timeout | Yes |
| `ERR_ARTI_BOOTSTRAP` | Arti could not bootstrap | Yes |
| `ERR_ARTI_BIND` | Loopback SOCKS listener could not bind | Yes |
| `ERR_ARTI_SHUTDOWN` | Native worker did not terminate cleanly | No automatic retry |

Every failure leaves the process in `Stopped`, except `ERR_ARTI_SHUTDOWN`, which
leaves it in a terminal `Failed` state until process restart. PearTube remains
offline for every error.

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

An unrecoverable join/shutdown failure transitions to `Failed`. Operation rules
are deterministic:

| Current state | Operation | Result |
| --- | --- | --- |
| `Stopped` | `start(A)` | Create generation N and enter `Starting(A)` |
| `Starting(A)` | `start(A)` | Share generation N promise |
| `Starting(A)` | `start(B)` | Reject `ERR_ARTI_CONFIG_CONFLICT` |
| `Starting` | `stop(N)` or timeout | Cancel, join, reject starts, enter `Stopped` |
| `Running(A)` | `start(A)` | Return generation N service |
| `Running(A)` | `start(B)` | Reject `ERR_ARTI_CONFIG_CONFLICT` |
| `Running` | `stop(N)` | Stop and join, enter `Stopped` |
| `Stopping` | `start()` | Reject `ERR_ARTI_CANCELLED`; caller retries after stop |
| any newer generation | `stop(old N)` | Resolve without changing state |
| failed bootstrap | completion | Reject once and enter `Stopped` |
| cancelled generation | late completion | Discard and free result |
| `Failed` | any operation | Reject `ERR_ARTI_SHUTDOWN` |

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

The Rust C ABI is intentionally small. C copies `data_dir` before returning from
the call. Result strings are borrowed only for the duration of the callback, and
`binding.c` copies them before queueing JS completion:

```c
typedef struct {
  const char *data_dir;
  uint64_t timeout_ms;
  uint64_t generation;
} bare_arti_options_t;

typedef struct {
  uint64_t generation;
  uint16_t port;
  const char *error_code;
  const char *error_message;
} bare_arti_result_t;

typedef void (*bare_arti_completion_cb)(void *context,
                                        const bare_arti_result_t *result);

int bare_arti_start(const bare_arti_options_t *options,
                    bare_arti_completion_cb callback,
                    void *context);
int bare_arti_stop(uint64_t generation,
                   bare_arti_completion_cb callback,
                   void *context);
```

The integer return reports only synchronous validation/queueing failure; an
accepted operation invokes its callback exactly once from a non-JS worker
thread. `binding.c` owns and frees the thread-safe function, deferred promise,
copied result, and context after settlement. Duplicate callbacks are ignored by
an atomic completion flag; Rust owns result storage for the callback duration,
and the C completion context is released exactly once. Realm teardown
aborts the thread-safe function, requests generation cancellation, and never
settles a promise in the destroyed realm.

## Mobile Build Targets

Required release targets:

- Android `arm64-v8a` / Rust `aarch64-linux-android`
- iOS device arm64 / Rust `aarch64-apple-ios`
- iOS Simulator arm64 / Rust `aarch64-apple-ios-sim` for CI runtime tests

Expected complete module paths are:

```text
prebuilds/android-arm64/bare-arti.bare
prebuilds/ios-arm64/bare-arti.bare
prebuilds/ios-arm64-simulator/bare-arti.bare
```

The workflow must build through the Bare toolchain, not merely compile the root
Rust `rlib`. A target is considered supported only when the complete Bare module
is installed into the expected prebuild layout and loaded by a BareKit harness.

Android builds use a pinned NDK and minimum SDK. iOS builds use a pinned Xcode
runner and deployment target. All Rust and npm dependency graphs remain locked.
Simulator success proves CI runtime compatibility, not iPhone support. iOS is
labelled experimental until the exact release addon loads and completes the
privacy proof on a physical arm64 iPhone. Android has the equivalent physical
arm64 device gate before production support.

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

The event-loop test warms up for one second, schedules a heartbeat every 50 ms,
then holds an injected bootstrap pending for two seconds. It requires at least
30 heartbeats during that window and fails on any gap above 250 ms. Real Tor
bootstrap records the same metric for diagnostics but does not use it as the
deterministic responsiveness gate.

### 5. Real Tor privacy test

Both the Android arm64 emulator and iOS arm64 Simulator jobs perform the full
proof against a temporary v3 onion relay. Each job may retry Tor bootstrap once
with a fresh temporary state directory; a second failure fails the protected
workflow:

1. Start embedded Arti through the addon.
2. Connect `dht-relay-tor` to the onion relay through its SOCKS port.
3. Construct `RelayedDHT` and inject it into Hyperswarm.
4. Announce and discover a topic.
5. Exchange a Noise payload.
6. Assert the relay sees only its Tor-side loopback connection.
7. Install a direct-transport factory sentinel that throws on construction or
   connect; assert it was never invoked.
8. Capture emulator/simulator network activity and assert there are no UDP
   packets while Tor mode is active. Arti's expected outbound TCP connections
   to Tor guards and loopback SOCKS traffic are allowed; any TCP connection to a
   discovered peer address fails the test.

Normal unit CI does not depend on Tor reachability. The protected mobile release
workflow does require successful proofs on both simulated mobile runtimes with
bounded retries and diagnostic logs. Before production support, the same test
must pass on one physical Android arm64 device and one physical iPhone arm64
device using the exact release artifacts.

## PearTube Integration Boundary

PearTube will later own a single network-profile factory. In Tor mode it starts
Arti first, verifies the onion relay, and only then creates RelayedDHT and
Hyperswarm. The direct DHT implementation is not constructed. Any bootstrap,
relay, or addon failure leaves the profile offline.

The first milestone implements stop-on-background and start-on-foreground; it
does not expose native suspend/resume. PearTube must revalidate Tor before
restoring the swarm. A later suspend API requires a separate design. A
Wi-Fi/cellular transition may rebuild Tor circuits but must never temporarily
enable direct HyperDHT.

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

The process will make direct TCP connections to Tor guards; that is required for
Tor and is not a peer-address leak. Packet tests distinguish those connections
from forbidden direct peer traffic.

## Mobile Resource Budgets

Initial production gates per platform are:

- compressed addon prebuild no larger than 30 MiB;
- peak incremental resident memory no higher than 256 MiB during bootstrap;
- steady incremental resident memory no higher than 128 MiB five minutes after
  bootstrap;
- idle CPU average below 2% over five minutes with no active SOCKS streams;
- deterministic injected-bootstrap heartbeat gap no higher than 250 ms;
- no background wake lock after `stop()` completes.

CI records binary size on every build and fails regressions above the limit.
Physical-device release tests record memory, CPU, and lifecycle metrics. Raising
a budget requires an explicit spec and release-note change, not an unreviewed CI
threshold edit.

## CI and Release Gates

Mobile support may be documented or published only after all of the following
are green on the exact release commit:

- JavaScript launcher and fail-closed tests;
- Rust state-machine tests;
- Android arm64 full addon build;
- iOS arm64 full addon build;
- iOS Simulator addon load and responsiveness test;
- Android emulator addon load and responsiveness test;
- real Arti/onion/Hyperswarm privacy proof on both simulated mobile runtimes;
- exact release-artifact privacy proof on physical Android arm64 and iPhone
  arm64 before either is labelled production-supported;
- packet assertion showing no UDP and no direct peer TCP path;
- mobile resource-budget checks;
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
