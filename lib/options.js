const { artiError } = require('./errors')
const { isMobilePlatform } = require('./platform')
const { normalizeReachableAddresses } = require('./reachable-addresses')

function configError(message, cause) {
  return artiError('ERR_ARTI_CONFIG', message, cause)
}

function createOptionResolver({ platform, path, environment }) {
  const mobile = isMobilePlatform(platform)

  function beginGeneration() {
    let environmentDataDir
    try {
      environmentDataDir = environment.BARE_ARTI_DATA
    } catch (error) {
      throw configError('Could not read BARE_ARTI_DATA', error)
    }

    return function resolveOptions(options) {
      if (!options || typeof options !== 'object') {
        throw configError('Options must be an object')
      }

      let isArray
      try {
        isArray = Array.isArray(options)
      } catch (error) {
        throw configError('Could not read options', error)
      }
      if (isArray) throw configError('Options must be an object')

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

      const reachableAddresses = normalizeReachableAddresses(snapshot.reachableAddresses)

      return Object.freeze({
        ...snapshot,
        backend,
        dataDir,
        insecureFsPermissions: snapshot.insecureFsPermissions,
        reachableAddresses
      })
    }
  }

  return { beginGeneration }
}

module.exports = { createOptionResolver }
