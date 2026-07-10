#include <bare.h>
#include <js.h>

js_value_t *
bare_arti_exports(js_env_t *env, js_value_t *exports);

BARE_MODULE(bare_arti, bare_arti_exports)
