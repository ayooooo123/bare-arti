#include <assert.h>
#include <bare.h>
#include <js.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <utf.h>
#include <uv.h>

enum {
  BARE_ARTI_STATUS_OK = 0,
  BARE_ARTI_STATUS_INVALID = 1,
  BARE_ARTI_STATUS_REJECTED = 2,
  BARE_ARTI_STATUS_SHUTDOWN = 3
};

typedef struct {
  const char *data_dir;
  const char *reachable_addresses;
  uint64_t timeout_ms;
  uint64_t generation;
} bare_arti_options_t;

typedef struct {
  uint64_t generation;
  uint16_t port;
  const char *error_code;
  const char *error_message;
} bare_arti_result_t;

typedef void (*bare_arti_completion_t)(void *, const bare_arti_result_t *);

extern int bare_arti_start(
  const bare_arti_options_t *options,
  bare_arti_completion_t callback,
  void *context
);
extern int bare_arti_stop(
  uint64_t generation,
  bare_arti_completion_t callback,
  void *context
);
#ifdef BARE_ARTI_TESTING
extern int bare_arti_enable_test_mode(void);
#endif

typedef struct bare_arti_realm_s bare_arti_realm_t;
typedef struct bare_arti_request_s bare_arti_request_t;

typedef enum {
  bare_arti_request_start,
  bare_arti_request_stop
} bare_arti_request_kind_t;

struct bare_arti_realm_s {
  js_env_t *env;
  js_deferred_teardown_t *teardown;
  js_threadsafe_function_t *finish_tsfn;
  uint64_t generation;
  bare_arti_request_t *start;
  bare_arti_request_t *stop;
  size_t pending;
  bool exiting;
  bool terminal;
};

struct bare_arti_request_s {
  bare_arti_realm_t *realm;
  bare_arti_request_kind_t kind;
  uint64_t generation;
  js_deferred_t *deferred;
  js_threadsafe_function_t *tsfn;
  atomic_uint references;
  atomic_bool completed;
  atomic_bool aborted;
  uint16_t port;
  char code[64];
  char message[512];
};

static uv_once_t bare_arti_once = UV_ONCE_INIT;
static uv_mutex_t bare_arti_mutex;
static bare_arti_realm_t *bare_arti_owner = NULL;

#ifdef BARE_ARTI_TESTING
static atomic_uint_fast64_t bare_arti_allocations = 0;
static atomic_uint_fast64_t bare_arti_frees = 0;
static atomic_uint_fast64_t bare_arti_completions = 0;
static atomic_uint_fast64_t bare_arti_duplicates = 0;
static atomic_uint_fast64_t bare_arti_late = 0;
static atomic_uint_fast64_t bare_arti_js_after_abort = 0;
#endif

static void
bare_arti_init(void) {
  int err = uv_mutex_init(&bare_arti_mutex);
  assert(err == 0);
}

static void
bare_arti_lock(void) {
  uv_once(&bare_arti_once, bare_arti_init);
  uv_mutex_lock(&bare_arti_mutex);
}

static void
bare_arti_unlock(void) {
  uv_mutex_unlock(&bare_arti_mutex);
}

static void
bare_arti_copy(char *target, size_t capacity, const char *source) {
  if (source == NULL) {
    target[0] = '\0';
    return;
  }
  size_t len = strlen(source);
  if (len >= capacity) len = capacity - 1;
  memcpy(target, source, len);
  target[len] = '\0';
}

static void
bare_arti_finish_realm_if_ready(bare_arti_realm_t *realm) {
  js_deferred_teardown_t *teardown = NULL;

  bare_arti_lock();
  if (realm->exiting && realm->terminal && realm->pending == 0) {
    if (bare_arti_owner == realm) bare_arti_owner = NULL;
    teardown = realm->teardown;
    realm->teardown = NULL;
  }
  bare_arti_unlock();

  if (teardown != NULL) {
    int err = js_release_threadsafe_function(
      realm->finish_tsfn,
      js_threadsafe_function_release
    );
    assert(err == 0);
    err = js_finish_deferred_teardown_callback(teardown);
    assert(err == 0);
  }
}

static void
bare_arti_realm_finalize(js_env_t *env, void *data, void *hint) {
  free(data);
}

static void
bare_arti_on_realm_finish(
  js_env_t *env,
  js_value_t *function,
  void *context,
  void *data
) {
  bare_arti_finish_realm_if_ready(context);
}

static void
bare_arti_request_release(bare_arti_request_t *request, bool native_thread) {
  if (atomic_fetch_sub(&request->references, 1) != 1) return;
  bare_arti_realm_t *realm = request->realm;
  int notify_err = 0;

  bare_arti_lock();
  assert(realm->pending > 0);
  realm->pending--;
  if (realm->start == request) realm->start = NULL;
  if (realm->stop == request) {
    realm->stop = NULL;
    realm->generation = 0;
  }
  if (native_thread && realm->exiting) {
    notify_err = js_call_threadsafe_function(
      realm->finish_tsfn,
      realm,
      js_threadsafe_function_nonblocking
    );
  }
  bare_arti_unlock();

#ifdef BARE_ARTI_TESTING
  atomic_fetch_add(&bare_arti_frees, 1);
#endif
  free(request);
  if (native_thread) {
    assert(notify_err == 0);
  } else {
    bare_arti_finish_realm_if_ready(realm);
  }
}

static void
bare_arti_request_finalize(js_env_t *env, void *data, void *hint) {
  bare_arti_request_release(data, false);
}

static int
bare_arti_create_error(
  js_env_t *env,
  const char *code_text,
  const char *message_text,
  js_value_t **result
) {
  js_value_t *code;
  int err = js_create_string_utf8(env, (const utf8_t *) code_text, -1, &code);
  if (err < 0) return err;
  js_value_t *message;
  err = js_create_string_utf8(env, (const utf8_t *) message_text, -1, &message);
  if (err < 0) return err;
  return js_create_error(env, code, message, result);
}

static void
bare_arti_on_js_result(
  js_env_t *env,
  js_value_t *function,
  void *context,
  void *data
) {
  bare_arti_request_t *request = context;
  bare_arti_realm_t *realm = request->realm;
  bool aborted = atomic_load(&request->aborted);

  bare_arti_lock();
  if (request->kind == bare_arti_request_start && realm->start == request) {
    realm->start = NULL;
    if (request->code[0] != '\0' && realm->stop == NULL) realm->generation = 0;
  } else if (request->kind == bare_arti_request_stop && realm->stop == request) {
    realm->stop = NULL;
    realm->generation = 0;
  }
  bare_arti_unlock();

  if (!aborted) {
    int err;
    if (request->code[0] != '\0') {
      js_value_t *error;
      err = bare_arti_create_error(env, request->code, request->message, &error);
      assert(err == 0);
      err = js_reject_deferred(env, request->deferred, error);
      assert(err == 0);
    } else if (request->kind == bare_arti_request_start) {
      js_value_t *result;
      err = js_create_object(env, &result);
      assert(err == 0);
      js_value_t *port;
      err = js_create_uint32(env, request->port, &port);
      assert(err == 0);
      err = js_set_named_property(env, result, "port", port);
      assert(err == 0);
      err = js_resolve_deferred(env, request->deferred, result);
      assert(err == 0);
    } else {
      js_value_t *undefined;
      err = js_get_undefined(env, &undefined);
      assert(err == 0);
      err = js_resolve_deferred(env, request->deferred, undefined);
      assert(err == 0);
    }
#ifdef BARE_ARTI_TESTING
    atomic_fetch_add(&bare_arti_completions, 1);
#endif
  } else {
#ifdef BARE_ARTI_TESTING
    atomic_fetch_add(&bare_arti_js_after_abort, 1);
#endif
  }
}

static void
bare_arti_on_native_result(void *context, const bare_arti_result_t *result) {
  bare_arti_request_t *request = context;

  bare_arti_lock();
  bare_arti_realm_t *realm = bare_arti_owner;
  bool active = realm != NULL &&
                (realm->start == request || realm->stop == request);
  if (!active || request->generation != result->generation) {
    bare_arti_unlock();
#ifdef BARE_ARTI_TESTING
    atomic_fetch_add(&bare_arti_duplicates, 1);
#endif
    return;
  }
  if (atomic_exchange(&request->completed, true)) {
    bare_arti_unlock();
#ifdef BARE_ARTI_TESTING
    atomic_fetch_add(&bare_arti_duplicates, 1);
#endif
    return;
  }

  request->port = result->port;
  bare_arti_copy(request->code, sizeof(request->code), result->error_code);
  bare_arti_copy(request->message, sizeof(request->message), result->error_message);

  if (request->kind == bare_arti_request_stop && realm->exiting) {
    realm->terminal = true;
  }

  bool aborted = atomic_load(&request->aborted);
  int err = 0;
  if (!aborted) {
    err = js_call_threadsafe_function(
      request->tsfn,
      request,
      js_threadsafe_function_nonblocking
    );
    int release_err = js_release_threadsafe_function(
      request->tsfn,
      js_threadsafe_function_release
    );
    assert(release_err == 0);
  } else {
#ifdef BARE_ARTI_TESTING
    atomic_fetch_add(&bare_arti_late, 1);
#endif
  }
  bare_arti_unlock();
  if (err < 0) {
#ifdef BARE_ARTI_TESTING
    atomic_fetch_add(&bare_arti_late, 1);
#endif
  }
  bare_arti_request_release(request, true);
}

static bare_arti_request_t *
bare_arti_request_create(
  js_env_t *env,
  bare_arti_realm_t *realm,
  bare_arti_request_kind_t kind,
  uint64_t generation,
  js_value_t **promise
) {
  bare_arti_request_t *request = calloc(1, sizeof(*request));
  if (request == NULL) return NULL;
  request->realm = realm;
  request->kind = kind;
  request->generation = generation;
  atomic_init(&request->references, 2);
  atomic_init(&request->completed, false);
  atomic_init(&request->aborted, false);

  int err = js_create_promise(env, &request->deferred, promise);
  if (err < 0) {
    free(request);
    return NULL;
  }
  err = js_create_threadsafe_function(
    env,
    NULL,
    0,
    1,
    bare_arti_request_finalize,
    NULL,
    request,
    bare_arti_on_js_result,
    &request->tsfn
  );
  if (err < 0) {
    free(request);
    return NULL;
  }
  bare_arti_lock();
  realm->pending++;
  bare_arti_unlock();
#ifdef BARE_ARTI_TESTING
  atomic_fetch_add(&bare_arti_allocations, 1);
#endif
  return request;
}

static void
bare_arti_abort_request(bare_arti_request_t *request) {
  if (request == NULL) return;
  bare_arti_lock();
  bool abort = !atomic_exchange(&request->aborted, true) &&
               !atomic_load(&request->completed);
  bare_arti_unlock();
  if (!abort) return;
  int err = js_release_threadsafe_function(
    request->tsfn,
    js_threadsafe_function_abort
  );
  assert(err == 0);
}

static void
bare_arti_reject_unaccepted_request(bare_arti_request_t *request) {
  if (request == NULL || atomic_exchange(&request->aborted, true)) return;
  int err = js_release_threadsafe_function(
    request->tsfn,
    js_threadsafe_function_abort
  );
  assert(err == 0);
  bare_arti_request_release(request, false);
}

static void
bare_arti_on_teardown_stop(void *context, const bare_arti_result_t *result) {
  bare_arti_realm_t *realm = context;
  bare_arti_lock();
  realm->generation = 0;
  realm->terminal = true;
  int err = js_call_threadsafe_function(
    realm->finish_tsfn,
    realm,
    js_threadsafe_function_nonblocking
  );
  bare_arti_unlock();
  assert(err == 0);
}

static void
bare_arti_on_teardown(js_deferred_teardown_t *handle, void *data) {
  bare_arti_realm_t *realm = data;
  uint64_t generation;
  bool has_stop;

  bare_arti_lock();
  realm->exiting = true;
  generation = realm->generation;
  has_stop = realm->stop != NULL;
  bare_arti_request_t *start = realm->start;
  bare_arti_request_t *stop = realm->stop;
  if (generation == 0) realm->terminal = true;
  bare_arti_unlock();

  bare_arti_abort_request(start);
  bare_arti_abort_request(stop);

  if (generation != 0 && !has_stop) {
    int status = bare_arti_stop(generation, bare_arti_on_teardown_stop, realm);
    if (status != BARE_ARTI_STATUS_OK) {
      bare_arti_lock();
      realm->generation = 0;
      realm->terminal = true;
      bare_arti_unlock();
    }
  }
  bare_arti_finish_realm_if_ready(realm);
}

static bool
bare_arti_get_generation(js_env_t *env, js_value_t *value, uint64_t *result) {
  double generation;
  int err = js_get_value_double(env, value, &generation);
  if (err < 0 || generation < 1 || generation >= 9007199254740991.0) return false;
  uint64_t integer = (uint64_t) generation;
  if ((double) integer != generation) return false;
  *result = integer;
  return true;
}

static char *
bare_arti_get_string(js_env_t *env, js_value_t *value) {
  size_t len;
  int err = js_get_value_string_utf8(env, value, NULL, 0, &len);
  if (err < 0) return NULL;
  char *result = malloc(len + 1);
  if (result == NULL) return NULL;
  err = js_get_value_string_utf8(env, value, (utf8_t *) result, len + 1, NULL);
  if (err < 0) {
    free(result);
    return NULL;
  }
  return result;
}

static js_value_t *
bare_arti_start_raw(js_env_t *env, js_callback_info_t *info) {
  size_t argc = 2;
  js_value_t *argv[2];
  int err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);
  if (argc != 2) {
    js_throw_type_error(env, "ERR_ARTI_CONFIG", "start(options, generation) requires two arguments");
    return NULL;
  }

  js_value_t *data_dir_value;
  js_value_t *timeout_value;
  js_value_t *reachable_addresses_value;
  uint64_t generation;
  double timeout;
  if (js_get_named_property(env, argv[0], "dataDir", &data_dir_value) < 0 ||
      js_get_named_property(env, argv[0], "timeout", &timeout_value) < 0 ||
      js_get_named_property(env, argv[0], "reachableAddressesString", &reachable_addresses_value) < 0 ||
      !bare_arti_get_generation(env, argv[1], &generation) ||
      js_get_value_double(env, timeout_value, &timeout) < 0 ||
      timeout < 1000 || timeout > 1800000 || (double) ((uint64_t) timeout) != timeout) {
    js_throw_type_error(env, "ERR_ARTI_CONFIG", "invalid addon start options");
    return NULL;
  }
  char *data_dir = bare_arti_get_string(env, data_dir_value);
  char *reachable_addresses = bare_arti_get_string(env, reachable_addresses_value);
  if (data_dir == NULL || data_dir[0] != '/') {
    free(data_dir);
    free(reachable_addresses);
    js_throw_type_error(env, "ERR_ARTI_CONFIG", "dataDir must be an absolute path");
    return NULL;
  }
  if (reachable_addresses == NULL) {
    free(data_dir);
    js_throw_type_error(env, "ERR_ARTI_CONFIG", "invalid reachableAddresses serialization");
    return NULL;
  }

  bare_arti_lock();
  bare_arti_realm_t *realm = bare_arti_owner;
  bool rejected = realm == NULL || realm->env != env || realm->exiting || realm->generation != 0;
  bare_arti_unlock();
  if (rejected) {
    free(data_dir);
    free(reachable_addresses);
    js_throw_error(env, "ERR_ARTI_CONFIG_CONFLICT", "Arti addon is already active");
    return NULL;
  }

  js_value_t *promise;
  bare_arti_request_t *request = bare_arti_request_create(
    env,
    realm,
    bare_arti_request_start,
    generation,
    &promise
  );
  if (request == NULL) {
    free(data_dir);
    free(reachable_addresses);
    js_throw_error(env, "ERR_ARTI_BOOTSTRAP", "could not allocate addon request");
    return NULL;
  }

  bare_arti_lock();
  realm->generation = generation;
  realm->start = request;
  bare_arti_unlock();
  bare_arti_options_t options = {data_dir, reachable_addresses, (uint64_t) timeout, generation};
  int status = bare_arti_start(&options, bare_arti_on_native_result, request);
  free(data_dir);
  free(reachable_addresses);
  if (status != BARE_ARTI_STATUS_OK) {
    bare_arti_lock();
    realm->generation = 0;
    realm->start = NULL;
    bare_arti_unlock();
    bare_arti_reject_unaccepted_request(request);
    js_throw_error(env, "ERR_ARTI_BOOTSTRAP", "native Arti start rejected");
    return NULL;
  }
  return promise;
}

static js_value_t *
bare_arti_stop_raw(js_env_t *env, js_callback_info_t *info) {
  size_t argc = 1;
  js_value_t *argv[1];
  int err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);
  uint64_t generation;
  if (argc != 1 || !bare_arti_get_generation(env, argv[0], &generation)) {
    js_throw_type_error(env, "ERR_ARTI_CONFIG", "stop(generation) requires a valid generation");
    return NULL;
  }

  bare_arti_lock();
  bare_arti_realm_t *realm = bare_arti_owner;
  bool rejected = realm == NULL || realm->env != env || realm->exiting ||
                  realm->generation != generation || realm->stop != NULL;
  bare_arti_unlock();
  if (rejected) {
    js_throw_error(env, "ERR_ARTI_SHUTDOWN", "native Arti stop rejected");
    return NULL;
  }

  js_value_t *promise;
  bare_arti_request_t *request = bare_arti_request_create(
    env,
    realm,
    bare_arti_request_stop,
    generation,
    &promise
  );
  if (request == NULL) {
    js_throw_error(env, "ERR_ARTI_SHUTDOWN", "could not allocate addon stop request");
    return NULL;
  }
  bare_arti_lock();
  realm->stop = request;
  bare_arti_unlock();
  int status = bare_arti_stop(generation, bare_arti_on_native_result, request);
  if (status != BARE_ARTI_STATUS_OK) {
    bare_arti_lock();
    realm->stop = NULL;
    bare_arti_unlock();
    bare_arti_reject_unaccepted_request(request);
    js_throw_error(env, "ERR_ARTI_SHUTDOWN", "native Arti stop rejected");
    return NULL;
  }
  return promise;
}

#ifdef BARE_ARTI_TESTING
static js_value_t *
bare_arti_diagnostics(js_env_t *env, js_callback_info_t *info) {
  js_value_t *result;
  int err = js_create_object(env, &result);
  assert(err == 0);
#define V(name, counter) \
  { \
    js_value_t *value; \
    err = js_create_double(env, (double) atomic_load(&counter), &value); \
    assert(err == 0); \
    err = js_set_named_property(env, result, name, value); \
    assert(err == 0); \
  }
  V("allocations", bare_arti_allocations)
  V("frees", bare_arti_frees)
  V("completions", bare_arti_completions)
  V("duplicates", bare_arti_duplicates)
  V("late", bare_arti_late)
  V("jsAfterAbort", bare_arti_js_after_abort)
#undef V
  return result;
}
#endif

static js_value_t *
bare_arti_exports(js_env_t *env, js_value_t *exports) {
#ifdef BARE_ARTI_TESTING
  int test_status = bare_arti_enable_test_mode();
  if (test_status != BARE_ARTI_STATUS_OK) {
    js_throw_error(env, "ERR_ARTI_BOOTSTRAP", "could not enable addon test mode");
    return NULL;
  }
#endif
  bare_arti_realm_t *realm = calloc(1, sizeof(*realm));
  if (realm == NULL) {
    js_throw_error(env, "ERR_ARTI_BOOTSTRAP", "could not allocate addon realm");
    return NULL;
  }
  realm->env = env;

  bare_arti_lock();
  if (bare_arti_owner != NULL) {
    bare_arti_unlock();
    free(realm);
    js_throw_error(env, "ERR_ARTI_REALM_CONFLICT", "Arti addon is owned by another Bare realm");
    return NULL;
  }
  bare_arti_owner = realm;
  bare_arti_unlock();

  int err = js_create_threadsafe_function(
    env,
    NULL,
    0,
    1,
    bare_arti_realm_finalize,
    NULL,
    realm,
    bare_arti_on_realm_finish,
    &realm->finish_tsfn
  );
  assert(err == 0);
  err = js_unref_threadsafe_function(env, realm->finish_tsfn);
  assert(err == 0);

  err = js_add_deferred_teardown_callback(
    env,
    bare_arti_on_teardown,
    realm,
    &realm->teardown
  );
  assert(err == 0);

  js_value_t *abi_version;
  err = js_create_uint32(env, 2, &abi_version);
  assert(err == 0);
  err = js_set_named_property(env, exports, "abiVersion", abi_version);
  assert(err == 0);
  js_value_t *capabilities;
  err = js_create_string_utf8(
    env,
    (const utf8_t *) "reachableAddresses",
    -1,
    &capabilities
  );
  assert(err == 0);
  err = js_set_named_property(env, exports, "capabilities", capabilities);
  assert(err == 0);

#define V(name, fn) \
  { \
    js_value_t *value; \
    err = js_create_function(env, name, -1, fn, NULL, &value); \
    assert(err == 0); \
    err = js_set_named_property(env, exports, name, value); \
    assert(err == 0); \
  }
  V("start", bare_arti_start_raw)
  V("stop", bare_arti_stop_raw)
#ifdef BARE_ARTI_TESTING
  V("diagnostics", bare_arti_diagnostics)
#endif
#undef V
  return exports;
}

BARE_MODULE(bare_arti, bare_arti_exports)
