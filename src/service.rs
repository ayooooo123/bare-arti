use std::fmt;
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
    ) -> JoinHandle<Result<(), ServiceError>>;
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
    start_completions: Vec<Completion>,
    stop_completions: Vec<Completion>,
    reason: ServiceError,
}

enum State {
    Stopped,
    Starting(Active),
    Running(Running),
    Stopping(Stopping),
    Failed,
}

struct Inner {
    state: State,
    last_generation: u64,
}

struct Shared {
    inner: Mutex<Inner>,
    factory: Arc<dyn WorkerFactory>,
    gate: Arc<dyn StartupGate>,
}

#[derive(Clone)]
pub struct ServiceController {
    shared: Arc<Shared>,
}

impl ServiceController {
    pub fn new(factory: Arc<dyn WorkerFactory>, gate: Arc<dyn StartupGate>) -> Self {
        Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(Inner {
                    state: State::Stopped,
                    last_generation: 0,
                }),
                factory,
                gate,
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
            let mut inner = self.shared.inner.lock().unwrap();
            match &mut inner.state {
                State::Failed => return Err(shutdown_error()),
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
                    if options.generation == 0 || options.generation <= inner.last_generation {
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
            dispatch(completion.take().unwrap(), event);
        }

        if let Some((cancel, cancel_rx, ready_tx, ready_rx)) = start_worker {
            let worker = self
                .shared
                .factory
                .spawn(options.clone(), cancel_rx, ready_tx);
            let shared = self.shared.clone();
            thread::spawn(move || supervise(shared, options, cancel, ready_rx, worker));
        }

        Ok(())
    }

    pub fn stop(&self, generation: u64, completion: Completion) -> Result<(), ServiceError> {
        let mut completion = Some(completion);
        let mut cancel = None;
        let mut stale = false;

        {
            let mut inner = self.shared.inner.lock().unwrap();
            match &mut inner.state {
                State::Failed => return Err(shutdown_error()),
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
            dispatch(
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
    let outcome = shared.gate.wait(ready, options.timeout);
    match outcome {
        StartupOutcome::Ready(Ok(port)) if port != 0 => {
            let completions = mark_running(&shared, &options, port);
            if let Some(completions) = completions {
                let event = ServiceEvent::Running {
                    generation: options.generation,
                    port,
                };
                for completion in completions {
                    completion(event.clone());
                }
            } else {
                cancel_once(&cancel);
            }
            let result = join_worker(worker);
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
    let mut inner = shared.inner.lock().unwrap();
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
        let mut inner = shared.inner.lock().unwrap();
        if let State::Starting(active) = &inner.state {
            if active.options.generation == generation {
                let active = match std::mem::replace(&mut inner.state, State::Stopped) {
                    State::Starting(active) => active,
                    _ => unreachable!(),
                };
                inner.state = State::Stopping(Stopping {
                    generation,
                    start_completions: active.start_completions,
                    stop_completions: Vec::new(),
                    reason,
                });
            }
        }
    }

    cancel_once(cancel);
    let result = join_worker(worker);
    finish_worker(shared, generation, result);
}

fn join_worker(worker: JoinHandle<Result<(), ServiceError>>) -> Result<(), ServiceError> {
    match worker.join() {
        Ok(result) => result,
        Err(_) => Err(ServiceError::new(
            "ERR_ARTI_SHUTDOWN",
            "Arti worker thread panicked",
        )),
    }
}

fn finish_worker(shared: &Arc<Shared>, generation: u64, worker_result: Result<(), ServiceError>) {
    let (start_completions, stop_completions, start_event, stop_event) = {
        let mut inner = shared.inner.lock().unwrap();
        match std::mem::replace(&mut inner.state, State::Stopped) {
            State::Stopping(stopping) if stopping.generation == generation => {
                let terminal = worker_result
                    .err()
                    .filter(|error| error.code == "ERR_ARTI_SHUTDOWN");
                if let Some(error) = terminal {
                    let event = failed_event(generation, &error);
                    inner.state = State::Failed;
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
                inner.state = State::Failed;
                let error = worker_result.err().unwrap_or_else(|| {
                    ServiceError::new("ERR_ARTI_SHUTDOWN", "Arti worker exited unexpectedly")
                });
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
        completion(start_event.clone());
    }
    for completion in stop_completions {
        completion(stop_event.clone());
    }
}

fn cancel_once(cancel: &CancelSender) {
    let sender = cancel.lock().unwrap().take();
    if let Some(sender) = sender {
        let _ = sender.send(());
    }
}

fn dispatch(completion: Completion, event: ServiceEvent) {
    thread::spawn(move || completion(event));
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

fn shutdown_error() -> ServiceError {
    ServiceError::new("ERR_ARTI_SHUTDOWN", "Arti service is in a failed state")
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
        ) -> thread::JoinHandle<Result<(), ServiceError>> {
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

            thread::spawn(move || {
                let _ = cancel.blocking_recv();
                let _ = cancelled_tx.send(());
                finish_rx.recv().unwrap_or(Ok(()))
            })
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
}
