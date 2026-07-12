const { artiError } = require('./errors')

function configError(message) {
  return artiError('ERR_ARTI_CONFIG', message)
}

function createOptionResolver({ platform, path, environment }) {
  const mobile = platform === 'android' || platform === 'ios'

  function beginGeneration() {
    const environmentDataDir = environment.BARE_ARTI_DATA

    return function resolveOptions(options) {
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw configError('Options must be an object')
      }

      const backend =
        options.backend === undefined ? (mobile ? 'addon' : 'sidecar') : options.backend

      if (backend !== 'addon' && backend !== 'sidecar') {
        throw configError('backend must be addon or sidecar')
      }

      if (
        options.insecureFsPermissions !== undefined &&
        typeof options.insecureFsPermissions !== 'boolean'
      ) {
        throw configError('insecureFsPermissions must be a boolean')
      }

      if (backend === 'addon' && options.insecureFsPermissions === true) {
        throw configError('insecureFsPermissions is not supported by the addon')
      }

      const dataDir = options.dataDir === undefined ? environmentDataDir : options.dataDir

      if (dataDir !== undefined && (typeof dataDir !== 'string' || !path.isAbsolute(dataDir))) {
        throw configError('dataDir must be an absolute path')
      }

      if (backend === 'addon' && dataDir === undefined) {
        throw configError('dataDir is required by the addon')
      }

      return Object.freeze({ ...options, backend, dataDir })
    }
  }

  return { beginGeneration }
}

module.exports = { createOptionResolver }
