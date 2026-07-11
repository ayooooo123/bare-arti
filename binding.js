// Loads the compiled in-process Bare addon from prebuilds/. Mobile requires
// this backend and fails closed when it is unavailable; desktop loads it only
// when the addon backend is selected explicitly.
module.exports = require.addon()
