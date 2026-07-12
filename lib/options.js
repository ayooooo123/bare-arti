const { artiError } = require('./errors')

function configError(message, cause) {
  return artiError('ERR_ARTI_CONFIG', message, cause)
}

function createOptionResolver({ platform, path, environment }) {
  const mobile = platform === 'android' || platform === 'ios'

  function beginGeneration() {
    const environmentDataDir = environment.BARE_ARTI_DATA

    return function resolveOptions(options) {
      if (!options || typeof options !== 'object') {
        throw configError('Options must be an object')
      }
      if (Array.isArray(options)) throw configError('Options must be an object')

      let snapshot
      try {
        snapshot = { ...options }
      } catch (error) {
        throw configError('Could not read options', error)
      }

      const backend =
        snapshot.backend === undefined ? (mobile ? 'addon' : 'sidecar') : snapshot.backend

      if (backend !== 'addon' && backend !== 'sidecar') {
        throw configError('backend must be addon or sidecar')
      }

      if (
        snapshot.insecureFsPermissions !== undefined &&
        typeof snapshot.insecureFsPermissions !== 'boolean'
      ) {
        throw configError('insecureFsPermissions must be a boolean')
      }

      if (backend === 'addon' && snapshot.insecureFsPermissions === true) {
        throw configError('insecureFsPermissions is not supported by the addon')
      }

      const dataDir = snapshot.dataDir === undefined ? environmentDataDir : snapshot.dataDir

      if (dataDir !== undefined && (typeof dataDir !== 'string' || !path.isAbsolute(dataDir))) {
        throw configError('dataDir must be an absolute path')
      }

      if (backend === 'addon' && dataDir === undefined) {
        throw configError('dataDir is required by the addon')
      }

      return Object.freeze({
        ...snapshot,
        backend,
        dataDir,
        insecureFsPermissions: snapshot.insecureFsPermissions
      })
    }
  }

  return { beginGeneration }
}

module.exports = { createOptionResolver }
