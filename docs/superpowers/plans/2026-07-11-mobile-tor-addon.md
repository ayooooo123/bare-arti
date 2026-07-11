# Mobile Tor Addon Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blocking addon scaffold with a tested asynchronous Bare addon that fails closed, builds as a complete module for Android arm64 and iOS arm64, and is ready for BareKit runtime/privacy harness work.

**Architecture:** A small JavaScript controller owns one addon startup promise and validates backend/configuration. A Rust service controller owns the process-wide generation/state machine on a native thread. The C Bare module creates promises and thread-safe completion functions, calls a narrow Rust C ABI, and is the only layer that touches JS values.

**Tech Stack:** Bare JS, `js.h` C addon API, Rust 2021, Tokio, Arti 0.44, cmake-bare, cmake-cargo, bare-make, Brittle, GitHub Actions, Android NDK, Xcode iOS SDK.

**Spec:** `docs/superpowers/specs/2026-07-11-mobile-tor-privacy-design.md`

**Scope note:** This plan delivers the reusable async addon, host-runtime proof, and mobile build artifacts. A second plan will integrate the exact artifacts into Android emulator/iOS Simulator BareKit harnesses and the real onion/Hyperswarm packet-audit proof; this plan must not claim runtime mobile support by cross-compilation alone.

---

## File Map

- Create `lib/errors.js`: stable `ERR_ARTI_*` construction and option-validation errors.
- Create `lib/addon-controller.js`: one-realm promise/config/generation ownership for the native addon.
- Create `lib/backend.js`: testable platform/backend policy with no additional public export.
- Create `lib/sidecar.js`: existing desktop sidecar spawn implementation, separated from backend selection.
- Modify `index.js`: public backend selection; mobile addon-required and desktop sidecar-first behavior.
- Create `test/all.js`: test entrypoint.
- Create `test/addon-controller.js`: deterministic async, conflict, cancellation, stale-handle, and error tests.
- Create `test/backend-selection.js`: mobile fail-closed and desktop sidecar-first tests.
- Modify `test/launcher.js`: sidecar-only tests after the split.
- Modify `package.json`: test entrypoint and host-addon scripts.
- Modify `.gitignore`: stop ignoring `package-lock.json` for reproducible `npm ci`.
- Add `package-lock.json`: locked JavaScript build/test dependency graph.
- Create `src/service.rs`: Rust service state machine, worker lifecycle, cancellation, and injected bootstrap seam.
- Modify `src/lib.rs`: export the service controller and retain Tor/SOCKS core.
- Create `addon/src/lib.rs`: narrow Rust C ABI over the service controller.
- Modify `addon/Cargo.toml`: point the staticlib at `addon/src/lib.rs`; remove `bare-rust`.
- Delete `src/binding.rs`: remove the synchronous `bare-rust` addon scaffold.
- Modify `binding.c`: Bare promises, thread-safe function completion, realm teardown, and stable errors.
- Create `test/addon.js`: real host Bare load, asynchronous heartbeat, stop, and restart test.
- Modify `CMakeLists.txt`: link the Rust staticlib and enable a test-only delayed bootstrap feature.
- Create `scripts/verify-mobile-prebuild.js`: reusable exact-path, allowlist,
  checksum, and deterministic compressed-size checks.
- Create `scripts/locked-bin/cargo`: CMake-visible wrapper enforcing locked
  Cargo build and metadata commands.
- Create `.github/workflows/mobile.yml`: locked Android/iOS complete-addon builds and artifact checks.
- Modify `README.md`: distinguish desktop-supported sidecars from build-only experimental mobile addons.

---

## Chunk 1: JavaScript Contract and Fail-Closed Selection

### Task 1: Split the test entrypoint without changing behavior

**Files:**

- Create: `test/all.js`
- Modify: `package.json`
- Modify: `.gitignore`
- Add: `package-lock.json`

- [ ] **Step 1: Add the test entrypoint**

```js
require('./launcher')
```

- [ ] **Step 2: Point npm test at the entrypoint**

Change `node test/launcher.js` to `node test/all.js`.

- [ ] **Step 3: Verify the unchanged baseline**

Run: `npm test`

Expected: `8/8` tests and `15/15` assertions pass.

- [ ] **Step 4: Commit**

```sh
git add package.json test/all.js
git commit -m "test: add bare-arti test entrypoint"
```

### Task 2: Define stable JavaScript errors and configuration validation

**Files:**

- Create: `lib/errors.js`
- Create: `test/addon-controller.js`
- Modify: `test/all.js`

- [ ] **Step 1: Write failing validation tests**

Add tests that import `validateAddonOptions` from `lib/addon-controller.js` with
the explicit signature `validateAddonOptions(options, { platform, fs, path,
getuid })` and assert:

```js
const dependencies = { platform: 'android', fs, path, getuid: () => process.getuid() }
const options = validateAddonOptions(
  {
    backend: 'addon',
    dataDir: absolutePrivateDirectory,
    timeout: 600000
  },
  dependencies
)

t.is(options.backend, 'addon')
t.is(options.timeout, 600000)
await t.exception(
  Promise.resolve().then(() => validateAddonOptions({ dataDir: 'relative' }, dependencies)),
  (err) => err.code === 'ERR_ARTI_CONFIG'
)
```

Cover omitted timeout defaulting to `600000`, values below `1000`, above
`1800000`, non-integers, missing mobile `dataDir`, and a final symlink path. Use
a temporary owner-only directory and restore it in teardown. When `stat.uid` and
`getuid()` are available, a mismatched owner must reject `ERR_ARTI_CONFIG`.

- [ ] **Step 2: Verify RED**

Run: `node test/addon-controller.js`

Expected: FAIL with `Cannot find module '../lib/addon-controller'`.

- [ ] **Step 3: Implement the minimal error and validation helpers**

`lib/errors.js`:

```js
class ArtiError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.code = code
  }
}

function artiError(code, message, cause) {
  return new ArtiError(code, message, cause)
}

module.exports = { ArtiError, artiError }
```

`validateAddonOptions()` must use only the passed dependency object, resolve an
absolute path, reject symlinks on Android/iOS, create the directory with mode
`0o700`, canonicalize it, verify owner UID and owner-only permission bits where
available, default timeout to `600000`, and return a frozen normalized object.
Production passes `process.platform`, filesystem/path modules, and
`process.getuid`; tests inject them. Do not mutate `process.env`.

- [ ] **Step 4: Verify GREEN and regression suite**

Run: `node test/addon-controller.js && npm test`

Expected: validation tests and existing launcher tests pass.

- [ ] **Step 5: Commit**

```sh
git add lib/errors.js lib/addon-controller.js test/addon-controller.js test/all.js
git commit -m "feat: validate secure addon configuration"
```

### Task 3: Implement one-generation asynchronous addon ownership

**Files:**

- Modify: `lib/addon-controller.js`
- Modify: `test/addon-controller.js`

- [ ] **Step 1: Write failing ownership tests**

Use a fake binding whose `start()` returns a controllable promise. Test:

- public `start(A)` returns a promise even when validation fails synchronously;
- matching `start(A)` returns the identical promise object;
- `start(B)` rejects with `ERR_ARTI_CONFIG_CONFLICT`;
- timeout cancels native start and rejects all callers with `ERR_ARTI_TIMEOUT`;
- controller/module-level `stop()` during start rejects with `ERR_ARTI_CANCELLED`;
- matching handles stop one generation once;
- stale handle stop cannot stop a restarted generation;
- matching stop calls share one stop promise;
- start during stopping rejects and native stop must settle before callers
  reject/resolve, state returns to `Stopped`, or restart is allowed;
- native errors retain documented `code` values.

The desired constructor is:

```js
const controller = createAddonController({
  binding,
  validateOptions: (options) => validateAddonOptions(options, validationDependencies),
  setTimer,
  clearTimer
})
```

- [ ] **Step 2: Verify RED**

Run: `node test/addon-controller.js`

Expected: FAIL because `createAddonController` is missing.

- [ ] **Step 3: Implement minimal controller state**

Keep private state `{ generation, status, config, starting, stopping, service }`.
Public `start()` catches synchronous validation errors and returns
`Promise.reject(error)`; after successful validation it synchronously returns
the stored startup promise for matching configuration, preserving promise
identity. Call `binding.start(config, generation)` once. Expose controller
`stop()` so the public module can cancel before a service handle exists. Wrap
successful native `{ port }` as a frozen `{ port, backend: 'addon', stop }`. Map
undocumented native failures to `ERR_ARTI_BOOTSTRAP`. `stop()` stores and shares
the native stop promise; it does not settle callers, reset state, accept restart,
or discard the generation until `binding.stop(generation)` settles. A late start
completion is ignored only after native stop has completed.

- [ ] **Step 4: Verify GREEN**

Run: `node test/addon-controller.js && npm test`

Expected: all controller and launcher tests pass with no environment mutation.

- [ ] **Step 5: Commit**

```sh
git add lib/addon-controller.js test/addon-controller.js
git commit -m "feat: add asynchronous addon controller"
```

### Task 4: Enforce mobile addon-only and desktop sidecar-first selection

**Files:**

- Create: `lib/backend.js`
- Create: `lib/sidecar.js`
- Create: `test/backend-selection.js`
- Modify: `test/launcher.js`
- Modify: `test/all.js`
- Modify: `index.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing backend-selection tests**

Import `createBackend()` directly from private `lib/backend.js` and inject
`{ platform, arch, loadAddon, startSidecar }`. Assert:

- Android/iOS missing addon rejects `ERR_ARTI_ADDON_MISSING` and sidecar call count remains zero;
- Android/iOS explicit `backend: 'sidecar'` rejects `ERR_ARTI_UNSUPPORTED_PLATFORM`;
- desktop default calls sidecar without trying addon;
- desktop explicit addon calls only addon;
- published sidecar missing prebuild rejects a clear error and never tries `target/debug`.
- module exports only `start` and `stop`; handle `stop()` delegates with its
  captured generation;
- existing explicit `bin`, explicit/inherited `BARE_ARTI_DATA`,
  `insecureFsPermissions`, port parsing, timeout, early exit, and stop behavior
  remain covered by `test/launcher.js` after the move.

- [ ] **Step 2: Verify RED**

Run: `node test/backend-selection.js`

Expected: FAIL because `createBackend` is missing and current code auto-tries addon/debug sidecar.

- [ ] **Step 3: Split and implement minimal backend selection**

Move sidecar spawn/port parsing into `lib/sidecar.js` without changing its
documented environment/override behavior. Put testable platform policy in
`lib/backend.js`; `index.js` keeps only the public `start` and `stop` exports plus
production dependency wiring. Select addon only for mobile or explicit desktop
addon.
Permit the debug Cargo binary only when `options.dev === true`;
published/default execution requires the platform prebuild. Add `lib/**/*.js`
to `package.json.files`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test`

Expected: all launcher, controller, and selection tests pass.

Run `npm pack --json` and inspect the returned file list. Expected: `index.js`,
`binding.js`, and all four `lib/*.js` runtime files are present; `target/`,
`build/`, tests, and debug binaries are absent.

- [ ] **Step 5: Commit**

```sh
git add index.js lib/backend.js lib/sidecar.js package.json test/launcher.js test/backend-selection.js test/all.js
git commit -m "feat: fail closed when mobile addon is unavailable"
```

---

## Chunk 2: Rust Service Controller and C ABI

### Task 5: Add the Rust service state tests first

**Files:**

- Create: `src/service.rs`
- Modify: `src/lib.rs`

- [ ] **Step 1: Add a test-only worker seam and failing state tests**

Define the desired public types in tests before implementation:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceOptions {
    pub data_dir: PathBuf,
    pub timeout: Duration,
    pub generation: u64,
}

pub enum ServiceEvent {
    Running { generation: u64, port: u16 },
    Failed { generation: u64, code: &'static str, message: String },
    Stopped { generation: u64 },
}
```

Define the callable boundary used by tests and the C ABI:

```rust
type Completion = Box<dyn FnOnce(ServiceEvent) + Send + 'static>;

pub trait WorkerFactory: Send + Sync {
    fn spawn(
        &self,
        options: ServiceOptions,
        cancel: tokio::sync::oneshot::Receiver<()>,
        ready: std::sync::mpsc::SyncSender<Result<u16, ServiceError>>,
    ) -> JoinHandle<Result<(), ServiceError>>;
}

pub enum StartupOutcome {
    Ready(Result<u16, ServiceError>),
    Timeout,
    WorkerExited,
}

pub trait StartupGate: Send + Sync {
    fn wait(
        &self,
        ready: std::sync::mpsc::Receiver<Result<u16, ServiceError>>,
        duration: Duration,
    ) -> StartupOutcome;
}

impl ServiceController {
    pub fn start(&self, options: ServiceOptions, completion: Completion)
        -> Result<(), ServiceError>;
    pub fn stop(&self, generation: u64, completion: Completion)
        -> Result<(), ServiceError>;
}
```

`start()`/`stop()` return only synchronous validation/queueing errors. Accepted
operations invoke completion once. Startup completion reports `Running` or
`Failed`; stop completion is emitted only after the worker join reports terminal
exit. The worker therefore has a separate one-shot `ready` channel and terminal
`JoinHandle` result rather than one event for its whole lifetime.

Use controlled `WorkerFactory` and `StartupGate` implementations with manual
channels to test every spec transition: matching/conflicting start, global
timeout, cancellation, late completion, stale stop, start during stopping,
bootstrap recovery, restart, and terminal shutdown failure. The production gate
uses `ready.recv_timeout(duration)` and maps channel disconnect to
`WorkerExited`; the test gate blocks on a manual control channel and returns
`Ready` or `Timeout` deterministically without short wall-clock sleeps.

The JavaScript controller supplies generation numbers. Rust accepts a new
generation only when it is strictly greater than the last accepted generation,
preserves it in every event, and rejects reuse/out-of-order generations
synchronously. Rust does not allocate a competing generation.

- [ ] **Step 2: Verify RED**

Run: `cargo test --locked service::tests -- --nocapture`

Expected: compile failure for missing controller methods/state.

- [ ] **Step 3: Implement only enough state to pass deterministic tests**

Use `Arc<Mutex<Inner>>`, last-accepted generation validation, and one native
worker thread per active generation. Never hold the mutex while waiting for a
channel or joining a thread. A supervisor owns the `StartupGate`, ready receiver,
cancel sender, and join handle. `Ready` disarms the startup deadline permanently
by returning from the gate and fires start completion. `Timeout` or
`WorkerExited` sends the one-shot cancellation, joins the worker, and only then
resets state and invokes completion. Stop uses the same cancel sender and join
ordering. A ready/timeout race is decided solely by the `StartupGate` outcome;
any losing late result is discarded by generation.

- [ ] **Step 4: Verify GREEN under repetition**

Run: `cargo test --locked service::tests -- --nocapture`

Then run the race-sensitive cases 25 times:

```sh
for i in $(seq 1 25); do cargo test --locked service::tests::late_completion --quiet || exit 1; done
```

Expected: all iterations pass without hangs.

- [ ] **Step 5: Commit**

```sh
git add src/service.rs src/lib.rs
git commit -m "feat: add cancellable Arti service state machine"
```

### Task 6: Connect the service worker to real Arti and loopback SOCKS

**Files:**

- Modify: `src/service.rs`
- Modify: `src/lib.rs`

- [ ] **Step 1: Write failing integration-with-fake-bootstrap tests**

Test the production worker through the `WorkerFactory` boundary with injected
`bootstrap` and `bind_and_serve` closures; the fake seam returns a controlled
port/service handle and never constructs `TorClient`. Assert the worker reports
the loopback port, remains alive until stop, closes the accept loop, aborts and
joins every active connection task, and only then returns terminal success.

- [ ] **Step 2: Verify RED**

Run: `cargo test --locked service::tests::worker -- --nocapture`

Expected: FAIL because production worker wiring is absent.

- [ ] **Step 3: Implement production worker**

Create a Tokio runtime inside the native worker thread. During bootstrap, use
`tokio::select!` between Arti bootstrap and the one-shot cancellation receiver.
After reporting `Running`, the startup deadline no longer exists; the worker
selects only between the running SOCKS service and cancellation. The supervisor
maps its gate timeout to `ERR_ARTI_TIMEOUT`; the worker maps bootstrap, bind,
cancellation, and shutdown to stable codes.

Replace the detached per-connection spawns in `serve_socks()` with a
`SocksService` that owns its accept task and a Tokio `JoinSet` for all connection
tasks. `SocksService::shutdown()` stops acceptance, aborts remaining connections,
drains the `JoinSet`, and returns only after all tasks terminate. Keep
`bootstrap_in()` reusable.

- [ ] **Step 4: Verify GREEN and full Rust suite**

Run: `cargo test --locked --all-targets`

Expected: all state and core tests pass without Tor network access.

- [ ] **Step 5: Commit**

```sh
git add src/service.rs src/lib.rs
git commit -m "feat: run embedded Arti on a native worker"
```

### Task 7: Replace the bare-rust scaffold with a tested C ABI

**Files:**

- Create: `addon/src/lib.rs`
- Modify: `addon/Cargo.toml`
- Modify: `addon/Cargo.lock`
- Delete: `src/binding.rs`

- [ ] **Step 1: Write ABI unit tests around copied options and callback completion**

First point `addon/Cargo.toml` at `src/lib.rs` and add a compilable C-ABI scaffold
whose start/stop functions return an intentional unsupported status. In
`addon/src/lib.rs`, add tests that call the Rust functions through their
C-compatible structs and assert synchronous validation status, one callback per
accepted operation, copied data-directory lifetime, generation preservation,
stable codes, and duplicate-start rejection. Put pointer validation and copying
in a private `copy_options()` helper used by `bare_arti_start()`. Unit-test the
helper directly: mutate/drop caller-owned option buffers immediately after the
copy and assert the owned `ServiceOptions.data_dir` remains unchanged.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path addon/Cargo.toml --locked -- --nocapture`

Expected: tests compile and FAIL because the scaffold returns unsupported and
does not invoke the expected callback.

- [ ] **Step 3: Implement the narrow ABI**

Export `bare_arti_start` and `bare_arti_stop` using `#[no_mangle] extern "C"`. Convert C strings immediately, validate null pointers, call the root service singleton, and invoke callbacks from the worker completion path. Never expose a Bare JS value to Rust.
Wrap each exported body in `catch_unwind`; translate an unexpected panic to a
nonzero synchronous status or `ERR_ARTI_SHUTDOWN` callback so Rust never unwinds
across the C ABI.

- [ ] **Step 4: Remove bare-rust and verify both crates**

Run:

```sh
cargo test --locked --all-targets
cargo test --manifest-path addon/Cargo.toml --locked
cargo tree --manifest-path addon/Cargo.toml --locked | rg bare-rust
```

Expected: both test commands pass; the `cargo tree | rg bare-rust` command exits
1 with no output, proving `bare-rust` is absent.

- [ ] **Step 5: Commit**

```sh
git add addon src/binding.rs
git commit -m "feat: expose asynchronous Arti service C ABI"
```

---

## Chunk 3: Bare Promise Bridge and Host Runtime Proof

### Task 8: Implement the Bare promise/thread-safe-function bridge

**Files:**

- Modify: `binding.c`
- Modify: `CMakeLists.txt`
- Modify: `src/service.rs`
- Modify: `addon/src/lib.rs`
- Modify: `addon/Cargo.toml`
- Create: `test/addon.js`
- Modify: `package.json`
- Modify: `.gitignore`
- Add: `package-lock.json`

- [ ] **Step 1: Add a minimal compiling C scaffold after the Rust-export deletion**

Chunk 2 removes `bare_arti_exports`, so first replace the stale declaration in
`binding.c` with a minimal `BARE_MODULE` export containing raw `start` and `stop`
functions. In test builds, raw `start` blocks for two seconds and returns a
plain number; in normal builds it throws `ERR_ARTI_BOOTSTRAP` with "not
implemented". This scaffold exists only to make the addon link so behavioral
tests can fail for the intended synchronous/non-promise behavior.

Add a CMake option and compile definition:

```cmake
option(BARE_ARTI_TESTING "Enable deterministic addon test hooks" OFF)
if(BARE_ARTI_TESTING)
  target_compile_definitions(${bare_arti_module} PRIVATE BARE_ARTI_TESTING=1)
endif()
```

- [ ] **Step 2: Add the complete failing raw-addon and heartbeat suite**

`test/addon.js` loads `binding.js` directly. The exact raw contract is:

```js
binding.start({ dataDir, timeout }, generation) // Promise<{ port }>
binding.stop(generation) // Promise<void>
```

The raw binding never adds `backend`; `lib/addon-controller.js` does that. Add
failing tests for:

- promise-like result returned immediately with raw `{ port }` resolution;
- a one-second warm-up followed by 50 ms heartbeats during a two-second delayed
  startup, requiring at least 30 ticks and no gap above 250 ms;
- distinct start and stop promises during stop-while-starting;
- direct duplicate raw stop is rejected as API misuse; identical stop-promise
  deduplication remains exclusively in `lib/addon-controller.js`;
- duplicate native completion settles once and frees one context;
- stop/restart with increasing generations;
- two serial realm-ownership cycles using `bare-worker`, while the main realm
  remains unloaded: worker A owns during startup and worker B verifies conflict,
  then A terminates and teardown is awaited; worker C owns through `Running` and
  worker D verifies conflict, then C terminates and teardown is awaited. Only
  after both cycles does the main realm first load the addon and claim ownership;
- late callback after an aborted thread-safe function touches no JS value;
- diagnostic counters show every allocated start/stop context freed exactly
  once.

Add `bare-worker` as a dev dependency, remove `package-lock.json` from
`.gitignore`, and commit the resulting lockfile. Test-only diagnostics and
duplicate/delay hooks are exported only when `BARE_ARTI_TESTING` is defined.
Add `addon/src/**/*.rs` to `package.json.files`; the tarball test must require
`addon/src/lib.rs` so consumers receive the complete native rebuild source.

- [ ] **Step 3: Verify RED against the compiling scaffold**

Run:

```sh
npx bare-make generate --build build-host-test --debug --define=BARE_ARTI_TESTING=ON
npx bare-make build --build build-host-test
npx bare-make install --build build-host-test --prefix .
npx bare test/addon.js
```

Expected: addon links and loads, then FAILS because raw `start()` returns a
number, the two-second call blocks the heartbeat, and lifecycle diagnostics are
missing.

- [ ] **Step 4: Wire deterministic debug-only Rust test hooks**

Under `#[cfg(debug_assertions)]`, `addon/src/lib.rs` exports test start modes that
use the public injected `WorkerFactory`: delayed async readiness, duplicate
completion, and delayed completion after cancellation. `binding.c` selects them
only under `BARE_ARTI_TESTING`. Release builds do not contain or link those
symbols. The CMake test option is valid only with `--debug`; configuration fails
if it is enabled for Release.

- [ ] **Step 5: Implement generation-scoped start/stop request contexts**

Create one process-global realm-owner struct containing the owning `js_env_t`,
current generation, a deferred teardown handle that remains registered across
normal stop/restart cycles, and separate generation-scoped start and stop request
contexts. Each request owns its own `js_deferred_t`,
`js_threadsafe_function_t`, atomic completed/aborted flags, and copied native
result. Raw `start(options, generation)` validates arguments, creates its promise,
queues Rust start, and returns immediately. The thread-safe callback creates
`{ port }` or an Error with `code` and settles exactly once.

- [ ] **Step 6: Implement stop and realm teardown ownership**

Raw `stop(generation)` creates a separate stop request promise and waits
for Rust terminal completion. A second raw stop for the active generation is
rejected synchronously as misuse; the JS controller is responsible for sharing
its public stop promise. Normal stop never finishes/unregisters the realm
teardown handle. Actual realm teardown marks all active request contexts aborted,
aborts their thread-safe functions, requests native cancellation, and retains
contexts until native callbacks release them without JS access; only then does
it call `js_finish_deferred_teardown_callback`. A second realm receives
`ERR_ARTI_REALM_CONFLICT`.

- [ ] **Step 7: Verify GREEN and ownership diagnostics**

Run the debug host build/load command above. Expected: all raw contract,
heartbeat, realm, cancellation, duplicate, restart, and exact-free assertions
pass.

- [ ] **Step 8: Run ASan when supported, with an explicit result**

First verify the host compiler and Bare runtime support the sanitizer. If the
sanitized generator/configuration fails, record `ASAN_UNAVAILABLE` with the
command error and do not claim sanitizer coverage. If supported, run:

```sh
npx bare-make generate --build build-host-asan --debug --sanitize address --define=BARE_ARTI_TESTING=ON
npx bare-make build --build build-host-asan
npx bare-make install --build build-host-asan --prefix .
npx bare test/addon.js
```

Expected when supported: tests pass with no ASan error or leaked active teardown
handle.

- [ ] **Step 9: Commit**

```sh
git add .gitignore package-lock.json binding.c CMakeLists.txt src/service.rs addon/src/lib.rs addon/Cargo.toml test/addon.js package.json
git commit -m "feat: settle Arti addon startup asynchronously"
```

---

## Chunk 4: Complete Mobile Builds and Artifact Gates

### Task 10: Add exact mobile artifact verification

**Files:**

- Create: `scripts/verify-mobile-prebuild.js`
- Create: `scripts/locked-bin/cargo`
- Create: `test/mobile-artifacts.js`
- Create: `test/cargo-wrapper.js`
- Modify: `test/all.js`

- [ ] **Step 1: Write failing artifact-layout tests**

Import `verifyMobilePrebuilds(artifactRoot)` from
`scripts/verify-mobile-prebuild.js`. Its argument is always the artifact root,
not the `prebuilds` child. Given a fixture artifact root, assert the accepted
module files are:

```text
prebuilds/android-arm64/bare-arti.bare
prebuilds/ios-arm64/bare-arti.bare
prebuilds/ios-arm64-simulator/bare-arti.bare
```

and the accepted manifest files are exactly:

```text
manifests/android-arm64.json
manifests/ios-arm64.json
manifests/ios-arm64-simulator.json
```

Reject missing, extra, incorrectly named, checksum-mismatched, or over-30-MiB
compressed artifacts. Compressed size is defined as the byte length of Node
`zlib.gzipSync(file, { level: 9, mtime: 0 })`; fixtures and CI call this exact
shared implementation.

Add `test/cargo-wrapper.js` with a fake executable named by
`BARE_ARTI_REAL_CARGO`. Assert the checked-in wrapper appends `--locked` to
`build` and `metadata`, rewrites cmake-cargo 0.0.4's invalid Android target
`aarch64-unknown-android` to `aarch64-linux-android`, and passes unrelated Cargo
subcommands through. Assert the wrapper has executable mode.

- [ ] **Step 2: Verify RED**

Run: `node test/mobile-artifacts.js`

Expected: FAIL because `scripts/verify-mobile-prebuild.js` is missing.

Run: `node test/cargo-wrapper.js`

Expected: FAIL because `scripts/locked-bin/cargo` is missing.

- [ ] **Step 3: Implement verifier**

Implement the module plus CLI entrypoint. It recursively compares both exact
allowlists, computes SHA-256, verifies per-platform JSON manifest entries,
and enforces deterministic gzip size. Native architecture checks remain in each
native build job, where `lipo` or NDK `llvm-readelf` is available.

Implement `scripts/locked-bin/cargo` as a POSIX wrapper. It requires
`BARE_ARTI_REAL_CARGO`, shifts the subcommand, rewrites only
`--target aarch64-unknown-android` to `--target aarch64-linux-android`, and
appends `--locked` to `build` and `metadata` before `exec`. CI prepends
`scripts/locked-bin` to `PATH` and sets
`CMAKE_PROGRAM_PATH=$PWD/scripts/locked-bin` so `cmake-cargo` discovers the
wrapper rather than the real Cargo executable.

- [ ] **Step 4: Verify GREEN**

Run: `npm test`

Expected: fixture tests pass without requiring built mobile artifacts.

- [ ] **Step 5: Commit**

```sh
git add scripts/verify-mobile-prebuild.js scripts/locked-bin/cargo test/mobile-artifacts.js test/cargo-wrapper.js test/all.js
git commit -m "test: verify mobile addon artifact layout"
```

### Task 11: Build Android arm64 and iOS arm64 addons in GitHub Actions

**Files:**

- Create: `.github/workflows/mobile.yml`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add the workflow with least privilege and pinned Actions**

Add exact `bare-make: 1.6.3` to dev dependencies and commit the updated lockfile.
The workflow triggers on PRs to `main`, pushes to `main` and `feature/**`, plus
manual dispatch. Create jobs:

- `test` on `ubuntu-24.04`, running `npm ci`, `npm test`,
  `cargo test --locked --all-targets`, and
  `cargo test --manifest-path addon/Cargo.toml --locked`;
- Android on `ubuntu-24.04`: install NDK `27.2.12479018` with `sdkmanager`, set
  `ANDROID_NDK_ROOT=$ANDROID_SDK_ROOT/ndk/27.2.12479018`, install Rust 1.96.1
  with the existing SHA-pinned `dtolnay/rust-toolchain` Action, and run
  `rustup target add aarch64-linux-android --toolchain 1.96.1`.
- iOS device on `macos-15`: select
  `/Applications/Xcode_16.4.app/Contents/Developer`, assert `Xcode 16.4`, install
  Rust 1.96.1, and add `aarch64-apple-ios`.
- iOS Simulator on `macos-15`: select/assert Xcode 16.4, install Rust 1.96.1,
  and add `aarch64-apple-ios-sim`.
- Ubuntu assembly job downloading three already architecture-verified modules
  and their JSON SHA-256 manifests, then running the JS
  layout/checksum/size verifier
  plus npm tarball inspection. Assembly does not call `lipo`.

Assembly explicitly `needs` the test, Android, iOS device, and iOS Simulator
jobs. Artifact download merges paths while preserving their common
`prebuilds/` and `manifests/` roots.

Android runs:

```sh
npx --no-install bare-make generate --build build-android-arm64 --platform android --arch arm64 --define CMAKE_PROGRAM_PATH:PATH=$GITHUB_WORKSPACE/scripts/locked-bin
npx --no-install bare-make build --build build-android-arm64
npx --no-install bare-make install --build build-android-arm64 --prefix . --strip
```

iOS device runs:

```sh
npx --no-install bare-make generate --build build-ios-arm64 --platform ios --arch arm64 --define CMAKE_PROGRAM_PATH:PATH=$GITHUB_WORKSPACE/scripts/locked-bin
npx --no-install bare-make build --build build-ios-arm64
npx --no-install bare-make install --build build-ios-arm64 --prefix . --strip
```

iOS Simulator runs:

```sh
npx --no-install bare-make generate --build build-ios-arm64-simulator --platform ios --arch arm64 --simulator --define CMAKE_PROGRAM_PATH:PATH=$GITHUB_WORKSPACE/scripts/locked-bin
npx --no-install bare-make build --build build-ios-arm64-simulator
npx --no-install bare-make install --build build-ios-arm64-simulator --prefix . --strip
```

It then asserts exactly one installed module at its expected path. Android runs
`$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf -h`
and requires `AArch64`; each iOS job runs `file` and `lipo -info` and requires
only `arm64`. Each job writes a one-entry SHA-256 manifest at
`manifests/<target>.json`, outside `prebuilds/`, before upload.

Before `bare-make generate`, every native job captures the real Cargo path in
`BARE_ARTI_REAL_CARGO`, prepends `$GITHUB_WORKSPACE/scripts/locked-bin` to
`PATH`, and passes
`-D CMAKE_PROGRAM_PATH=$GITHUB_WORKSPACE/scripts/locked-bin`. This forces
`cmake-cargo` build and metadata invocations through the checked-in `--locked`
wrapper. After building, each job asserts both root and addon lockfiles are
byte-identical to their checked-out SHA-256 values.
Each job also asserts `test -x scripts/locked-bin/cargo` before generation.

Every job uses `npm ci`, locked Cargo inputs, SHA-pinned checkout/setup-node/
artifact Actions, `contents: read`, and uploads only its expected `.bare` module
and checksum manifest.

- [ ] **Step 2: Parse and inspect workflow locally**

Run:

```sh
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/mobile.yml')"
git diff --check
```

Expected: exit 0.

- [ ] **Step 3: Document the honest support boundary**

README must say these jobs prove complete cross-compilation only. Android/iOS
remain experimental until BareKit emulator/simulator and physical-device privacy
proofs from the follow-up plan are green.

Assembly runs `npm pack --json`, requires all three mobile modules and
`addon/src/lib.rs`, and rejects unexpected prebuild/build/target files. This
mobile-only tarball is an inspection artifact, not publishable: the future
release workflow must combine these modules with all verified desktop sidecars.

- [ ] **Step 4: Commit and push the feature branch**

```sh
git add .github/workflows/mobile.yml README.md package.json package-lock.json
git commit -m "ci: build complete Android and iOS addons"
git push -u origin feature/mobile-tor-addon
```

- [ ] **Step 5: Watch exact-head CI and inspect artifacts**

Record `sha=$(git rev-parse HEAD)`. Use `gh run list --workflow mobile.yml
--branch feature/mobile-tor-addon --json databaseId,headSha,status,conclusion,url`
and select the entry whose `headSha` exactly equals `$sha`; fail if there is not
exactly one. Run `gh run watch <run-id> --exit-status`, then
`gh run download <run-id> --name mobile-addons-assembly --dir
/private/tmp/bare-arti-mobile-assembly` and run
`node scripts/verify-mobile-prebuild.js
/private/tmp/bare-arti-mobile-assembly`. Expected: JS/Rust tests and all
three mobile build jobs green; downloaded checksums/layout/size pass; no
runtime-support claim yet.

---

## Final Verification for This Plan

- [ ] Run `npm test` and record test/assertion counts.
- [ ] Run `cargo test --locked --all-targets`.
- [ ] Run `cargo test --manifest-path addon/Cargo.toml --locked`.
- [ ] Build/load the host addon and run `npx bare test/addon.js`.
- [ ] Run `git diff --check` and confirm the worktree is clean.
- [ ] Confirm exact-head GitHub `Test`, `Prebuild sidecars`, and `Mobile addons` workflows are green.
- [ ] Confirm mobile README language remains experimental/build-only.
- [ ] Hand off to a second plan for BareKit Android/iOS runtime loading, process-scoped socket audit, real onion/Hyperswarm proofs on both simulated runtimes, and physical-device release gates.
