use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tokio::sync::oneshot;

pub type Completion = Box<dyn FnOnce(ServiceEvent) + Send + 'static>;

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
    ) -> Result<JoinHandle<Result<(), ServiceError>>, ServiceError>;
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShutdownOutcome {
    Exited(Result<(), ServiceError>),
    Timeout,
}

pub trait ShutdownGate: Send + Sync {
    fn wait(
        &self,
        worker: JoinHandle<Result<(), ServiceError>>,
        duration: Duration,
    ) -> ShutdownOutcome;
}

pub struct ProductionShutdownGate;

impl ShutdownGate for ProductionShutdownGate {
    fn wait(
        &self,
        worker: JoinHandle<Result<(), ServiceError>>,
        duration: Duration,
    ) -> ShutdownOutcome {
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let reaper = thread::Builder::new()
            .name("bare-arti-worker-reaper".into())
            .spawn(move || {
                let result = match worker.join() {
                    Ok(result) => result,
                    Err(_) => Err(ServiceError::new(
                        "ERR_ARTI_SHUTDOWN",
                        "Arti worker thread panicked",
                    )),
                };
                let _ = result_tx.send(result);
            });
        if reaper.is_err() {
            return ShutdownOutcome::Timeout;
        }
        match result_rx.recv_timeout(duration) {
            Ok(result) => ShutdownOutcome::Exited(result),
            Err(_) => ShutdownOutcome::Timeout,
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
                    safe_task(task);
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

type CancelSender = Arc<Mutex<Option<oneshot::Sender<()>>>>;

struct Active {
    options: ServiceOptions,
    cancel: CancelSender,
    start_completions: Vec<Completion>,
}

struct Running {
    options: ServiceOptions,
    cancel: CancelSender,
    port: u16,
}

struct Stopping {
    generation: u64,
    was_running: bool,
    start_completions: Vec<Completion>,
    stop_completions: Vec<Completion>,
    reason: ServiceError,
}

enum State {
    Stopped,
    Starting(Active),
    Running(Running),
    Stopping(Stopping),
    Failed(ServiceError),
}

struct Inner {
    state: State,
    last_generation: u64,
}

struct Shared {
    inner: Mutex<Inner>,
    factory: Arc<dyn WorkerFactory>,
    gate: Arc<dyn StartupGate>,
    shutdown_gate: Arc<dyn ShutdownGate>,
    supervisor_spawner: Arc<dyn SupervisorSpawner>,
}

#[derive(Clone)]
pub struct ServiceController {
    shared: Arc<Shared>,
}

impl ServiceController {
    pub fn new(factory: Arc<dyn WorkerFactory>, gate: Arc<dyn StartupGate>) -> Self {
        Self::with_shutdown_gate(factory, gate, Arc::new(ProductionShutdownGate))
    }

    pub fn with_shutdown_gate(
        factory: Arc<dyn WorkerFactory>,
        gate: Arc<dyn StartupGate>,
        shutdown_gate: Arc<dyn ShutdownGate>,
    ) -> Self {
        Self::with_dependencies(
            factory,
            gate,
            shutdown_gate,
            Arc::new(ProductionSupervisorSpawner),
        )
    }

    fn with_dependencies(
        factory: Arc<dyn WorkerFactory>,
        gate: Arc<dyn StartupGate>,
        shutdown_gate: Arc<dyn ShutdownGate>,
        supervisor_spawner: Arc<dyn SupervisorSpawner>,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(Inner {
                    state: State::Stopped,
                    last_generation: 0,
                }),
                factory,
                gate,
                shutdown_gate,
                supervisor_spawner,
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
        let mut start_worker = None;

        {
            let mut inner = lock_inner(&self.shared)?;
            match &mut inner.state {
                State::Failed(error) => return Err(error.clone()),
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
                    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
                    inner.state = State::Starting(Active {
                        options: options.clone(),
                        cancel: cancel.clone(),
                        start_completions: vec![completion.take().unwrap()],
                    });
                    start_worker = Some((cancel, cancel_rx, ready_tx, ready_rx));
                }
            }
        }

        if let Some(event) = running_event {
            safe_completion(completion.take().unwrap(), event);
        }

        if let Some((cancel, cancel_rx, ready_tx, ready_rx)) = start_worker {
            let spawned = catch_unwind(AssertUnwindSafe(|| {
                self.shared
                    .factory
                    .spawn(options.clone(), cancel_rx, ready_tx)
            }));
            let worker = match spawned {
                Ok(Ok(worker)) => worker,
                Ok(Err(error)) => {
                    finish_creation_failure(&self.shared, options.generation, error, false);
                    return Ok(());
                }
                Err(_) => {
                    finish_creation_failure(
                        &self.shared,
                        options.generation,
                        ServiceError::new("ERR_ARTI_BOOTSTRAP", "worker factory panicked"),
                        false,
                    );
                    return Ok(());
                }
            };
            let generation = options.generation;
            let shared = self.shared.clone();
            let task: SupervisorTask =
                Box::new(move || supervise(shared, options, cancel, ready_rx, worker));
            match catch_unwind(AssertUnwindSafe(|| {
                self.shared.supervisor_spawner.spawn(task)
            })) {
                Ok(Ok(())) => {}
                Ok(Err(failure)) => {
                    cancel_current(&self.shared, generation);
                    drop(failure.task);
                    finish_creation_failure(&self.shared, generation, failure.error, true);
                }
                Err(_) => {
                    cancel_current(&self.shared, generation);
                    finish_creation_failure(
                        &self.shared,
                        generation,
                        ServiceError::new("ERR_ARTI_SHUTDOWN", "supervisor spawner panicked"),
                        true,
                    );
                }
            }
        }

        Ok(())
    }

    pub fn stop(&self, generation: u64, completion: Completion) -> Result<(), ServiceError> {
        let mut completion = Some(completion);
        let mut cancel = None;
        let mut stale = false;

        {
            let mut inner = lock_inner(&self.shared)?;
            match &mut inner.state {
                State::Failed(error) => return Err(error.clone()),
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
                        inner.state = State::Stopping(Stopping {
                            generation,
                            was_running: false,
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
                        inner.state = State::Stopping(Stopping {
                            generation,
                            was_running: true,
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
        if stale {
            safe_completion(
                completion.take().unwrap(),
                ServiceEvent::Stopped { generation },
            );
        }
        Ok(())
    }
}

fn supervise(
    shared: Arc<Shared>,
    options: ServiceOptions,
    cancel: CancelSender,
    ready: mpsc::Receiver<Result<u16, ServiceError>>,
    worker: JoinHandle<Result<(), ServiceError>>,
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
                worker,
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
                    safe_completion(completion, event.clone());
                }
            } else {
                cancel_once(&cancel);
            }
            let result = observe_shutdown(&shared, worker);
            finish_worker(&shared, options.generation, result);
        }
        StartupOutcome::Ready(Ok(_)) => {
            stop_after_startup(
                &shared,
                options.generation,
                &cancel,
                worker,
                ServiceError::new("ERR_ARTI_BIND", "worker returned an invalid SOCKS port"),
            );
        }
        StartupOutcome::Ready(Err(error)) => {
            stop_after_startup(&shared, options.generation, &cancel, worker, error);
        }
        StartupOutcome::Timeout => {
            stop_after_startup(
                &shared,
                options.generation,
                &cancel,
                worker,
                ServiceError::new("ERR_ARTI_TIMEOUT", "Arti bootstrap timed out"),
            );
        }
        StartupOutcome::WorkerExited => {
            stop_after_startup(
                &shared,
                options.generation,
                &cancel,
                worker,
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
        port,
    });
    Some(completions)
}

fn stop_after_startup(
    shared: &Arc<Shared>,
    generation: u64,
    cancel: &CancelSender,
    worker: JoinHandle<Result<(), ServiceError>>,
    reason: ServiceError,
) {
    {
        let mut inner = match lock_inner(shared) {
            Ok(inner) => inner,
            Err(_) => {
                cancel_once(cancel);
                drop(worker);
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
                    start_completions: active.start_completions,
                    stop_completions: Vec::new(),
                    reason,
                });
            }
        }
    }

    cancel_once(cancel);
    let result = observe_shutdown(shared, worker);
    finish_worker(shared, generation, result);
}

fn observe_shutdown(
    shared: &Arc<Shared>,
    worker: JoinHandle<Result<(), ServiceError>>,
) -> Result<(), ServiceError> {
    match catch_unwind(AssertUnwindSafe(|| {
        shared.shutdown_gate.wait(worker, SHUTDOWN_TIMEOUT)
    })) {
        Ok(ShutdownOutcome::Exited(result)) => result,
        Ok(ShutdownOutcome::Timeout) => Err(ServiceError::new(
            "ERR_ARTI_SHUTDOWN",
            format!(
                "Arti worker did not exit within {} milliseconds",
                SHUTDOWN_TIMEOUT.as_millis()
            ),
        )),
        Err(_) => Err(ServiceError::new(
            "ERR_ARTI_SHUTDOWN",
            "Arti shutdown observer panicked",
        )),
    }
}

fn finish_worker(shared: &Arc<Shared>, generation: u64, worker_result: Result<(), ServiceError>) {
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
                    inner.state = State::Failed(error.clone());
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
                inner.state = State::Failed(error.clone());
                let event = failed_event(generation, &error);
                (Vec::new(), Vec::new(), event.clone(), event)
            }
            state => {
                inner.state = state;
                return;
            }
        }
    };

    for completion in start_completions {
        safe_completion(completion, start_event.clone());
    }
    for completion in stop_completions {
        safe_completion(completion, stop_event.clone());
    }
}

fn cancel_once(cancel: &CancelSender) {
    let sender = cancel.lock().unwrap().take();
    if let Some(sender) = sender {
        let _ = sender.send(());
    }
}

fn safe_completion(completion: Completion, event: ServiceEvent) {
    let _ = catch_unwind(AssertUnwindSafe(|| completion(event)));
}

fn safe_task(task: SupervisorTask) {
    let _ = catch_unwind(AssertUnwindSafe(task));
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
            let state = std::mem::replace(&mut inner.state, State::Failed(terminal.clone()));
            let (generation, start_completions, stop_completions) = match state {
                State::Starting(active) => (
                    active.options.generation,
                    active.start_completions,
                    Vec::new(),
                ),
                State::Stopping(stopping) => (
                    stopping.generation,
                    stopping.start_completions,
                    stopping.stop_completions,
                ),
                state => {
                    inner.state = match state {
                        State::Failed(error) => State::Failed(error),
                        _ => State::Failed(terminal.clone()),
                    };
                    (inner.last_generation, Vec::new(), Vec::new())
                }
            };
            shared.inner.clear_poison();
            drop(inner);
            let event = failed_event(generation, &terminal);
            for completion in start_completions {
                safe_completion(completion, event.clone());
            }
            for completion in stop_completions {
                safe_completion(completion, event.clone());
            }
            Err(terminal)
        }
    }
}

fn cancel_current(shared: &Arc<Shared>, generation: u64) {
    let cancel = match lock_inner(shared) {
        Ok(inner) => match &inner.state {
            State::Starting(active) if active.options.generation == generation => {
                Some(active.cancel.clone())
            }
            _ => None,
        },
        Err(_) => None,
    };
    if let Some(cancel) = cancel {
        cancel_once(&cancel);
    }
}

fn finish_creation_failure(
    shared: &Arc<Shared>,
    generation: u64,
    error: ServiceError,
    terminal: bool,
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
            inner.state = State::Failed(error.clone());
        }
        (start_completions, stop_completions)
    };

    let failed = failed_event(generation, &error);
    for completion in start_completions {
        safe_completion(completion, failed.clone());
    }
    for completion in stop_completions {
        safe_completion(
            completion,
            if terminal {
                failed.clone()
            } else {
                ServiceEvent::Stopped { generation }
            },
        );
    }
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

    struct ImmediateShutdownTimeout;

    impl ShutdownGate for ImmediateShutdownTimeout {
        fn wait(
            &self,
            worker: thread::JoinHandle<Result<(), ServiceError>>,
            _duration: Duration,
        ) -> ShutdownOutcome {
            drop(worker);
            ShutdownOutcome::Timeout
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
    fn supervisor_spawn_failure_cancels_and_fails_terminal_once() {
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
            Arc::new(ProductionShutdownGate),
            Arc::new(FailingSupervisorSpawner),
        );
        drop(decision_tx);
        let (done, failed) = completion();
        controller.start(options(1, "/private/a"), done).unwrap();
        let worker = spawned.recv_timeout(Duration::from_secs(1)).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(matches!(
            recv(&failed),
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
    fn supervisor_spawner_panic_cancels_and_fails_terminal() {
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
            Arc::new(ProductionShutdownGate),
            Arc::new(PanickingSupervisorSpawner),
        );
        drop(decision_tx);
        let (done, failed) = completion();
        controller.start(options(1, "/private/a"), done).unwrap();
        let worker = spawned.recv_timeout(Duration::from_secs(1)).unwrap();
        worker
            .cancelled
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(matches!(
            recv(&failed),
            ServiceEvent::Failed {
                code: "ERR_ARTI_SHUTDOWN",
                ..
            }
        ));
        worker.finish.send(Ok(())).unwrap();
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
        let first_tx = order_tx.clone();
        harness
            .controller
            .start(
                options(1, "/private/a"),
                Box::new(move |_| {
                    first_tx.send(1).unwrap();
                    panic!("consumer callback panic")
                }),
            )
            .unwrap();
        let worker = harness.worker();
        harness
            .controller
            .start(
                options(1, "/private/a"),
                Box::new(move |_| order_tx.send(2).unwrap()),
            )
            .unwrap();
        harness.decisions.send(GateDecision::Ready).unwrap();
        worker.ready.send(Ok(19050)).unwrap();
        assert_eq!(order.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        assert_eq!(order.recv_timeout(Duration::from_secs(1)).unwrap(), 2);
        stop_running(&harness, worker, 1);
    }

    #[test]
    fn shutdown_observation_timeout_is_terminal_without_waiting_for_worker() {
        let (decision_tx, decision_rx) = mpsc::channel();
        let (spawned_tx, spawned) = mpsc::channel();
        let controller = ServiceController::with_shutdown_gate(
            Arc::new(ControlledFactory {
                spawned: spawned_tx,
                spawn_count: Arc::new(AtomicUsize::new(0)),
            }),
            Arc::new(ManualGate {
                decisions: Mutex::new(decision_rx),
            }),
            Arc::new(ImmediateShutdownTimeout),
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
    fn unexpected_post_ready_exit_is_terminal_with_worker_diagnostics() {
        let harness = Harness::new();
        let (cancel_tx, _cancel_rx) = oneshot::channel();
        {
            let mut inner = harness.controller.shared.inner.lock().unwrap();
            inner.last_generation = 1;
            inner.state = State::Running(Running {
                options: options(1, "/private/a"),
                cancel: Arc::new(Mutex::new(Some(cancel_tx))),
                port: 19050,
            });
        }
        finish_worker(
            &harness.controller.shared,
            1,
            Err(ServiceError::new("ERR_ARTI_BOOTSTRAP", "tor loop crashed")),
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
