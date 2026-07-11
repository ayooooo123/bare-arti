const { artiError } = require('./errors')

function createBackend({ platform, arch, loadAddon, startSidecar }) {
  const mobile = platform === 'android' || platform === 'ios'
  let addon = null
  let activeStop = null

  function missingAddon(error) {
    return artiError(
      'ERR_ARTI_ADDON_MISSING',
      `The bare-arti addon prebuild is missing for ${platform}-${arch}`,
      error
    )
  }

  function getAddon() {
    if (addon) return addon

    try {
      addon = loadAddon()
    } catch (error) {
      throw missingAddon(error)
    }

    if (!addon || typeof addon.start !== 'function' || typeof addon.stop !== 'function') {
      throw missingAddon(new Error('Addon does not expose start() and stop()'))
    }
    return addon
  }

  function startAddon(options) {
    let selected
    try {
      selected = getAddon()
      activeStop = () => selected.stop()
      return selected.start({ ...options, backend: 'addon' })
    } catch (error) {
      return Promise.reject(error)
    }
  }

  function start(options = {}) {
    if (
      options.backend !== undefined &&
      options.backend !== 'addon' &&
      options.backend !== 'sidecar'
    ) {
      return Promise.reject(artiError('ERR_ARTI_CONFIG', 'backend must be addon or sidecar'))
    }

    if (mobile) {
      if (options.backend === 'sidecar') {
        return Promise.reject(
          artiError(
            'ERR_ARTI_UNSUPPORTED_PLATFORM',
            `The sidecar backend is not supported on ${platform}`
          )
        )
      }
      return startAddon(options)
    }

    if (options.backend === 'addon') return startAddon(options)

    activeStop = null
    let starting
    try {
      starting = startSidecar(options)
    } catch (error) {
      return Promise.reject(error)
    }
    return Promise.resolve(starting).then((handle) => {
      activeStop = () => handle.stop()
      return handle
    })
  }

  function stop() {
    if (!activeStop) return Promise.resolve()
    try {
      return Promise.resolve(activeStop())
    } catch (error) {
      return Promise.reject(error)
    }
  }

  return { start, stop }
}

module.exports = { createBackend }
