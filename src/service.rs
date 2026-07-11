use std::fmt;
use std::future::Future;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tokio::sync::oneshot;

pub type Completion = Box<dyn FnOnce(ServiceEvent) + Send + 'static>;
type WorkerResult = Result<(), ServiceError>;
type WorkerHandle = JoinHandle<WorkerResult>;
type WorkerSlot = Arc<Mutex<Option<WorkerHandle>>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceOptions {
    pub data_dir: PathBuf,
    pub timeout: Duration,
    pub generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServiceEvent {
    Running {
        generation: u64,
        port: u16,
    },
    Failed {
        generation: u64,
        code: &'static str,
        message: String,
    },
    Stopped {
        generation: u64,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceError {
    pub code: &'static str,
    pub message: String,
}

impl ServiceError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ServiceError {}

pub trait WorkerFactory: Send + Sync {
    fn spawn(
        &self,
        options: ServiceOptions,
        cancel: oneshot::Receiver<()>,
        ready: mpsc::SyncSender<Result<u16, ServiceError>>,
    ) -> Result<WorkerHandle, ServiceError>;
}

pub type ServiceFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait ManagedSocksService: Send {
    fn port(&self) -> u16;
    fn wait(&mut self) -> ServiceFuture<'_, Result<(), ServiceError>>;
    fn shutdown(self: Box<Self>) -> ServiceFuture<'static, Result<(), ServiceError>>;
}

type BootstrapHook<C> =
    dyn Fn(PathBuf) -> ServiceFuture<'static, Result<C, ServiceError>> + Send + Sync;
type BindAndServeHook<C> = dyn Fn(C) -> ServiceFuture<'static, Result<Box<dyn ManagedSocksService>, ServiceError>>
    + Send
    + Sync;

pub struct ProductionWorkerFactory<C> {
    bootstrap: Arc<BootstrapHook<C>>,
    bind_and_serve: Arc<BindAndServeHook<C>>,
}

impl<C> ProductionWorkerFactory<C>
where
    C: Send + 'static,
{
    pub fn with_hooks<B, S>(bootstrap: B, bind_and_serve: S) -> Self
    where
        B: Fn(PathBuf) -> ServiceFuture<'static, Result<C, ServiceError>> + Send + Sync + 'static,
        S: Fn(C) -> ServiceFuture<'static, Result<Box<dyn ManagedSocksService>, ServiceError>>
            + Send
            + Sync
            + 'static,
    {
        Self {
            bootstrap: Arc::new(bootstrap),
            bind_and_serve: Arc::new(bind_and_serve),
        }
    }
}

impl ManagedSocksService for crate::SocksService {
    fn port(&self) -> u16 {
        self.port()
    }

    fn wait(&mut self) -> ServiceFuture<'_, Result<(), ServiceError>> {
        Box::pin(async move {
            self.wait().await.map_err(|error| {
                ServiceError::new(
                    "ERR_ARTI_SHUTDOWN",
                    format!("SOCKS service failed: {error}"),
                )
            })
        })
    }

    fn shutdown(self: Box<Self>) -> ServiceFuture<'static, Result<(), ServiceError>> {
        Box::pin(async move {
            (*self).shutdown().await.map_err(|error| {
                ServiceError::new(
                    "ERR_ARTI_SHUTDOWN",
                    format!("could not stop SOCKS service: {error}"),
                )
            })
        })
    }
}

pub fn production_worker_factory() -> Arc<dyn WorkerFactory> {
    Arc::new(ProductionWorkerFactory::with_hooks(
        |data_dir: PathBuf| {
            Box::pin(async move {
                let data_dir = data_dir.to_str().ok_or_else(|| {
                    ServiceError::new("ERR_ARTI_CONFIG", "dataDir must contain valid UTF-8")
                })?;
                crate::bootstrap_in(data_dir)
                    .await
                    .map_err(|error| ServiceError::new("ERR_ARTI_BOOTSTRAP", error.to_string()))
            })
        },
        |client| {
            Box::pin(async move {
                let (_port, service) = crate::serve_socks(client, "127.0.0.1")
                    .await
                    .map_err(|error| ServiceError::new("ERR_ARTI_BIND", error.to_string()))?;
                Ok(Box::new(service) as Box<dyn ManagedSocksService>)
            })
        },
    ))
}

impl<C> WorkerFactory for ProductionWorkerFactory<C>
where
    C: Send + 'static,
{
    fn spawn(
        &self,
        options: ServiceOptions,
        cancel: oneshot::Receiver<()>,
        ready: mpsc::SyncSender<Result<u16, ServiceError>>,
    ) -> Result<WorkerHandle, ServiceError> {
        let bootstrap = self.bootstrap.clone();
        let bind_and_serve = self.bind_and_serve.clone();
        thread::Builder::new()
            .name("bare-arti-native-worker".into())
            .spawn(move || run_production_worker(options, cancel, ready, bootstrap, bind_and_serve))
            .map_err(|error| {
                ServiceError::new(
                    "ERR_ARTI_BOOTSTRAP",
                    format!("could not create native Arti worker: {error}"),
                )
            })
    }
}

fn run_production_worker<C>(
    options: ServiceOptions,
    mut cancel: oneshot::Receiver<()>,
    ready: mpsc::SyncSender<Result<u16, ServiceError>>,
    bootstrap: Arc<BootstrapHook<C>>,
    bind_and_serve: Arc<BindAndServeHook<C>>,
) -> WorkerResult
where
    C: Send + 'static,
{
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            ServiceError::new(
                "ERR_ARTI_BOOTSTRAP",
                format!("could not create Tokio runtime: {error}"),
            )
        })?;

    runtime.block_on(async move {
        let data_dir = match prepare_data_dir(&options.data_dir) {
            Ok(data_dir) => data_dir,
            Err(error) => {
                let _ = ready.send(Err(error.clone()));
                return Err(error);
            }
        };
        let client = tokio::select! {
            biased;
            _ = &mut cancel => {
                let error = cancelled_error();
                let _ = ready.send(Err(error.clone()));
                return Err(error);
            }
            result = bootstrap(data_dir) => match result {
                Ok(client) => client,
                Err(error) => {
                    let error = normalize_worker_error("ERR_ARTI_BOOTSTRAP", "Arti bootstrap failed", error);
                    let _ = ready.send(Err(error.clone()));
                    return Err(error);
                }
            }
        };
        let mut service = tokio::select! {
            biased;
            _ = &mut cancel => {
                let error = cancelled_error();
                let _ = ready.send(Err(error.clone()));
                return Err(error);
            }
            result = bind_and_serve(client) => match result {
                Ok(service) => service,
                Err(error) => {
                    let error = normalize_worker_error("ERR_ARTI_BIND", "could not bind loopback SOCKS service", error);
                    let _ = ready.send(Err(error.clone()));
                    return Err(error);
                }
            }
        };
        let port = service.port();
        if port == 0 {
            let error = ServiceError::new("ERR_ARTI_BIND", "SOCKS service returned an invalid port");
            let _ = ready.send(Err(error.clone()));
            let _ = service.shutdown().await;
            return Err(error);
        }
        if ready.send(Ok(port)).is_err() {
            return service.shutdown().await;
        }

        tokio::select! {
            biased;
            _ = &mut cancel => service.shutdown().await,
            result = service.wait() => {
                let result = result.map_err(|error| {
                    normalize_worker_error("ERR_ARTI_SHUTDOWN", "SOCKS service failed", error)
                });
                let shutdown = service.shutdown().await;
                match (result, shutdown) {
                    (Err(error), _) => Err(error),
                    (Ok(()), Err(error)) => Err(error),
                    (Ok(()), Ok(())) => Err(ServiceError::new(
                        "ERR_ARTI_SHUTDOWN",
                        "SOCKS service exited unexpectedly",
                    )),
                }
            }
        }
    })
}

fn normalize_worker_error(
    code: &'static str,
    context: &'static str,
    error: ServiceError,
) -> ServiceError {
    if error.code == code {
        error
    } else {
        ServiceError::new(
            code,
            format!("{context}: {}: {}", error.code, error.message),
        )
    }
}

fn prepare_data_dir(data_dir: &std::path::Path) -> Result<PathBuf, ServiceError> {
    if !data_dir.is_absolute() {
        return Err(ServiceError::new(
            "ERR_ARTI_CONFIG",
            "dataDir must be an absolute path",
        ));
    }
    let existed = data_dir.exists();
    std::fs::create_dir_all(data_dir).map_err(|error| {
        ServiceError::new(
            "ERR_ARTI_CONFIG",
            format!("could not create dataDir: {error}"),
        )
    })?;
    if !existed {
        set_owner_only_permissions(data_dir)?;
    }
    let first = std::fs::symlink_metadata(data_dir).map_err(config_fs_error)?;
    if first.file_type().is_symlink() || !first.is_dir() {
        return Err(ServiceError::new(
            "ERR_ARTI_CONFIG",
            "dataDir must be a directory and not a symbolic link",
        ));
    }
    ensure_owner_only_permissions(&first)?;
    let canonical = std::fs::canonicalize(data_dir).map_err(config_fs_error)?;
    let canonical_metadata = std::fs::metadata(&canonical).map_err(config_fs_error)?;
    let final_metadata = std::fs::symlink_metadata(data_dir).map_err(config_fs_error)?;
    if final_metadata.file_type().is_symlink()
        || !same_file(&first, &canonical_metadata)
        || !same_file(&canonical_metadata, &final_metadata)
    {
        return Err(ServiceError::new(
            "ERR_ARTI_CONFIG",
            "dataDir changed during native validation",
        ));
    }
    Ok(canonical)
}

fn config_fs_error(error: std::io::Error) -> ServiceError {
    ServiceError::new(
        "ERR_ARTI_CONFIG",
        format!("could not validate dataDir: {error}"),
    )
}

#[cfg(unix)]
fn set_owner_only_permissions(data_dir: &std::path::Path) -> Result<(), ServiceError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(data_dir, std::fs::Permissions::from_mode(0o700))
        .map_err(config_fs_error)
}

#[cfg(not(unix))]
fn set_owner_only_permissions(_data_dir: &std::path::Path) -> Result<(), ServiceError> {
    Ok(())
}

#[cfg(unix)]
fn ensure_owner_only_permissions(metadata: &std::fs::Metadata) -> Result<(), ServiceError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(ServiceError::new(
            "ERR_ARTI_CONFIG",
            "dataDir must not be accessible by group or other users",
        ));
    }
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    // SAFETY: geteuid takes no arguments, has no side effects, and is provided
    // by every Unix target supported by this crate (including Android/iOS).
    if metadata.uid() != unsafe { geteuid() } {
        return Err(ServiceError::new(
            "ERR_ARTI_CONFIG",
            "dataDir must be owned by the current user",
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_owner_only_permissions(_metadata: &std::fs::Metadata) -> Result<(), ServiceError> {
    Ok(())
}

#[cfg(unix)]
fn same_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file(_left: &std::fs::Metadata, _right: &std::fs::Metadata) -> bool {
    true
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StartupOutcome {
    Ready(Result<u16, ServiceError>),
    Timeout,
    WorkerExited,
}

pub trait StartupGate: Send + Sync {
    fn wait(
        &self,
        ready: mpsc::Receiver<Result<u16, ServiceError>>,
        duration: Duration,
    ) -> StartupOutcome;
}

pub struct ProductionStartupGate;

impl StartupGate for ProductionStartupGate {
    fn wait(
        &self,
        ready: mpsc::Receiver<Result<u16, ServiceError>>,
        duration: Duration,
    ) -> StartupOutcome {
        match ready.recv_timeout(duration) {
            Ok(result) => StartupOutcome::Ready(result),
            Err(mpsc::RecvTimeoutError::Timeout) => StartupOutcome::Timeout,
            Err(mpsc::RecvTimeoutError::Disconnected) => StartupOutcome::WorkerExited,
        }
    }
}

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

struct LifecycleState {
    stop_requested: bool,
    worker_result: Option<WorkerResult>,
}

struct WorkerLifecycle {
    state: Mutex<LifecycleState>,
    changed: Condvar,
}

enum RunningOutcome {
    StopRequested,
    WorkerExited(WorkerResult),
}

impl WorkerLifecycle {
    fn new() -> Self {
        Self {
            state: Mutex::new(LifecycleState {
                stop_requested: false,
                worker_result: None,
            }),
            changed: Condvar::new(),
        }
    }

    fn request_stop(&self) {
        let mut state = lock_lifecycle(&self.state);
        state.stop_requested = true;
        self.changed.notify_all();
    }

    fn worker_exited(&self, result: WorkerResult) {
        let mut state = lock_lifecycle(&self.state);
        state.worker_result = Some(result);
        self.changed.notify_all();
    }

    fn wait_running(&self) -> RunningOutcome {
        let mut state = lock_lifecycle(&self.state);
        loop {
            if let Some(result) = state.worker_result.take() {
                return RunningOutcome::WorkerExited(result);
            }
            if state.stop_requested {
                return RunningOutcome::StopRequested;
            }
            state = match self.changed.wait(state) {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
    }

    fn wait_stopping(&self, duration: Duration) -> WorkerResult {
        let mut state = lock_lifecycle(&self.state);
        if let Some(result) = state.worker_result.take() {
            return result;
        }
        let waited = self
            .changed
            .wait_timeout_while(state, duration, |state| state.worker_result.is_none());
        state = match waited {
            Ok((state, _)) => state,
            Err(poisoned) => poisoned.into_inner().0,
        };
        state.worker_result.take().unwrap_or_else(|| {
            Err(ServiceError::new(
                "ERR_ARTI_SHUTDOWN",
                format!(
                    "Arti worker did not exit within {} milliseconds",
                    duration.as_millis()
                ),
            ))
        })
    }
}

#[derive(Clone)]
pub struct WorkerOwner {
    worker: WorkerSlot,
}

impl WorkerOwner {
    fn new() -> Self {
        Self {
            worker: Arc::new(Mutex::new(None)),
        }
    }

    fn store(&self, worker: WorkerHandle) -> Result<(), (ServiceError, WorkerHandle)> {
        let mut slot = lock_worker_slot(&self.worker);
        if slot.is_some() {
            return Err((
                ServiceError::new(
                    "ERR_ARTI_SHUTDOWN",
                    "worker owner already contains a worker",
                ),
                worker,
            ));
        }
        *slot = Some(worker);
        Ok(())
    }

    fn take(&self) -> Option<WorkerHandle> {
        lock_worker_slot(&self.worker).take()
    }

    pub fn has_worker(&self) -> bool {
        lock_worker_slot(&self.worker).is_some()
    }
}

type ReaperTask = Box<dyn FnOnce() + Send + 'static>;

struct ReaperSpawnError {
    pub error: ServiceError,
    pub task: ReaperTask,
}

trait WorkerReaper: Send + Sync {
    fn spawn(&self, task: ReaperTask) -> Result<(), ReaperSpawnError>;
}

struct ProductionWorkerReaper;

impl WorkerReaper for ProductionWorkerReaper {
    fn spawn(&self, task: ReaperTask) -> Result<(), ReaperSpawnError> {
        let slot = Arc::new(Mutex::new(Some(task)));
        let thread_slot = slot.clone();
        match thread::Builder::new()
            .name("bare-arti-worker-reaper".into())
            .spawn(move || {
                let task = match thread_slot.lock() {
                    Ok(mut task) => task.take(),
                    Err(poisoned) => poisoned.into_inner().take(),
                };
                if let Some(task) = task {
                    task();
                }
            }) {
            Ok(_) => Ok(()),
            Err(error) => Err(ReaperSpawnError {
                error: ServiceError::new(
                    "ERR_ARTI_SHUTDOWN",
                    format!("could not create worker reaper: {error}"),
                ),
                task: match slot.lock() {
                    Ok(mut task) => task.take(),
                    Err(poisoned) => poisoned.into_inner().take(),
                }
                .expect("reaper task remains owned when thread creation fails"),
            }),
        }
    }
}

pub type SupervisorTask = Box<dyn FnOnce() + Send + 'static>;

pub struct SupervisorSpawnError {
    pub error: ServiceError,
    pub task: SupervisorTask,
}

pub trait SupervisorSpawner: Send + Sync {
    fn spawn(&self, task: SupervisorTask) -> Result<(), SupervisorSpawnError>;
}

pub struct ProductionSupervisorSpawner;

impl SupervisorSpawner for ProductionSupervisorSpawner {
    fn spawn(&self, task: SupervisorTask) -> Result<(), SupervisorSpawnError> {
        let slot = Arc::new(Mutex::new(Some(task)));
        let thread_slot = slot.clone();
        match thread::Builder::new()
            .name("bare-arti-service-supervisor".into())
            .spawn(move || {
                let task = thread_slot.lock().ok().and_then(|mut slot| slot.take());
                if let Some(task) = task {
                    task();
                }
            }) {
            Ok(_) => Ok(()),
            Err(error) => {
                let task = slot
                    .lock()
                    .ok()
                    .and_then(|mut slot| slot.take())
                    .expect("supervisor task remains owned when thread creation fails");
                Err(SupervisorSpawnError {
                    error: ServiceError::new("ERR_ARTI_SHUTDOWN", error.to_string()),
                    task,
                })
            }
        }
    }
}

struct CompletionItem {
    completion: Completion,
    event: ServiceEvent,
}

struct CompletionDispatcher {
    sender: mpsc::Sender<CompletionItem>,
}

impl CompletionDispatcher {
    fn new() -> Result<Self, ServiceError> {
        let (sender, receiver) = mpsc::channel::<CompletionItem>();
        thread::Builder::new()
            .name("bare-arti-completion-dispatcher".into())
            .spawn(move || {
                while let Ok(item) = receiver.recv() {
                    safe_completion(item.completion, item.event);
                }
            })
            .map_err(|error| {
                ServiceError::new(
                    "ERR_ARTI_SHUTDOWN",
                    format!("could not create completion dispatcher: {error}"),
                )
            })?;
        Ok(Self { sender })
    }

    fn send(&self, completion: Completion, event: ServiceEvent) -> Result<(), CompletionItem> {
        self.sender
            .send(CompletionItem { completion, event })
            .map_err(|error| error.0)
    }
}

type CancelSender = Arc<Mutex<Option<oneshot::Sender<()>>>>;

struct Active {
    options: ServiceOptions,
    cancel: CancelSender,
    lifecycle: Arc<WorkerLifecycle>,
    startup_waker: mpsc::SyncSender<Result<u16, ServiceError>>,
    start_completions: Vec<Completion>,
}

struct Running {
    options: ServiceOptions,
    cancel: CancelSender,
    lifecycle: Arc<WorkerLifecycle>,
    port: u16,
}

struct Stopping {
    generation: u64,
    was_running: bool,
    cancel: CancelSender,
    lifecycle: Arc<WorkerLifecycle>,
    start_completions: Vec<Completion>,
    stop_completions: Vec<Completion>,
    reason: ServiceError,
}

enum State {
    Stopped,
    Starting(Active),
    Running(Running),
    Stopping(Stopping),
    Failed(FailedState),
}

struct FailedState {
    error: ServiceError,
    _quarantine: Option<WorkerOwner>,
}

struct Inner {
    state: State,
    last_generation: u64,
}

struct Shared {
    inner: Mutex<Inner>,
    factory: Arc<dyn WorkerFactory>,
    gate: Arc<dyn StartupGate>,
    reaper: Arc<dyn WorkerReaper>,
    supervisor_spawner: Arc<dyn SupervisorSpawner>,
    shutdown_timeout: Duration,
    dispatcher: Option<CompletionDispatcher>,
}

#[derive(Clone)]
pub struct ServiceController {
    shared: Arc<Shared>,
}

impl ServiceController {
    pub fn new(factory: Arc<dyn WorkerFactory>, gate: Arc<dyn StartupGate>) -> Self {
        Self::with_dependencies(
            factory,
            gate,
            Arc::new(ProductionWorkerReaper),
            Arc::new(ProductionSupervisorSpawner),
            SHUTDOWN_TIMEOUT,
        )
    }

    fn with_dependencies(
        factory: Arc<dyn WorkerFactory>,
        gate: Arc<dyn StartupGate>,
        reaper: Arc<dyn WorkerReaper>,
        supervisor_spawner: Arc<dyn SupervisorSpawner>,
        shutdown_timeout: Duration,
    ) -> Self {
        let dispatcher = CompletionDispatcher::new();
        let state = match &dispatcher {
            Ok(_) => State::Stopped,
            Err(error) => State::Failed(FailedState {
                error: error.clone(),
                _quarantine: None,
            }),
        };
        Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(Inner {
                    state,
                    last_generation: 0,
                }),
                factory,
                gate,
                reaper,
                supervisor_spawner,
                shutdown_timeout,
                dispatcher: dispatcher.ok(),
            }),
        }
    }

    pub fn start(
        &self,
        options: ServiceOptions,
        completion: Completion,
    ) -> Result<(), ServiceError> {
        let mut completion = Some(completion);
        let mut running_event = None;
        let mut start_supervisor = None;

        {
            let mut inner = lock_inner(&self.shared)?;
            match &mut inner.state {
                State::Failed(failed) => return Err(failed.error.clone()),
                State::Stopping(_) => return Err(cancelled_error()),
                State::Starting(active) => {
                    if active.options != options {
                        return Err(conflict_error());
                    }
                    active.start_completions.push(completion.take().unwrap());
                }
                State::Running(active) => {
                    if active.options != options {
                        return Err(conflict_error());
                    }
                    running_event = Some(ServiceEvent::Running {
                        generation: options.generation,
                        port: active.port,
                    });
                }
                State::Stopped => {
                    if options.generation == 0
                        || options.generation == u64::MAX
                        || options.generation <= inner.last_generation
                    {
                        return Err(generation_error(inner.last_generation, options.generation));
                    }
                    inner.last_generation = options.generation;
                    let (cancel_tx, cancel_rx) = oneshot::channel();
                    let cancel = Arc::new(Mutex::new(Some(cancel_tx)));
                    let lifecycle = Arc::new(WorkerLifecycle::new());
                    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
                    inner.state = State::Starting(Active {
                        options: options.clone(),
                        cancel: cancel.clone(),
                        lifecycle: lifecycle.clone(),
                        startup_waker: ready_tx.clone(),
                        start_completions: vec![completion.take().unwrap()],
                    });
                    start_supervisor = Some((cancel, cancel_rx, lifecycle, ready_tx, ready_rx));
                }
            }
        }

        if let Some(event) = running_event {
            queue_completion(&self.shared, completion.take().unwrap(), event)?;
        }

        if let Some((cancel, cancel_rx, lifecycle, ready_tx, ready_rx)) = start_supervisor {
            let generation = options.generation;
            let shared = self.shared.clone();
            let task: SupervisorTask = Box::new(move || {
                run_supervisor(
                    shared, options, cancel, cancel_rx, lifecycle, ready_tx, ready_rx,
                )
            });
            match catch_unwind(AssertUnwindSafe(|| {
                self.shared.supervisor_spawner.spawn(task)
            })) {
                Ok(Ok(())) => {}
                Ok(Err(failure)) => {
                    cancel_current(&self.shared, generation);
                    drop(failure.task);
                    finish_creation_failure(&self.shared, generation, failure.error, true, None);
                }
                Err(_) => {
                    cancel_current(&self.shared, generation);
                    finish_creation_failure(
                        &self.shared,
                        generation,
                        ServiceError::new("ERR_ARTI_SHUTDOWN", "supervisor spawner panicked"),
                        true,
                        None,
                    );
                }
            }
        }

        Ok(())
    }

    pub fn stop(&self, generation: u64, completion: Completion) -> Result<(), ServiceError> {
        let mut completion = Some(completion);
        let mut cancel = None;
        let mut lifecycle = None;
        let mut startup_waker = None;
        let mut stale = false;

        {
            let mut inner = lock_inner(&self.shared)?;
            match &mut inner.state {
                State::Failed(failed) => return Err(failed.error.clone()),
                State::Stopped => {
                    if generation > inner.last_generation {
                        return Err(generation_error(inner.last_generation, generation));
                    }
                    stale = true;
                }
                State::Starting(active) => {
                    if generation < active.options.generation {
                        stale = true;
                    } else if generation > active.options.generation {
                        return Err(generation_error(inner.last_generation, generation));
                    } else {
                        let active = match std::mem::replace(&mut inner.state, State::Stopped) {
                            State::Starting(active) => active,
                            _ => unreachable!(),
                        };
                        cancel = Some(active.cancel.clone());
                        lifecycle = Some(active.lifecycle.clone());
                        startup_waker = Some(active.startup_waker.clone());
                        inner.state = State::Stopping(Stopping {
                            generation,
                            was_running: false,
                            cancel: active.cancel.clone(),
                            lifecycle: active.lifecycle,
                            start_completions: active.start_completions,
                            stop_completions: vec![completion.take().unwrap()],
                            reason: cancelled_error(),
                        });
                    }
                }
                State::Running(active) => {
                    if generation < active.options.generation {
                        stale = true;
                    } else if generation > active.options.generation {
                        return Err(generation_error(inner.last_generation, generation));
                    } else {
                        let active = match std::mem::replace(&mut inner.state, State::Stopped) {
                            State::Running(active) => active,
                            _ => unreachable!(),
                        };
                        cancel = Some(active.cancel.clone());
                        lifecycle = Some(active.lifecycle.clone());
                        inner.state = State::Stopping(Stopping {
                            generation,
                            was_running: true,
                            cancel: active.cancel.clone(),
                            lifecycle: active.lifecycle,
                            start_completions: Vec::new(),
                            stop_completions: vec![completion.take().unwrap()],
                            reason: cancelled_error(),
                        });
                    }
                }
                State::Stopping(active) => {
                    if generation < active.generation {
                        stale = true;
                    } else if generation > active.generation {
                        return Err(generation_error(inner.last_generation, generation));
                    } else {
                        active.stop_completions.push(completion.take().unwrap());
                    }
                }
            }
        }

        if let Some(cancel) = cancel {
            cancel_once(&cancel);
        }
        if let Some(lifecycle) = lifecycle {
            lifecycle.request_stop();
        }
        if let Some(startup_waker) = startup_waker {
            let _ = startup_waker.try_send(Err(cancelled_error()));
        }
        if stale {
            queue_completion(
                &self.shared,
                completion.take().unwrap(),
                ServiceEvent::Stopped { generation },
            )?;
        }
        Ok(())
    }
}

fn run_supervisor(
    shared: Arc<Shared>,
    options: ServiceOptions,
    cancel: CancelSender,
    cancel_rx: oneshot::Receiver<()>,
    lifecycle: Arc<WorkerLifecycle>,
    ready_tx: mpsc::SyncSender<Result<u16, ServiceError>>,
    ready_rx: mpsc::Receiver<Result<u16, ServiceError>>,
) {
    let generation = options.generation;
    let recovery_owner = Arc::new(Mutex::new(None::<WorkerOwner>));
    let recovery_slot = recovery_owner.clone();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let exit_waker = ready_tx.clone();
        let worker = match catch_unwind(AssertUnwindSafe(|| {
            shared.factory.spawn(options.clone(), cancel_rx, ready_tx)
        })) {
            Ok(Ok(worker)) => worker,
            Ok(Err(error)) => {
                finish_creation_failure(&shared, generation, error, false, None);
                return;
            }
            Err(_) => {
                finish_creation_failure(
                    &shared,
                    generation,
                    ServiceError::new("ERR_ARTI_BOOTSTRAP", "worker factory panicked"),
                    false,
                    None,
                );
                return;
            }
        };

        let owner = WorkerOwner::new();
        if let Err((error, worker)) = owner.store(worker) {
            let quarantine = WorkerOwner::new();
            let _ = quarantine.store(worker);
            cancel_once(&cancel);
            finish_creation_failure(&shared, generation, error, true, Some(quarantine));
            return;
        }
        *lock_worker_owner(&recovery_slot) = Some(owner.clone());
        let reaper_owner = owner.clone();
        let reaper_lifecycle = lifecycle.clone();
        let reaper_task: ReaperTask = Box::new(move || {
            let result = match reaper_owner.take() {
                Some(worker) => match worker.join() {
                    Ok(result) => result,
                    Err(_) => Err(ServiceError::new(
                        "ERR_ARTI_SHUTDOWN",
                        "Arti worker thread panicked",
                    )),
                },
                None => Err(ServiceError::new(
                    "ERR_ARTI_SHUTDOWN",
                    "worker owner was empty",
                )),
            };
            let startup_error = match &result {
                Ok(()) => {
                    ServiceError::new("ERR_ARTI_BOOTSTRAP", "Arti worker exited before readiness")
                }
                Err(error) => error.clone(),
            };
            reaper_lifecycle.worker_exited(result);
            let _ = exit_waker.try_send(Err(startup_error));
        });
        match catch_unwind(AssertUnwindSafe(|| shared.reaper.spawn(reaper_task))) {
            Ok(Ok(())) => {}
            Ok(Err(failure)) => {
                drop(failure.task);
                cancel_once(&cancel);
                finish_creation_failure(&shared, generation, failure.error, true, Some(owner));
                return;
            }
            Err(_) => {
                cancel_once(&cancel);
                finish_creation_failure(
                    &shared,
                    generation,
                    ServiceError::new("ERR_ARTI_SHUTDOWN", "worker reaper spawner panicked"),
                    true,
                    Some(owner),
                );
                return;
            }
        }
        supervise(
            shared.clone(),
            options,
            cancel.clone(),
            ready_rx,
            lifecycle.clone(),
        );
        *lock_worker_owner(&recovery_slot) = None;
    }));

    if result.is_err() {
        let error = ServiceError::new("ERR_ARTI_SHUTDOWN", "Arti supervisor panicked");
        cancel_once(&cancel);
        lifecycle.request_stop();
        let owner = lock_worker_owner(&recovery_owner).take();
        transition_to_stopping(&shared, generation, error);
        let result = lifecycle.wait_stopping(shared.shutdown_timeout);
        finish_worker(
            &shared,
            generation,
            ShutdownObservation {
                result,
                quarantine: owner.filter(WorkerOwner::has_worker),
            },
        );
    }
}

fn supervise(
    shared: Arc<Shared>,
    options: ServiceOptions,
    cancel: CancelSender,
    ready: mpsc::Receiver<Result<u16, ServiceError>>,
    lifecycle: Arc<WorkerLifecycle>,
) {
    let outcome = match catch_unwind(AssertUnwindSafe(|| {
        shared.gate.wait(ready, options.timeout)
    })) {
        Ok(outcome) => outcome,
        Err(_) => {
            stop_after_startup(
                &shared,
                options.generation,
                &cancel,
                &lifecycle,
                ServiceError::new("ERR_ARTI_SHUTDOWN", "Arti startup gate panicked"),
            );
            return;
        }
    };
    match outcome {
        StartupOutcome::Ready(Ok(port)) if port != 0 => {
            let completions = mark_running(&shared, &options, port);
            if let Some(completions) = completions {
                let event = ServiceEvent::Running {
                    generation: options.generation,
                    port,
                };
                for completion in completions {
                    let _ = queue_completion(&shared, completion, event.clone());
                }
            } else {
                cancel_once(&cancel);
                lifecycle.request_stop();
                let result = lifecycle.wait_stopping(shared.shutdown_timeout);
                finish_worker(
                    &shared,
                    options.generation,
                    ShutdownObservation {
                        result,
                        quarantine: None,
                    },
                );
                return;
            }
            let result = match lifecycle.wait_running() {
                RunningOutcome::WorkerExited(result) => result,
                RunningOutcome::StopRequested => lifecycle.wait_stopping(shared.shutdown_timeout),
            };
            finish_worker(
                &shared,
                options.generation,
                ShutdownObservation {
                    result,
                    quarantine: None,
                },
            );
        }
        StartupOutcome::Ready(Ok(_)) => {
            stop_after_startup(
                &shared,
                options.generation,
                &cancel,
                &lifecycle,
                ServiceError::new("ERR_ARTI_BIND", "worker returned an invalid SOCKS port"),
            );
        }
        StartupOutcome::Ready(Err(error)) => {
            stop_after_startup(&shared, options.generation, &cancel, &lifecycle, error);
        }
        StartupOutcome::Timeout => {
            stop_after_startup(
                &shared,
                options.generation,
                &cancel,
                &lifecycle,
                ServiceError::new("ERR_ARTI_TIMEOUT", "Arti bootstrap timed out"),
            );
        }
        StartupOutcome::WorkerExited => {
            stop_after_startup(
                &shared,
                options.generation,
                &cancel,
                &lifecycle,
                ServiceError::new("ERR_ARTI_BOOTSTRAP", "Arti worker exited before readiness"),
            );
        }
    }
}

fn mark_running(
    shared: &Arc<Shared>,
    options: &ServiceOptions,
    port: u16,
) -> Option<Vec<Completion>> {
    let mut inner = match lock_inner(shared) {
        Ok(inner) => inner,
        Err(_) => return None,
    };
    let active = match std::mem::replace(&mut inner.state, State::Stopped) {
        State::Starting(active) if active.options == *options => active,
        state => {
            inner.state = state;
            return None;
        }
    };
    let completions = active.start_completions;
    inner.state = State::Running(Running {
        options: active.options,
        cancel: active.cancel,
        lifecycle: active.lifecycle,
        port,
    });
    Some(completions)
}

fn stop_after_startup(
    shared: &Arc<Shared>,
    generation: u64,
    cancel: &CancelSender,
    lifecycle: &Arc<WorkerLifecycle>,
    reason: ServiceError,
) {
    {
        let mut inner = match lock_inner(shared) {
            Ok(inner) => inner,
            Err(_) => {
                cancel_once(cancel);
                lifecycle.request_stop();
                let _ = lifecycle.wait_stopping(shared.shutdown_timeout);
                return;
            }
        };
        if let State::Starting(active) = &inner.state {
            if active.options.generation == generation {
                let active = match std::mem::replace(&mut inner.state, State::Stopped) {
                    State::Starting(active) => active,
                    _ => unreachable!(),
                };
                inner.state = State::Stopping(Stopping {
                    generation,
                    was_running: false,
                    cancel: active.cancel.clone(),
                    lifecycle: active.lifecycle,
                    start_completions: active.start_completions,
                    stop_completions: Vec::new(),
                    reason,
                });
            }
        }
    }

    cancel_once(cancel);
    lifecycle.request_stop();
    let result = lifecycle.wait_stopping(shared.shutdown_timeout);
    finish_worker(
        shared,
        generation,
        ShutdownObservation {
            result,
            quarantine: None,
        },
    );
}

struct ShutdownObservation {
    result: Result<(), ServiceError>,
    quarantine: Option<WorkerOwner>,
}

fn finish_worker(shared: &Arc<Shared>, generation: u64, observation: ShutdownObservation) {
    let ShutdownObservation {
        result: worker_result,
        quarantine,
    } = observation;
    let (start_completions, stop_completions, start_event, stop_event) = {
        let mut inner = match lock_inner(shared) {
            Ok(inner) => inner,
            Err(_) => return,
        };
        match std::mem::replace(&mut inner.state, State::Stopped) {
            State::Stopping(stopping) if stopping.generation == generation => {
                let terminal = if stopping.reason.code == "ERR_ARTI_SHUTDOWN" {
                    Some(stopping.reason.clone())
                } else if stopping.was_running {
                    worker_result
                        .err()
                        .map(|error| unexpected_exit_error(Some(error)))
                } else {
                    worker_result
                        .err()
                        .filter(|error| error.code == "ERR_ARTI_SHUTDOWN")
                };
                if let Some(error) = terminal {
                    let event = failed_event(generation, &error);
                    inner.state = State::Failed(FailedState {
                        error: error.clone(),
                        _quarantine: quarantine,
                    });
                    (
                        stopping.start_completions,
                        stopping.stop_completions,
                        event.clone(),
                        event,
                    )
                } else {
                    let start_event = failed_event(generation, &stopping.reason);
                    (
                        stopping.start_completions,
                        stopping.stop_completions,
                        start_event,
                        ServiceEvent::Stopped { generation },
                    )
                }
            }
            State::Running(running) if running.options.generation == generation => {
                let error = unexpected_exit_error(worker_result.err());
                inner.state = State::Failed(FailedState {
                    error: error.clone(),
                    _quarantine: quarantine,
                });
                let event = failed_event(generation, &error);
                (Vec::new(), Vec::new(), event.clone(), event)
            }
            State::Failed(mut failed) => {
                if failed._quarantine.is_none() {
                    failed._quarantine = quarantine;
                }
                inner.state = State::Failed(failed);
                return;
            }
            state => {
                inner.state = state;
                return;
            }
        }
    };

    for completion in start_completions {
        let _ = queue_completion(shared, completion, start_event.clone());
    }
    for completion in stop_completions {
        let _ = queue_completion(shared, completion, stop_event.clone());
    }
}

fn cancel_once(cancel: &CancelSender) {
    let sender = match cancel.lock() {
        Ok(mut sender) => sender.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(sender) = sender {
        let _ = sender.send(());
    }
}

fn safe_completion(completion: Completion, event: ServiceEvent) {
    let _ = catch_unwind(AssertUnwindSafe(|| completion(event)));
}

fn queue_completion(
    shared: &Arc<Shared>,
    completion: Completion,
    event: ServiceEvent,
) -> Result<(), ServiceError> {
    let dispatcher = shared.dispatcher.as_ref().ok_or_else(|| {
        ServiceError::new("ERR_ARTI_SHUTDOWN", "completion dispatcher is unavailable")
    })?;
    dispatcher
        .send(completion, event)
        .map_err(|_| ServiceError::new("ERR_ARTI_SHUTDOWN", "completion dispatcher has stopped"))
}

fn lock_worker_slot(slot: &WorkerSlot) -> std::sync::MutexGuard<'_, Option<WorkerHandle>> {
    match slot.lock() {
        Ok(slot) => slot,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn lock_lifecycle(state: &Mutex<LifecycleState>) -> std::sync::MutexGuard<'_, LifecycleState> {
    match state.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn lock_worker_owner(
    slot: &Arc<Mutex<Option<WorkerOwner>>>,
) -> std::sync::MutexGuard<'_, Option<WorkerOwner>> {
    match slot.lock() {
        Ok(slot) => slot,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn lock_inner<'a>(
    shared: &'a Arc<Shared>,
) -> Result<std::sync::MutexGuard<'a, Inner>, ServiceError> {
    match shared.inner.lock() {
        Ok(inner) => Ok(inner),
        Err(poisoned) => {
            let terminal =
                ServiceError::new("ERR_ARTI_SHUTDOWN", "Arti service state mutex was poisoned");
            let mut inner = poisoned.into_inner();
            let state = std::mem::replace(
                &mut inner.state,
                State::Failed(FailedState {
                    error: terminal.clone(),
                    _quarantine: None,
                }),
            );
            let (generation, cancel, lifecycle, startup_waker, start_completions, stop_completions) =
                match state {
                    State::Starting(active) => (
                        active.options.generation,
                        Some(active.cancel),
                        Some(active.lifecycle),
                        Some(active.startup_waker),
                        active.start_completions,
                        Vec::new(),
                    ),
                    State::Running(active) => (
                        active.options.generation,
                        Some(active.cancel),
                        Some(active.lifecycle),
                        None,
                        Vec::new(),
                        Vec::new(),
                    ),
                    State::Stopping(stopping) => (
                        stopping.generation,
                        Some(stopping.cancel),
                        Some(stopping.lifecycle),
                        None,
                        stopping.start_completions,
                        stopping.stop_completions,
                    ),
                    state => {
                        inner.state = match state {
                            State::Failed(failed) => State::Failed(failed),
                            _ => State::Failed(FailedState {
                                error: terminal.clone(),
                                _quarantine: None,
                            }),
                        };
                        (
                            inner.last_generation,
                            None,
                            None,
                            None,
                            Vec::new(),
                            Vec::new(),
                        )
                    }
                };
            shared.inner.clear_poison();
            drop(inner);
            if let Some(cancel) = cancel {
                cancel_once(&cancel);
            }
            if let Some(lifecycle) = lifecycle {
                lifecycle.request_stop();
            }
            if let Some(startup_waker) = startup_waker {
                let _ = startup_waker.try_send(Err(cancelled_error()));
            }
            let event = failed_event(generation, &terminal);
            for completion in start_completions {
                let _ = queue_completion(shared, completion, event.clone());
            }
            for completion in stop_completions {
                let _ = queue_completion(shared, completion, event.clone());
            }
            Err(terminal)
        }
    }
}

fn cancel_current(shared: &Arc<Shared>, generation: u64) {
    let active = match lock_inner(shared) {
        Ok(inner) => match &inner.state {
            State::Starting(active) if active.options.generation == generation => Some((
                active.cancel.clone(),
                active.lifecycle.clone(),
                active.startup_waker.clone(),
            )),
            _ => None,
        },
        Err(_) => None,
    };
    if let Some((cancel, lifecycle, startup_waker)) = active {
        cancel_once(&cancel);
        lifecycle.request_stop();
        let _ = startup_waker.try_send(Err(cancelled_error()));
    }
}

fn finish_creation_failure(
    shared: &Arc<Shared>,
    generation: u64,
    error: ServiceError,
    terminal: bool,
    quarantine: Option<WorkerOwner>,
) {
    let (start_completions, stop_completions) = {
        let mut inner = match lock_inner(shared) {
            Ok(inner) => inner,
            Err(_) => return,
        };
        let state = std::mem::replace(&mut inner.state, State::Stopped);
        let (start_completions, stop_completions) = match state {
            State::Starting(active) if active.options.generation == generation => {
                (active.start_completions, Vec::new())
            }
            State::Stopping(stopping) if stopping.generation == generation => {
                (stopping.start_completions, stopping.stop_completions)
            }
            state => {
                inner.state = state;
                return;
            }
        };
        if terminal {
            inner.state = State::Failed(FailedState {
                error: error.clone(),
                _quarantine: quarantine,
            });
        }
        (start_completions, stop_completions)
    };

    let failed = failed_event(generation, &error);
    for completion in start_completions {
        let _ = queue_completion(shared, completion, failed.clone());
    }
    for completion in stop_completions {
        let _ = queue_completion(
            shared,
            completion,
            if terminal {
                failed.clone()
            } else {
                ServiceEvent::Stopped { generation }
            },
        );
    }
}

fn transition_to_stopping(shared: &Arc<Shared>, generation: u64, reason: ServiceError) {
    let mut inner = match lock_inner(shared) {
        Ok(inner) => inner,
        Err(_) => return,
    };
    let state = std::mem::replace(&mut inner.state, State::Stopped);
    inner.state = match state {
        State::Starting(active) if active.options.generation == generation => {
            State::Stopping(Stopping {
                generation,
                was_running: false,
                cancel: active.cancel,
                lifecycle: active.lifecycle,
                start_completions: active.start_completions,
                stop_completions: Vec::new(),
                reason,
            })
        }
        State::Running(active) if active.options.generation == generation => {
            State::Stopping(Stopping {
                generation,
                was_running: true,
                cancel: active.cancel,
                lifecycle: active.lifecycle,
                start_completions: Vec::new(),
                stop_completions: Vec::new(),
                reason,
            })
        }
        state => state,
    };
}

fn unexpected_exit_error(error: Option<ServiceError>) -> ServiceError {
    match error {
        Some(error) => ServiceError::new(
            "ERR_ARTI_SHUTDOWN",
            format!(
                "Arti worker exited unexpectedly ({}: {})",
                error.code, error.message
            ),
        ),
        None => ServiceError::new("ERR_ARTI_SHUTDOWN", "Arti worker exited unexpectedly"),
    }
}

fn failed_event(generation: u64, error: &ServiceError) -> ServiceEvent {
    ServiceEvent::Failed {
        generation,
        code: error.code,
        message: error.message.clone(),
    }
}

fn conflict_error() -> ServiceError {
    ServiceError::new(
        "ERR_ARTI_CONFIG_CONFLICT",
        "another Arti service configuration is active",
    )
}

fn cancelled_error() -> ServiceError {
    ServiceError::new("ERR_ARTI_CANCELLED", "Arti service is stopping")
}

fn generation_error(last: u64, requested: u64) -> ServiceError {
    ServiceError::new(
        "ERR_ARTI_CONFIG",
        format!("generation {requested} must be greater than {last}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use tokio::sync::oneshot;

    struct ControlledSocksService {
        port: u16,
        running: Option<oneshot::Receiver<()>>,
        accept_closed: mpsc::SyncSender<()>,
        connections_aborted: mpsc::SyncSender<()>,
        connections_joined: mpsc::SyncSender<()>,
        allow_join: mpsc::Receiver<()>,
    }

    impl ManagedSocksService for ControlledSocksService {
        fn port(&self) -> u16 {
            self.port
        }

        fn wait(&mut self) -> ServiceFuture<'_, Result<(), ServiceError>> {
            let running = self.running.as_mut().expect("service wait is called once");
            Box::pin(async move {
                let _ = running.await;
                Ok(())
            })
        }

        fn shutdown(self: Box<Self>) -> ServiceFuture<'static, Result<(), ServiceError>> {
            Box::pin(async move {
                self.accept_closed
                    .send(())
                    .map_err(|error| ServiceError::new("ERR_ARTI_SHUTDOWN", error.to_string()))?;
                self.connections_aborted
                    .send(())
                    .map_err(|error| ServiceError::new("ERR_ARTI_SHUTDOWN", error.to_string()))?;
                tokio::task::block_in_place(|| self.allow_join.recv())
                    .map_err(|error| ServiceError::new("ERR_ARTI_SHUTDOWN", error.to_string()))?;
                self.connections_joined
                    .send(())
                    .map_err(|error| ServiceError::new("ERR_ARTI_SHUTDOWN", error.to_string()))?;
                Ok(())
            })
        }
    }

    #[test]
    fn worker_reports_loopback_port_and_joins_service_before_success() {
        let (bootstrapped_tx, bootstrapped) = mpsc::sync_channel(0);
        let bootstrap = move |_data_dir: PathBuf| {
            let bootstrapped_tx = bootstrapped_tx.clone();
            Box::pin(async move {
                bootstrapped_tx.send(()).unwrap();
                Ok(())
            }) as ServiceFuture<'static, Result<(), ServiceError>>
        };
        let (_running_tx, running) = oneshot::channel();
        let (accept_closed_tx, accept_closed) = mpsc::sync_channel(0);
        let (connections_aborted_tx, connections_aborted) = mpsc::sync_channel(0);
        let (connections_joined_tx, connections_joined) = mpsc::sync_channel(0);
        let (allow_join_tx, allow_join) = mpsc::sync_channel(0);
        let bind = Arc::new(Mutex::new(Some((
            running,
            accept_closed_tx,
            connections_aborted_tx,
            connections_joined_tx,
            allow_join,
        ))));
        let bind_and_serve = move |()| {
            let (running, accept_closed, connections_aborted, connections_joined, allow_join) =
                bind.lock().unwrap().take().unwrap();
            Box::pin(async move {
                Ok(Box::new(ControlledSocksService {
                    port: 19050,
                    running: Some(running),
                    accept_closed,
                    connections_aborted,
                    connections_joined,
                    allow_join,
                }) as Box<dyn ManagedSocksService>)
            })
                as ServiceFuture<'static, Result<Box<dyn ManagedSocksService>, ServiceError>>
        };
        let factory = ProductionWorkerFactory::with_hooks(bootstrap, bind_and_serve);
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let data_dir = std::env::temp_dir().join(format!(
            "bare-arti-worker-test-{}-{:?}",
            std::process::id(),
            thread::current().id()
        ));
        let worker = factory
            .spawn(
                ServiceOptions {
                    data_dir: data_dir.clone(),
                    timeout: Duration::from_secs(60),
                    generation: 1,
                },
                cancel_rx,
                ready_tx,
            )
            .unwrap();

        bootstrapped.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(
            ready_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ok(19050)
        );
        assert!(
            !worker.is_finished(),
            "worker remains alive after readiness"
        );

        cancel_tx.send(()).unwrap();
        accept_closed.recv_timeout(Duration::from_secs(1)).unwrap();
        connections_aborted
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(!worker.is_finished(), "worker waits for connection joins");
        allow_join_tx.send(()).unwrap();
        connections_joined
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert_eq!(worker.join().unwrap(), Ok(()));
        std::fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn worker_maps_bootstrap_bind_and_cancellation_to_stable_codes() {
        fn test_options(label: &str, generation: u64) -> ServiceOptions {
            ServiceOptions {
                data_dir: std::env::temp_dir().join(format!(
                    "bare-arti-worker-{label}-{}-{:?}",
                    std::process::id(),
                    thread::current().id()
                )),
                timeout: Duration::from_secs(60),
                generation,
            }
        }

        let bootstrap_factory = ProductionWorkerFactory::with_hooks(
            |_data_dir| {
                Box::pin(async { Err(ServiceError::new("INTERNAL", "offline bootstrap failure")) })
                    as ServiceFuture<'static, Result<(), ServiceError>>
            },
            |()| unreachable!(),
        );
        let bootstrap_options = test_options("bootstrap", 1);
        let (_cancel_tx, cancel_rx) = oneshot::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = bootstrap_factory
            .spawn(bootstrap_options.clone(), cancel_rx, ready_tx)
            .unwrap();
        let error = ready_rx.recv().unwrap().unwrap_err();
        assert_eq!(error.code, "ERR_ARTI_BOOTSTRAP");
        assert_eq!(worker.join().unwrap().unwrap_err(), error);
        std::fs::remove_dir_all(bootstrap_options.data_dir).unwrap();

        let bind_factory = ProductionWorkerFactory::with_hooks(
            |_data_dir| {
                Box::pin(async { Ok(()) }) as ServiceFuture<'static, Result<(), ServiceError>>
            },
            |()| {
                Box::pin(async { Err(ServiceError::new("INTERNAL", "offline bind failure")) })
                    as ServiceFuture<'static, Result<Box<dyn ManagedSocksService>, ServiceError>>
            },
        );
        let bind_options = test_options("bind", 2);
        let (_cancel_tx, cancel_rx) = oneshot::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = bind_factory
            .spawn(bind_options.clone(), cancel_rx, ready_tx)
            .unwrap();
        let error = ready_rx.recv().unwrap().unwrap_err();
        assert_eq!(error.code, "ERR_ARTI_BIND");
        assert_eq!(worker.join().unwrap().unwrap_err(), error);
        std::fs::remove_dir_all(bind_options.data_dir).unwrap();

        let cancellation_factory = ProductionWorkerFactory::with_hooks(
            |_data_dir| {
                Box::pin(std::future::pending()) as ServiceFuture<'static, Result<(), ServiceError>>
            },
            |()| unreachable!(),
        );
        let cancellation_options = test_options("cancel", 3);
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = cancellation_factory
            .spawn(cancellation_options.clone(), cancel_rx, ready_tx)
            .unwrap();
        cancel_tx.send(()).unwrap();
        let error = ready_rx.recv().unwrap().unwrap_err();
        assert_eq!(error.code, "ERR_ARTI_CANCELLED");
        assert_eq!(worker.join().unwrap().unwrap_err(), error);
        std::fs::remove_dir_all(cancellation_options.data_dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn worker_revalidates_data_dir_before_bootstrap() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let root = std::env::temp_dir().join(format!(
            "bare-arti-native-validation-{}-{:?}",
            std::process::id(),
            thread::current().id()
        ));
        let target = root.join("target");
        let link = root.join("link");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&target, &link).unwrap();
        let bootstrap_calls = Arc::new(AtomicUsize::new(0));
        let calls = bootstrap_calls.clone();
        let factory = ProductionWorkerFactory::with_hooks(
            move |_data_dir| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(()) }) as ServiceFuture<'static, Result<(), ServiceError>>
            },
            |()| unreachable!(),
        );
        let (_cancel_tx, cancel_rx) = oneshot::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = factory
            .spawn(
                ServiceOptions {
                    data_dir: link,
                    timeout: Duration::from_secs(60),
                    generation: 1,
                },
                cancel_rx,
                ready_tx,
            )
            .unwrap();

        let error = ready_rx.recv().unwrap().unwrap_err();
        assert_eq!(error.code, "ERR_ARTI_CONFIG");
        assert_eq!(worker.join().unwrap().unwrap_err(), error);
        assert_eq!(bootstrap_calls.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    enum GateDecision {
        Ready,
        Timeout,
        WorkerExited,
    }

    struct ManualGate {
        decisions: Mutex<mpsc::Receiver<GateDecision>>,
    }

    impl StartupGate for ManualGate {
        fn wait(
            &self,
            ready: mpsc::Receiver<Result<u16, ServiceError>>,
            _duration: Duration,
        ) -> StartupOutcome {
            match self.decisions.lock().unwrap().recv().unwrap() {
                GateDecision::Ready => match ready.recv() {
                    Ok(result) => StartupOutcome::Ready(result),
                    Err(_) => StartupOutcome::WorkerExited,
                },
                GateDecision::Timeout => StartupOutcome::Timeout,
                GateDecision::WorkerExited => StartupOutcome::WorkerExited,
            }
        }
    }

    struct WorkerControl {
        options: ServiceOptions,
        ready: mpsc::SyncSender<Result<u16, ServiceError>>,
        cancelled: mpsc::Receiver<()>,
        finish: mpsc::SyncSender<Result<(), ServiceError>>,
    }

    struct ControlledFactory {
        spawned: mpsc::Sender<WorkerControl>,
        spawn_count: Arc<AtomicUsize>,
    }

    impl WorkerFactory for ControlledFactory {
        fn spawn(
            &self,
            options: ServiceOptions,
            cancel: oneshot::Receiver<()>,
            ready: mpsc::SyncSender<Result<u16, ServiceError>>,
        ) -> Result<thread::JoinHandle<Result<(), ServiceError>>, ServiceError> {
            let (cancelled_tx, cancelled) = mpsc::sync_channel(0);
            let (finish, finish_rx) = mpsc::sync_channel(0);
            self.spawn_count.fetch_add(1, Ordering::SeqCst);
            self.spawned
                .send(WorkerControl {
                    options,
                    ready: ready.clone(),
                    cancelled,
                    finish,
                })
                .unwrap();

            thread::Builder::new()
                .name("bare-arti-test-worker".into())
                .spawn(move || {
                    thread::spawn(move || {
                        let _ = cancel.blocking_recv();
                        let _ = cancelled_tx.send(());
                    });
                    finish_rx.recv().unwrap_or(Ok(()))
                })
                .map_err(|error| ServiceError::new("ERR_ARTI_BOOTSTRAP", error.to_string()))
        }
    }

    struct Harness {
        controller: ServiceController,
        decisions: mpsc::Sender<GateDecision>,
        spawned: mpsc::Receiver<WorkerControl>,
        spawn_count: Arc<AtomicUsize>,
    }

    impl Harness {
        fn new() -> Self {
            let (decision_tx, decision_rx) = mpsc::channel();
            let (spawned_tx, spawned) = mpsc::channel();
            let spawn_count = Arc::new(AtomicUsize::new(0));
            let controller = ServiceController::new(
                Arc::new(ControlledFactory {
                    spawned: spawned_tx,
                    spawn_count: spawn_count.clone(),
                }),
                Arc::new(ManualGate {
                    decisions: Mutex::new(decision_rx),
                }),
            );
            Self {
                controller,
                decisions: decision_tx,
                spawned,
                spawn_count,
            }
        }

        fn worker(&self) -> WorkerControl {
            self.spawned.recv_timeout(Duration::from_secs(1)).unwrap()
        }
    }

    fn options(generation: u64, name: &str) -> ServiceOptions {
        ServiceOptions {
            data_dir: PathBuf::from(name),
            timeout: Duration::from_secs(60),
            generation,
        }
    }

    fn completion() -> (Completion, mpsc::Receiver<ServiceEvent>) {
        let (tx, rx) = mpsc::channel();
        (
            Box::new(move |event| {
                let _ = tx.send(event);
            }),
            rx,
        )
    }

    fn recv(rx: &mpsc::Receiver<ServiceEvent>) -> ServiceEvent {
        rx.recv_timeout(Duration::from_secs(1)).unwrap()
    }

    fn assert_pending(rx: &mpsc::Receiver<ServiceEvent>) {
        assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
    }

    fn stop_running(harness: &Harness, worker: WorkerControl, generation: u64) {
        let (done, stopped) = completion();
        harness.controller.stop(generation, done).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        worker.finish.send(Ok(())).unwrap();
        assert_eq!(recv(&stopped), ServiceEvent::Stopped { generation });
    }

    #[test]
    fn production_gate_maps_ready_timeout_and_disconnect() {
        let gate = ProductionStartupGate;
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        ready_tx.send(Ok(19050)).unwrap();
        assert_eq!(
            gate.wait(ready_rx, Duration::from_secs(1)),
            StartupOutcome::Ready(Ok(19050))
        );

        let (_ready_tx, ready_rx) = mpsc::sync_channel(1);
        assert_eq!(gate.wait(ready_rx, Duration::ZERO), StartupOutcome::Timeout);

        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        drop(ready_tx);
        assert_eq!(
            gate.wait(ready_rx, Duration::from_secs(1)),
            StartupOutcome::WorkerExited
        );
    }

    #[test]
    fn matching_start_shares_worker_and_conflicting_start_rejects() {
        let harness = Harness::new();
        let (first_done, first) = completion();
        let (matching_done, matching) = completion();
        harness
            .controller
            .start(options(1, "/private/a"), first_done)
            .unwrap();
        let worker = harness.worker();
        assert_eq!(worker.options, options(1, "/private/a"));
        harness
            .controller
            .start(options(1, "/private/a"), matching_done)
            .unwrap();
        let (conflict_done, _conflict) = completion();
        let error = harness
            .controller
            .start(options(1, "/private/b"), conflict_done)
            .unwrap_err();
        assert_eq!(error.code, "ERR_ARTI_CONFIG_CONFLICT");
        assert_eq!(harness.spawn_count.load(Ordering::SeqCst), 1);

        harness.decisions.send(GateDecision::Ready).unwrap();
        worker.ready.send(Ok(19050)).unwrap();
        let running = ServiceEvent::Running {
            generation: 1,
            port: 19050,
        };
        assert_eq!(recv(&first), running);
        assert_eq!(recv(&matching), running);

        let (running_done, running_again) = completion();
        harness
            .controller
            .start(options(1, "/private/a"), running_done)
            .unwrap();
        assert_eq!(recv(&running_again), running);
        assert_eq!(harness.spawn_count.load(Ordering::SeqCst), 1);
        stop_running(&harness, worker, 1);
    }

    #[test]
    fn generations_must_increase_and_cannot_be_reused() {
        let harness = Harness::new();
        let (done, started) = completion();
        harness
            .controller
            .start(options(2, "/private/a"), done)
            .unwrap();
        let worker = harness.worker();
        harness.decisions.send(GateDecision::Ready).unwrap();
        worker.ready.send(Ok(19050)).unwrap();
        assert!(matches!(recv(&started), ServiceEvent::Running { .. }));
        stop_running(&harness, worker, 2);

        for generation in [2, 1] {
            let (done, _rx) = completion();
            let error = harness
                .controller
                .start(options(generation, "/private/a"), done)
                .unwrap_err();
            assert_eq!(error.code, "ERR_ARTI_CONFIG");
        }

        let (done, failed) = completion();
        harness
            .controller
            .start(options(3, "/private/a"), done)
            .unwrap();
        let worker = harness.worker();
        harness.decisions.send(GateDecision::Timeout).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        worker.finish.send(Ok(())).unwrap();
        assert!(matches!(
            recv(&failed),
            ServiceEvent::Failed {
                generation: 3,
                code: "ERR_ARTI_TIMEOUT",
                ..
            }
        ));
    }

    #[test]
    fn timeout_cancels_and_joins_before_completion_and_reset() {
        let harness = Harness::new();
        let (done, failed) = completion();
        harness
            .controller
            .start(options(1, "/private/a"), done)
            .unwrap();
        let worker = harness.worker();
        harness.decisions.send(GateDecision::Timeout).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert_pending(&failed);

        let controller = harness.controller.clone();
        let (result_tx, result_rx) = mpsc::channel();
        thread::spawn(move || {
            let (done, _rx) = completion();
            result_tx
                .send(controller.start(options(2, "/private/a"), done))
                .unwrap();
        });
        let blocked = result_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap_err();
        assert_eq!(blocked.code, "ERR_ARTI_CANCELLED");

        worker.finish.send(Ok(())).unwrap();
        assert!(matches!(
            recv(&failed),
            ServiceEvent::Failed {
                generation: 1,
                code: "ERR_ARTI_TIMEOUT",
                ..
            }
        ));

        let (done, _started) = completion();
        harness
            .controller
            .start(options(2, "/private/a"), done)
            .unwrap();
        let worker = harness.worker();
        harness.decisions.send(GateDecision::Timeout).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        worker.finish.send(Ok(())).unwrap();
    }

    #[test]
    fn explicit_cancellation_waits_for_gate_and_join() {
        let harness = Harness::new();
        let (start_done, started) = completion();
        let (stop_done, stopped) = completion();
        harness
            .controller
            .start(options(1, "/private/a"), start_done)
            .unwrap();
        let worker = harness.worker();
        harness.controller.stop(1, stop_done).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert_pending(&started);
        assert_pending(&stopped);
        harness.decisions.send(GateDecision::WorkerExited).unwrap();
        worker.finish.send(Ok(())).unwrap();

        assert!(matches!(
            recv(&started),
            ServiceEvent::Failed {
                generation: 1,
                code: "ERR_ARTI_CANCELLED",
                ..
            }
        ));
        assert_eq!(recv(&stopped), ServiceEvent::Stopped { generation: 1 });
    }

    #[test]
    fn production_startup_gate_is_woken_by_stop() {
        let (spawned_tx, spawned) = mpsc::channel();
        let controller = ServiceController::new(
            Arc::new(ControlledFactory {
                spawned: spawned_tx,
                spawn_count: Arc::new(AtomicUsize::new(0)),
            }),
            Arc::new(ProductionStartupGate),
        );
        let (start_done, started) = completion();
        let (stop_done, stopped) = completion();
        controller
            .start(options(1, "/private/a"), start_done)
            .unwrap();
        let worker = spawned.recv_timeout(Duration::from_secs(1)).unwrap();

        controller.stop(1, stop_done).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert_pending(&started);
        assert_pending(&stopped);
        worker.finish.send(Ok(())).unwrap();

        assert!(matches!(
            recv(&started),
            ServiceEvent::Failed {
                code: "ERR_ARTI_CANCELLED",
                ..
            }
        ));
        assert_eq!(recv(&stopped), ServiceEvent::Stopped { generation: 1 });
    }

    #[test]
    fn late_completion_after_timeout_is_discarded() {
        let harness = Harness::new();
        let (done, failed) = completion();
        harness
            .controller
            .start(options(1, "/private/a"), done)
            .unwrap();
        let worker = harness.worker();
        harness.decisions.send(GateDecision::Timeout).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(worker.ready.send(Ok(19999)).is_err());
        worker.finish.send(Ok(())).unwrap();
        assert!(matches!(
            recv(&failed),
            ServiceEvent::Failed {
                code: "ERR_ARTI_TIMEOUT",
                ..
            }
        ));

        let (done, running) = completion();
        harness
            .controller
            .start(options(2, "/private/a"), done)
            .unwrap();
        let worker = harness.worker();
        harness.decisions.send(GateDecision::Ready).unwrap();
        worker.ready.send(Ok(19050)).unwrap();
        assert_eq!(
            recv(&running),
            ServiceEvent::Running {
                generation: 2,
                port: 19050
            }
        );
        stop_running(&harness, worker, 2);
    }

    #[test]
    fn stale_stop_is_an_idempotent_noop() {
        let harness = Harness::new();
        let (done, running) = completion();
        harness
            .controller
            .start(options(2, "/private/a"), done)
            .unwrap();
        let worker = harness.worker();
        harness.decisions.send(GateDecision::Ready).unwrap();
        worker.ready.send(Ok(19050)).unwrap();
        assert!(matches!(recv(&running), ServiceEvent::Running { .. }));

        let (stale_done, stale) = completion();
        harness.controller.stop(1, stale_done).unwrap();
        assert_eq!(recv(&stale), ServiceEvent::Stopped { generation: 1 });
        assert!(matches!(
            worker.cancelled.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        stop_running(&harness, worker, 2);
    }

    #[test]
    fn bootstrap_failure_recovers_and_allows_restart() {
        let harness = Harness::new();
        let (done, failed) = completion();
        harness
            .controller
            .start(options(1, "/private/a"), done)
            .unwrap();
        let worker = harness.worker();
        harness.decisions.send(GateDecision::Ready).unwrap();
        worker
            .ready
            .send(Err(ServiceError::new(
                "ERR_ARTI_BOOTSTRAP",
                "bootstrap failed",
            )))
            .unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert_pending(&failed);
        worker.finish.send(Ok(())).unwrap();
        assert!(matches!(
            recv(&failed),
            ServiceEvent::Failed {
                generation: 1,
                code: "ERR_ARTI_BOOTSTRAP",
                ..
            }
        ));

        let (done, running) = completion();
        harness
            .controller
            .start(options(2, "/private/a"), done)
            .unwrap();
        let worker = harness.worker();
        harness.decisions.send(GateDecision::Ready).unwrap();
        worker.ready.send(Ok(19051)).unwrap();
        assert!(matches!(
            recv(&running),
            ServiceEvent::Running { port: 19051, .. }
        ));
        stop_running(&harness, worker, 2);
    }

    #[test]
    fn shutdown_failure_is_terminal() {
        let harness = Harness::new();
        let (done, running) = completion();
        harness
            .controller
            .start(options(1, "/private/a"), done)
            .unwrap();
        let worker = harness.worker();
        harness.decisions.send(GateDecision::Ready).unwrap();
        worker.ready.send(Ok(19050)).unwrap();
        assert!(matches!(recv(&running), ServiceEvent::Running { .. }));

        let (stop_done, stopped) = completion();
        harness.controller.stop(1, stop_done).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        worker
            .finish
            .send(Err(ServiceError::new("ERR_ARTI_SHUTDOWN", "join failed")))
            .unwrap();
        assert!(matches!(
            recv(&stopped),
            ServiceEvent::Failed {
                generation: 1,
                code: "ERR_ARTI_SHUTDOWN",
                ..
            }
        ));

        let (done, _rx) = completion();
        assert_eq!(
            harness
                .controller
                .start(options(2, "/private/a"), done)
                .unwrap_err()
                .code,
            "ERR_ARTI_SHUTDOWN"
        );
        let (done, _rx) = completion();
        assert_eq!(
            harness.controller.stop(1, done).unwrap_err().code,
            "ERR_ARTI_SHUTDOWN"
        );
    }

    #[test]
    fn post_ready_worker_error_during_stop_is_terminal_with_diagnostics() {
        let harness = Harness::new();
        let (done, running) = completion();
        harness
            .controller
            .start(options(1, "/private/a"), done)
            .unwrap();
        let worker = harness.worker();
        harness.decisions.send(GateDecision::Ready).unwrap();
        worker.ready.send(Ok(19050)).unwrap();
        assert!(matches!(recv(&running), ServiceEvent::Running { .. }));

        let (done, stopped) = completion();
        harness.controller.stop(1, done).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        worker
            .finish
            .send(Err(ServiceError::new(
                "ERR_ARTI_BOOTSTRAP",
                "worker failed while stopping",
            )))
            .unwrap();
        let event = recv(&stopped);
        assert!(matches!(
            event,
            ServiceEvent::Failed {
                code: "ERR_ARTI_SHUTDOWN",
                ..
            }
        ));
        if let ServiceEvent::Failed { message, .. } = event {
            assert!(message.contains("ERR_ARTI_BOOTSTRAP"));
            assert!(message.contains("worker failed while stopping"));
        }
    }

    struct FailingFactory {
        panic: bool,
    }

    struct EarlyExitFactory;

    impl WorkerFactory for EarlyExitFactory {
        fn spawn(
            &self,
            _options: ServiceOptions,
            _cancel: oneshot::Receiver<()>,
            _ready: mpsc::SyncSender<Result<u16, ServiceError>>,
        ) -> Result<thread::JoinHandle<Result<(), ServiceError>>, ServiceError> {
            thread::Builder::new()
                .name("bare-arti-early-exit-worker".into())
                .spawn(|| Ok(()))
                .map_err(|error| ServiceError::new("ERR_ARTI_BOOTSTRAP", error.to_string()))
        }
    }

    impl WorkerFactory for FailingFactory {
        fn spawn(
            &self,
            _options: ServiceOptions,
            _cancel: oneshot::Receiver<()>,
            _ready: mpsc::SyncSender<Result<u16, ServiceError>>,
        ) -> Result<thread::JoinHandle<Result<(), ServiceError>>, ServiceError> {
            if self.panic {
                panic!("factory panic")
            }
            Err(ServiceError::new(
                "ERR_ARTI_BOOTSTRAP",
                "factory refused worker",
            ))
        }
    }

    struct FailingWorkerReaper;

    impl WorkerReaper for FailingWorkerReaper {
        fn spawn(&self, task: ReaperTask) -> Result<(), ReaperSpawnError> {
            Err(ReaperSpawnError {
                error: ServiceError::new("ERR_ARTI_SHUTDOWN", "reaper creation failed"),
                task,
            })
        }
    }

    struct PanickingWorkerReaper;

    impl WorkerReaper for PanickingWorkerReaper {
        fn spawn(&self, _task: ReaperTask) -> Result<(), ReaperSpawnError> {
            panic!("reaper spawner panic")
        }
    }

    struct FailingSupervisorSpawner;

    impl SupervisorSpawner for FailingSupervisorSpawner {
        fn spawn(&self, task: SupervisorTask) -> Result<(), SupervisorSpawnError> {
            Err(SupervisorSpawnError {
                error: ServiceError::new("ERR_ARTI_SHUTDOWN", "supervisor thread creation failed"),
                task,
            })
        }
    }

    struct PanickingSupervisorSpawner;

    impl SupervisorSpawner for PanickingSupervisorSpawner {
        fn spawn(&self, _task: SupervisorTask) -> Result<(), SupervisorSpawnError> {
            panic!("supervisor spawner panic")
        }
    }

    struct PanickingStartupGate;

    impl StartupGate for PanickingStartupGate {
        fn wait(
            &self,
            _ready: mpsc::Receiver<Result<u16, ServiceError>>,
            _duration: Duration,
        ) -> StartupOutcome {
            panic!("startup gate panic")
        }
    }

    #[test]
    fn factory_error_and_panic_complete_once_and_release_state() {
        for panic in [false, true] {
            let (decision_tx, decision_rx) = mpsc::channel();
            let controller = ServiceController::new(
                Arc::new(FailingFactory { panic }),
                Arc::new(ManualGate {
                    decisions: Mutex::new(decision_rx),
                }),
            );
            drop(decision_tx);
            let (done, failed) = completion();
            controller.start(options(1, "/private/a"), done).unwrap();
            assert!(matches!(
                recv(&failed),
                ServiceEvent::Failed {
                    generation: 1,
                    code: "ERR_ARTI_BOOTSTRAP",
                    ..
                }
            ));
            assert!(matches!(
                failed.try_recv(),
                Err(mpsc::TryRecvError::Disconnected)
            ));

            let (done, restarted) = completion();
            controller.start(options(2, "/private/a"), done).unwrap();
            assert!(matches!(
                recv(&restarted),
                ServiceEvent::Failed { generation: 2, .. }
            ));
        }
    }

    #[test]
    fn production_gate_wakes_when_worker_exits_before_readiness() {
        let controller =
            ServiceController::new(Arc::new(EarlyExitFactory), Arc::new(ProductionStartupGate));
        let (done, failed) = completion();
        controller.start(options(1, "/private/a"), done).unwrap();

        assert!(matches!(
            recv(&failed),
            ServiceEvent::Failed {
                generation: 1,
                code: "ERR_ARTI_BOOTSTRAP",
                ..
            }
        ));
    }

    #[test]
    fn supervisor_spawn_failure_cancels_and_fails_terminal_once() {
        let (decision_tx, decision_rx) = mpsc::channel();
        let (spawned_tx, spawned) = mpsc::channel();
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let controller = ServiceController::with_dependencies(
            Arc::new(ControlledFactory {
                spawned: spawned_tx,
                spawn_count: spawn_count.clone(),
            }),
            Arc::new(ManualGate {
                decisions: Mutex::new(decision_rx),
            }),
            Arc::new(ProductionWorkerReaper),
            Arc::new(FailingSupervisorSpawner),
            SHUTDOWN_TIMEOUT,
        );
        drop(decision_tx);
        let (done, failed) = completion();
        controller.start(options(1, "/private/a"), done).unwrap();
        assert_eq!(spawn_count.load(Ordering::SeqCst), 0);
        assert!(matches!(spawned.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert!(matches!(
            recv(&failed),
            ServiceEvent::Failed {
                code: "ERR_ARTI_SHUTDOWN",
                ..
            }
        ));
        let (done, _rx) = completion();
        assert_eq!(
            controller
                .start(options(2, "/private/a"), done)
                .unwrap_err()
                .code,
            "ERR_ARTI_SHUTDOWN"
        );
    }

    #[test]
    fn supervisor_spawner_panic_cancels_and_fails_terminal() {
        let (decision_tx, decision_rx) = mpsc::channel();
        let (spawned_tx, spawned) = mpsc::channel();
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let controller = ServiceController::with_dependencies(
            Arc::new(ControlledFactory {
                spawned: spawned_tx,
                spawn_count: spawn_count.clone(),
            }),
            Arc::new(ManualGate {
                decisions: Mutex::new(decision_rx),
            }),
            Arc::new(ProductionWorkerReaper),
            Arc::new(PanickingSupervisorSpawner),
            SHUTDOWN_TIMEOUT,
        );
        drop(decision_tx);
        let (done, failed) = completion();
        controller.start(options(1, "/private/a"), done).unwrap();
        assert_eq!(spawn_count.load(Ordering::SeqCst), 0);
        assert!(matches!(spawned.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert!(matches!(
            recv(&failed),
            ServiceEvent::Failed {
                code: "ERR_ARTI_SHUTDOWN",
                ..
            }
        ));
    }

    #[test]
    fn startup_gate_panic_cancels_worker_and_fails_terminal() {
        let (spawned_tx, spawned) = mpsc::channel();
        let controller = ServiceController::new(
            Arc::new(ControlledFactory {
                spawned: spawned_tx,
                spawn_count: Arc::new(AtomicUsize::new(0)),
            }),
            Arc::new(PanickingStartupGate),
        );
        let (done, failed) = completion();
        controller.start(options(1, "/private/a"), done).unwrap();
        let worker = spawned.recv_timeout(Duration::from_secs(1)).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        worker.finish.send(Ok(())).unwrap();
        assert!(matches!(
            recv(&failed),
            ServiceEvent::Failed {
                code: "ERR_ARTI_SHUTDOWN",
                ..
            }
        ));
    }

    #[test]
    fn panicking_completion_does_not_block_later_callbacks_or_shutdown() {
        let harness = Harness::new();
        let (order_tx, order) = mpsc::channel();
        let caller = thread::current().id();
        let first_tx = order_tx.clone();
        harness
            .controller
            .start(
                options(1, "/private/a"),
                Box::new(move |_| {
                    first_tx.send((1, thread::current().id())).unwrap();
                    panic!("consumer callback panic")
                }),
            )
            .unwrap();
        let worker = harness.worker();
        harness
            .controller
            .start(
                options(1, "/private/a"),
                Box::new(move |_| order_tx.send((2, thread::current().id())).unwrap()),
            )
            .unwrap();
        harness.decisions.send(GateDecision::Ready).unwrap();
        worker.ready.send(Ok(19050)).unwrap();
        let first = order.recv_timeout(Duration::from_secs(1)).unwrap();
        let second = order.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!((first.0, second.0), (1, 2));
        assert_eq!(first.1, second.1, "callbacks use one serialized dispatcher");
        assert_ne!(first.1, caller, "callbacks never run on the caller thread");
        stop_running(&harness, worker, 1);
    }

    #[test]
    fn shutdown_observation_timeout_is_terminal_without_waiting_for_worker() {
        let (decision_tx, decision_rx) = mpsc::channel();
        let (spawned_tx, spawned) = mpsc::channel();
        let controller = ServiceController::with_dependencies(
            Arc::new(ControlledFactory {
                spawned: spawned_tx,
                spawn_count: Arc::new(AtomicUsize::new(0)),
            }),
            Arc::new(ManualGate {
                decisions: Mutex::new(decision_rx),
            }),
            Arc::new(ProductionWorkerReaper),
            Arc::new(ProductionSupervisorSpawner),
            Duration::ZERO,
        );
        let (done, started) = completion();
        controller.start(options(1, "/private/a"), done).unwrap();
        let worker = spawned.recv_timeout(Duration::from_secs(1)).unwrap();
        decision_tx.send(GateDecision::Timeout).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(matches!(
            recv(&started),
            ServiceEvent::Failed {
                code: "ERR_ARTI_SHUTDOWN",
                ..
            }
        ));
        worker.finish.send(Ok(())).unwrap();
        let (done, _rx) = completion();
        assert_eq!(
            controller
                .start(options(2, "/private/a"), done)
                .unwrap_err()
                .code,
            "ERR_ARTI_SHUTDOWN"
        );
    }

    #[test]
    fn healthy_running_worker_outlives_the_shutdown_deadline() {
        let (decision_tx, decision_rx) = mpsc::channel();
        let (spawned_tx, spawned) = mpsc::channel();
        let controller = ServiceController::with_dependencies(
            Arc::new(ControlledFactory {
                spawned: spawned_tx,
                spawn_count: Arc::new(AtomicUsize::new(0)),
            }),
            Arc::new(ManualGate {
                decisions: Mutex::new(decision_rx),
            }),
            Arc::new(ProductionWorkerReaper),
            Arc::new(ProductionSupervisorSpawner),
            Duration::from_millis(5),
        );
        let (done, running) = completion();
        controller.start(options(1, "/private/a"), done).unwrap();
        let worker = spawned.recv_timeout(Duration::from_secs(1)).unwrap();
        decision_tx.send(GateDecision::Ready).unwrap();
        worker.ready.send(Ok(19050)).unwrap();
        assert!(matches!(recv(&running), ServiceEvent::Running { .. }));

        thread::sleep(Duration::from_millis(25));
        let (done, still_running) = completion();
        controller.start(options(1, "/private/a"), done).unwrap();
        assert!(matches!(recv(&still_running), ServiceEvent::Running { .. }));

        let (done, stopped) = completion();
        controller.stop(1, done).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        worker.finish.send(Ok(())).unwrap();
        assert_eq!(recv(&stopped), ServiceEvent::Stopped { generation: 1 });
    }

    #[test]
    fn unavailable_or_panicking_reaper_retains_worker_owner() {
        for panics in [false, true] {
            let (decision_tx, decision_rx) = mpsc::channel();
            let (spawned_tx, spawned) = mpsc::channel();
            let reaper: Arc<dyn WorkerReaper> = if panics {
                Arc::new(PanickingWorkerReaper)
            } else {
                Arc::new(FailingWorkerReaper)
            };
            let controller = ServiceController::with_dependencies(
                Arc::new(ControlledFactory {
                    spawned: spawned_tx,
                    spawn_count: Arc::new(AtomicUsize::new(0)),
                }),
                Arc::new(ManualGate {
                    decisions: Mutex::new(decision_rx),
                }),
                reaper,
                Arc::new(ProductionSupervisorSpawner),
                SHUTDOWN_TIMEOUT,
            );
            let (done, failed) = completion();
            controller.start(options(1, "/private/a"), done).unwrap();
            let worker = spawned.recv_timeout(Duration::from_secs(1)).unwrap();
            worker
                .cancelled
                .recv_timeout(Duration::from_secs(1))
                .unwrap();
            drop(decision_tx);
            let owner = {
                let inner = controller.shared.inner.lock().unwrap();
                match &inner.state {
                    State::Failed(failed) => failed._quarantine.clone().unwrap(),
                    _ => panic!("reaper failure must terminalize the controller"),
                }
            };
            assert!(owner.has_worker(), "worker remains explicitly owned");
            assert!(matches!(
                recv(&failed),
                ServiceEvent::Failed {
                    code: "ERR_ARTI_SHUTDOWN",
                    ..
                }
            ));
            worker.finish.send(Ok(())).unwrap();
            assert!(owner.has_worker(), "quarantine retains the terminal handle");
        }
    }

    #[test]
    fn unexpected_post_ready_exit_is_terminal_with_worker_diagnostics() {
        let harness = Harness::new();
        let (cancel_tx, _cancel_rx) = oneshot::channel();
        {
            let mut inner = harness.controller.shared.inner.lock().unwrap();
            inner.last_generation = 1;
            inner.state = State::Running(Running {
                options: options(1, "/private/a"),
                cancel: Arc::new(Mutex::new(Some(cancel_tx))),
                lifecycle: Arc::new(WorkerLifecycle::new()),
                port: 19050,
            });
        }
        finish_worker(
            &harness.controller.shared,
            1,
            ShutdownObservation {
                result: Err(ServiceError::new("ERR_ARTI_BOOTSTRAP", "tor loop crashed")),
                quarantine: None,
            },
        );

        let (done, _rx) = completion();
        let error = harness
            .controller
            .start(options(2, "/private/a"), done)
            .unwrap_err();
        assert_eq!(error.code, "ERR_ARTI_SHUTDOWN");
        assert!(error.message.contains("ERR_ARTI_BOOTSTRAP"));
        assert!(error.message.contains("tor loop crashed"));
    }

    #[test]
    fn poisoned_state_mutex_becomes_stable_terminal_shutdown() {
        let harness = Harness::new();
        let shared = harness.controller.shared.clone();
        let _ = thread::spawn(move || {
            let _guard = shared.inner.lock().unwrap();
            panic!("poison state")
        })
        .join();

        for generation in [1, 2] {
            let (done, _rx) = completion();
            assert_eq!(
                harness
                    .controller
                    .start(options(generation, "/private/a"), done)
                    .unwrap_err()
                    .code,
                "ERR_ARTI_SHUTDOWN"
            );
        }
    }

    #[test]
    fn poisoning_running_state_cancels_the_owned_worker() {
        let harness = Harness::new();
        let (done, running) = completion();
        harness
            .controller
            .start(options(1, "/private/a"), done)
            .unwrap();
        let worker = harness.worker();
        harness.decisions.send(GateDecision::Ready).unwrap();
        worker.ready.send(Ok(19050)).unwrap();
        assert!(matches!(recv(&running), ServiceEvent::Running { .. }));

        let shared = harness.controller.shared.clone();
        let _ = thread::spawn(move || {
            let _guard = shared.inner.lock().unwrap();
            panic!("poison running state")
        })
        .join();
        let (done, _rx) = completion();
        assert_eq!(
            harness
                .controller
                .start(options(2, "/private/a"), done)
                .unwrap_err()
                .code,
            "ERR_ARTI_SHUTDOWN"
        );
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        worker.finish.send(Ok(())).unwrap();
    }

    #[test]
    fn maximum_generation_is_rejected_synchronously() {
        let harness = Harness::new();
        let (done, _rx) = completion();
        assert_eq!(
            harness
                .controller
                .start(options(u64::MAX, "/private/a"), done)
                .unwrap_err()
                .code,
            "ERR_ARTI_CONFIG"
        );
        assert_eq!(harness.spawn_count.load(Ordering::SeqCst), 0);
    }
}
