// Loads the compiled Bare addon (in-process backend) from prebuilds/.
// index.js requires this lazily and falls back to the sidecar binary if the
// addon isn't present for the current platform.
module.exports = require.addon()
