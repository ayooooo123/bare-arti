use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::ptr;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

#[cfg(not(test))]
use bare_arti::service::production_worker_factory;
use bare_arti::service::{
    ProductionStartupGate, ServiceController, ServiceError, ServiceEvent, ServiceOptions,
};

pub const BARE_ARTI_STATUS_OK: i32 = 0;
pub const BARE_ARTI_STATUS_INVALID: i32 = 1;
pub const BARE_ARTI_STATUS_REJECTED: i32 = 2;
pub const BARE_ARTI_STATUS_SHUTDOWN: i32 = 3;

const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 1_800_000;

#[repr(C)]
pub struct BareArtiOptions {
    pub data_dir: *const c_char,
    pub timeout_ms: u64,
    pub generation: u64,
}

#[repr(C)]
pub struct BareArtiResult {
    pub generation: u64,
    pub port: u16,
    pub error_code: *const c_char,
    pub error_message: *const c_char,
}

pub type BareArtiCompletion =
    Option<unsafe extern "C" fn(context: *mut c_void, result: *const BareArtiResult)>;

unsafe fn copy_options(options: *const BareArtiOptions) -> Result<ServiceOptions, ()> {
    let options = options.as_ref().ok_or(())?;
    if options.data_dir.is_null()
        || !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&options.timeout_ms)
        || options.generation == 0
        || options.generation == u64::MAX
    {
        return Err(());
    }
    let data_dir = CStr::from_ptr(options.data_dir).to_str().map_err(|_| ())?;
    let data_dir = PathBuf::from(data_dir);
    if !data_dir.is_absolute() {
        return Err(());
    }
    Ok(ServiceOptions {
        data_dir,
        timeout: Duration::from_millis(options.timeout_ms),
        generation: options.generation,
    })
}

#[derive(Default)]
struct RequestState {
    active_generation: Option<u64>,
    start_pending: bool,
    stop_pending: bool,
}

struct AbiService {
    controller: ServiceController,
    requests: Mutex<RequestState>,
}

fn service() -> &'static AbiService {
    static SERVICE: OnceLock<AbiService> = OnceLock::new();
    SERVICE.get_or_init(|| AbiService {
        controller: ServiceController::new(
            worker_factory(),
            std::sync::Arc::new(ProductionStartupGate),
        ),
        requests: Mutex::new(RequestState::default()),
    })
}

#[cfg(not(test))]
fn worker_factory() -> std::sync::Arc<dyn bare_arti::service::WorkerFactory> {
    production_worker_factory()
}

#[cfg(test)]
fn worker_factory() -> std::sync::Arc<dyn bare_arti::service::WorkerFactory> {
    std::sync::Arc::new(TestWorkerFactory)
}

fn status_for(error: &ServiceError) -> i32 {
    if error.code == "ERR_ARTI_SHUTDOWN" {
        BARE_ARTI_STATUS_SHUTDOWN
    } else {
        BARE_ARTI_STATUS_REJECTED
    }
}

fn c_string(value: &str) -> CString {
    CString::new(value).unwrap_or_else(|_| {
        CString::new(value.replace('\0', "�")).expect("replacement contains no NUL")
    })
}

fn invoke(
    callback: unsafe extern "C" fn(*mut c_void, *const BareArtiResult),
    context: usize,
    event: ServiceEvent,
) {
    let generation = match &event {
        ServiceEvent::Running { generation, .. }
        | ServiceEvent::Failed { generation, .. }
        | ServiceEvent::Stopped { generation } => *generation,
    };
    let (port, code, message) = match event {
        ServiceEvent::Running { port, .. } => (port, None, None),
        ServiceEvent::Stopped { .. } => (0, None, None),
        ServiceEvent::Failed { code, message, .. } => {
            (0, Some(c_string(code)), Some(c_string(&message)))
        }
    };
    let result = BareArtiResult {
        generation,
        port,
        error_code: code.as_ref().map_or(ptr::null(), |value| value.as_ptr()),
        error_message: message.as_ref().map_or(ptr::null(), |value| value.as_ptr()),
    };
    unsafe { callback(context as *mut c_void, &result) };
}

fn invoke_safely(
    callback: unsafe extern "C" fn(*mut c_void, *const BareArtiResult),
    context: usize,
    event: ServiceEvent,
) {
    let generation = match &event {
        ServiceEvent::Running { generation, .. }
        | ServiceEvent::Failed { generation, .. }
        | ServiceEvent::Stopped { generation } => *generation,
    };
    if catch_unwind(AssertUnwindSafe(|| invoke(callback, context, event))).is_err() {
        static CODE: &[u8] = b"ERR_ARTI_SHUTDOWN\0";
        static MESSAGE: &[u8] = b"native completion panicked\0";
        let result = BareArtiResult {
            generation,
            port: 0,
            error_code: CODE.as_ptr().cast(),
            error_message: MESSAGE.as_ptr().cast(),
        };
        unsafe { callback(context as *mut c_void, &result) };
    }
}

fn start_impl(
    options: *const BareArtiOptions,
    callback: BareArtiCompletion,
    context: *mut c_void,
) -> i32 {
    let Some(callback) = callback else {
        return BARE_ARTI_STATUS_INVALID;
    };
    let options = match unsafe { copy_options(options) } {
        Ok(options) => options,
        Err(()) => return BARE_ARTI_STATUS_INVALID,
    };
    let generation = options.generation;
    let service = service();
    {
        let Ok(mut state) = service.requests.lock() else {
            return BARE_ARTI_STATUS_SHUTDOWN;
        };
        if state.active_generation.is_some() {
            return BARE_ARTI_STATUS_REJECTED;
        }
        state.active_generation = Some(generation);
        state.start_pending = true;
    }
    let context = context as usize;
    let completion = Box::new(move |event: ServiceEvent| {
        if let Ok(mut state) = service.requests.lock() {
            state.start_pending = false;
            if matches!(event, ServiceEvent::Failed { .. }) {
                state.active_generation = None;
            }
        }
        invoke_safely(callback, context, event);
    });
    match service.controller.start(options, completion) {
        Ok(()) => BARE_ARTI_STATUS_OK,
        Err(error) => {
            if let Ok(mut state) = service.requests.lock() {
                if state.active_generation == Some(generation) {
                    state.active_generation = None;
                    state.start_pending = false;
                }
            }
            status_for(&error)
        }
    }
}

fn stop_impl(generation: u64, callback: BareArtiCompletion, context: *mut c_void) -> i32 {
    let Some(callback) = callback else {
        return BARE_ARTI_STATUS_INVALID;
    };
    if generation == 0 || generation == u64::MAX {
        return BARE_ARTI_STATUS_INVALID;
    }
    let service = service();
    {
        let Ok(mut state) = service.requests.lock() else {
            return BARE_ARTI_STATUS_SHUTDOWN;
        };
        if state.active_generation != Some(generation) || state.stop_pending {
            return BARE_ARTI_STATUS_REJECTED;
        }
        state.stop_pending = true;
    }
    let context = context as usize;
    let completion = Box::new(move |event: ServiceEvent| {
        if let Ok(mut state) = service.requests.lock() {
            if state.active_generation == Some(generation) {
                state.active_generation = None;
                state.start_pending = false;
                state.stop_pending = false;
            }
        }
        invoke_safely(callback, context, event);
    });
    match service.controller.stop(generation, completion) {
        Ok(()) => BARE_ARTI_STATUS_OK,
        Err(error) => {
            if let Ok(mut state) = service.requests.lock() {
                state.stop_pending = false;
            }
            status_for(&error)
        }
    }
}

#[no_mangle]
pub extern "C" fn bare_arti_start(
    options: *const BareArtiOptions,
    callback: BareArtiCompletion,
    context: *mut c_void,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| start_impl(options, callback, context)))
        .unwrap_or(BARE_ARTI_STATUS_SHUTDOWN)
}

#[no_mangle]
pub extern "C" fn bare_arti_stop(
    generation: u64,
    callback: BareArtiCompletion,
    context: *mut c_void,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        stop_impl(generation, callback, context)
    }))
    .unwrap_or(BARE_ARTI_STATUS_SHUTDOWN)
}

#[cfg(test)]
struct TestWorkerFactory;

#[cfg(test)]
impl bare_arti::service::WorkerFactory for TestWorkerFactory {
    fn spawn(
        &self,
        options: ServiceOptions,
        cancel: tokio::sync::oneshot::Receiver<()>,
        ready: std::sync::mpsc::SyncSender<Result<u16, ServiceError>>,
    ) -> Result<std::thread::JoinHandle<Result<(), ServiceError>>, ServiceError> {
        std::thread::Builder::new()
            .name("bare-arti-abi-test-worker".into())
            .spawn(move || {
                if options
                    .data_dir
                    .to_string_lossy()
                    .contains("fail-bootstrap")
                {
                    let error = ServiceError::new("ERR_ARTI_BOOTSTRAP", "test bootstrap failure");
                    let _ = ready.send(Err(error.clone()));
                    return Err(error);
                }
                let _ = ready.send(Ok(19_050));
                let _ = cancel.blocking_recv();
                Ok(())
            })
            .map_err(|error| ServiceError::new("ERR_ARTI_BOOTSTRAP", error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;

    #[derive(Debug, Eq, PartialEq)]
    struct OwnedResult {
        generation: u64,
        port: u16,
        code: Option<String>,
        message: Option<String>,
        callback_thread: std::thread::ThreadId,
    }

    static ABI_TEST: Mutex<()> = Mutex::new(());
    static NEXT_GENERATION: AtomicU64 = AtomicU64::new(100);

    fn next_generation() -> u64 {
        NEXT_GENERATION.fetch_add(1, Ordering::Relaxed)
    }

    unsafe extern "C" fn collect(context: *mut c_void, result: *const BareArtiResult) {
        let sender = &*(context as *const mpsc::Sender<OwnedResult>);
        let result = &*result;
        let copy = |value: *const c_char| {
            (!value.is_null()).then(|| CStr::from_ptr(value).to_string_lossy().into_owned())
        };
        sender
            .send(OwnedResult {
                generation: result.generation,
                port: result.port,
                code: copy(result.error_code),
                message: copy(result.error_message),
                callback_thread: std::thread::current().id(),
            })
            .unwrap();
    }

    fn options(path: &CString, generation: u64) -> BareArtiOptions {
        BareArtiOptions {
            data_dir: path.as_ptr(),
            timeout_ms: 30_000,
            generation,
        }
    }

    #[test]
    fn copies_options_before_the_caller_buffer_changes_or_drops() {
        let mut caller = CString::new("/private/arti-a")
            .unwrap()
            .into_bytes_with_nul();
        let raw = BareArtiOptions {
            data_dir: caller.as_ptr().cast(),
            timeout_ms: 42_000,
            generation: 41,
        };
        let owned = unsafe { copy_options(&raw) }.unwrap();
        caller[14] = b'b';
        drop(caller);
        assert_eq!(owned.data_dir, PathBuf::from("/private/arti-a"));
        assert_eq!(owned.timeout, Duration::from_millis(42_000));
        assert_eq!(owned.generation, 41);
    }

    #[test]
    fn rejects_invalid_pointers_values_and_missing_callbacks_synchronously() {
        let path = CString::new("/private/arti").unwrap();
        assert_eq!(
            bare_arti_start(std::ptr::null(), Some(collect), std::ptr::null_mut()),
            BARE_ARTI_STATUS_INVALID
        );
        let mut raw = options(&path, 1);
        raw.data_dir = std::ptr::null();
        assert_eq!(
            bare_arti_start(&raw, Some(collect), std::ptr::null_mut()),
            BARE_ARTI_STATUS_INVALID
        );
        raw = options(&path, 0);
        assert_eq!(
            bare_arti_start(&raw, Some(collect), std::ptr::null_mut()),
            BARE_ARTI_STATUS_INVALID
        );
        raw = options(&path, u64::MAX);
        assert_eq!(
            bare_arti_start(&raw, Some(collect), std::ptr::null_mut()),
            BARE_ARTI_STATUS_INVALID
        );
        raw = options(&path, 1);
        raw.timeout_ms = MIN_TIMEOUT_MS - 1;
        assert_eq!(
            bare_arti_start(&raw, Some(collect), std::ptr::null_mut()),
            BARE_ARTI_STATUS_INVALID
        );
        let relative = CString::new("relative/arti").unwrap();
        raw = options(&relative, 1);
        assert_eq!(
            bare_arti_start(&raw, Some(collect), std::ptr::null_mut()),
            BARE_ARTI_STATUS_INVALID
        );
        raw = options(&path, 1);
        assert_eq!(
            bare_arti_start(&raw, None, std::ptr::null_mut()),
            BARE_ARTI_STATUS_INVALID
        );
        assert_eq!(
            bare_arti_stop(0, Some(collect), std::ptr::null_mut()),
            BARE_ARTI_STATUS_INVALID
        );
        assert_eq!(
            bare_arti_stop(1, None, std::ptr::null_mut()),
            BARE_ARTI_STATUS_INVALID
        );
    }

    #[test]
    fn accepted_start_and_stop_each_complete_once_with_the_same_generation() {
        let _serial = ABI_TEST.lock().unwrap();
        let generation = next_generation();
        let path = CString::new("/private/arti").unwrap();
        let (sender, receiver) = mpsc::channel::<OwnedResult>();
        let context = (&sender as *const mpsc::Sender<OwnedResult>)
            .cast_mut()
            .cast();
        let caller_thread = std::thread::current().id();
        assert_eq!(
            bare_arti_start(&options(&path, generation), Some(collect), context),
            BARE_ARTI_STATUS_OK
        );
        let started = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(started.generation, generation);
        assert_eq!(started.port, 19_050);
        assert_eq!(started.code, None);
        assert_eq!(started.message, None);
        assert_ne!(started.callback_thread, caller_thread);
        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
        assert_eq!(
            bare_arti_stop(generation, Some(collect), context),
            BARE_ARTI_STATUS_OK
        );
        let stopped = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(stopped.generation, generation);
        assert_eq!(stopped.port, 0);
        assert_eq!(stopped.code, None);
        assert_eq!(stopped.message, None);
        assert_ne!(stopped.callback_thread, caller_thread);
        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
    }

    #[test]
    fn duplicate_start_is_rejected_without_a_second_callback() {
        let _serial = ABI_TEST.lock().unwrap();
        let generation = next_generation();
        let path = CString::new("/private/arti").unwrap();
        let (sender, receiver) = mpsc::channel::<OwnedResult>();
        let context = (&sender as *const mpsc::Sender<OwnedResult>)
            .cast_mut()
            .cast();
        let raw = options(&path, generation);
        assert_eq!(
            bare_arti_start(&raw, Some(collect), context),
            BARE_ARTI_STATUS_OK
        );
        assert_eq!(
            bare_arti_start(&raw, Some(collect), context),
            BARE_ARTI_STATUS_REJECTED
        );
        let _ = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
        assert_eq!(
            bare_arti_stop(generation, Some(collect), context),
            BARE_ARTI_STATUS_OK
        );
        let _ = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    }

    #[test]
    fn asynchronous_failures_use_stable_error_codes() {
        let _serial = ABI_TEST.lock().unwrap();
        let generation = next_generation();
        let path = CString::new("/private/fail-bootstrap").unwrap();
        let (sender, receiver) = mpsc::channel::<OwnedResult>();
        let context = (&sender as *const mpsc::Sender<OwnedResult>)
            .cast_mut()
            .cast();
        assert_eq!(
            bare_arti_start(&options(&path, generation), Some(collect), context),
            BARE_ARTI_STATUS_OK
        );
        let result = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(result.generation, generation);
        assert_eq!(result.port, 0);
        assert_eq!(result.code.as_deref(), Some("ERR_ARTI_BOOTSTRAP"));
        assert!(result.message.unwrap().contains("test bootstrap failure"));
    }
}
