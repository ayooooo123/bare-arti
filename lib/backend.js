const { artiError } = require('./errors')

function conflict() {
  return artiError(
    'ERR_ARTI_CONFIG_CONFLICT',
    'Another bare-arti backend or configuration owns Tor'
  )
}

function cancelled() {
  return artiError('ERR_ARTI_CANCELLED', 'The previous bare-arti backend is stopping')
}

function shutdown(error) {
  if (error && error.code === 'ERR_ARTI_SHUTDOWN') return error
  return artiError('ERR_ARTI_SHUTDOWN', 'The selected bare-arti backend failed to stop', error)
}

function sidecarConfig(options) {
  return Object.freeze({
    bin: options.bin === undefined ? null : options.bin,
    dataDir: options.dataDir === undefined ? null : options.dataDir,
    dev: options.dev === true,
    insecureFsPermissions: options.insecureFsPermissions === true,
    timeout: options.timeout === undefined ? 60000 : options.timeout
  })
}

function matchingSidecarConfig(left, right) {
  return (
    left.bin === right.bin &&
    left.dataDir === right.dataDir &&
    left.dev === right.dev &&
    left.insecureFsPermissions === right.insecureFsPermissions &&
    left.timeout === right.timeout
  )
}

function addonConfig(options) {
  return Object.freeze({
    dataDir: options.dataDir === undefined ? null : options.dataDir,
    timeout: options.timeout === undefined ? 600000 : options.timeout
  })
}

function matchingAddonConfig(left, right) {
  return left.dataDir === right.dataDir && left.timeout === right.timeout
}

function createBackend({ platform, arch, loadAddon, startSidecar }) {
  const mobile = platform === 'android' || platform === 'ios'
  let addon = null
  let owner = null
  let terminalError = null

  function missingAddon(error) {
    return artiError(
      'ERR_ARTI_ADDON_MISSING',
      `The bare-arti addon prebuild is missing for ${platform}-${arch}`,
      error
    )
  }

  function getAddon() {
    if (addon) return addon

    let candidate
    try {
      candidate = loadAddon()
    } catch (error) {
      throw missingAddon(error)
    }

    if (
      !candidate ||
      typeof candidate.start !== 'function' ||
      typeof candidate.stop !== 'function'
    ) {
      throw missingAddon(new Error('Addon does not expose start() and stop()'))
    }
    addon = candidate
    return addon
  }

  function validateStartOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw artiError('ERR_ARTI_CONFIG', 'Options must be an object')
    }
    if (
      options.backend !== undefined &&
      options.backend !== 'addon' &&
      options.backend !== 'sidecar'
    ) {
      throw artiError('ERR_ARTI_CONFIG', 'backend must be addon or sidecar')
    }
  }

  function startDuringStop() {
    const error = cancelled()
    return owner.stopping.then(
      () => {
        throw error
      },
      () => {
        throw error
      }
    )
  }

  function startAddon(options) {
    const config = addonConfig(options)
    if (owner) {
      if (owner.status === 'stopping') return startDuringStop()
      if (owner.kind !== 'addon') return Promise.reject(conflict())
      if (!matchingAddonConfig(owner.config, config)) return Promise.reject(conflict())
      return owner.starting
    }

    let selected
    try {
      selected = getAddon()
    } catch (error) {
      return Promise.reject(error)
    }

    owner = {
      kind: 'addon',
      config,
      status: 'active',
      stop: () => selected.stop(),
      stopping: null,
      unsubscribe: null
    }
    const startingOwner = owner
    if (typeof selected.observeLifecycle === 'function') {
      owner.unsubscribe = selected.observeLifecycle((event) => {
        if (owner !== startingOwner) return
        if (event.status === 'failed') {
          terminalError = shutdown(event.error)
          startingOwner.status = 'failed'
        } else if (event.status === 'stopped' && startingOwner.status === 'active') {
          clearOwner(startingOwner)
        }
      })
    }
    let nativeStarting
    try {
      nativeStarting = selected.start({ ...options, backend: 'addon' })
    } catch (error) {
      nativeStarting = Promise.reject(error)
    }
    startingOwner.starting = Promise.resolve(nativeStarting).then(null, (error) =>
      finishAddonFailure(startingOwner, error)
    )
    return startingOwner.starting
  }

  async function finishAddonFailure(startingOwner, error) {
    if (terminalError) throw terminalError
    if (owner !== startingOwner) throw error
    try {
      await stop()
    } catch (cleanupError) {
      throw cleanupError
    }
    throw error
  }

  function startSelectedSidecar(options) {
    const config = sidecarConfig(options)
    if (owner) {
      if (owner.status === 'stopping') return startDuringStop()
      if (owner.kind !== 'sidecar' || !matchingSidecarConfig(owner.config, config)) {
        return Promise.reject(conflict())
      }
      return owner.starting
    }

    let operation
    try {
      operation = startSidecar(options)
    } catch (error) {
      return Promise.reject(error)
    }
    if (
      !operation ||
      !operation.promise ||
      typeof operation.promise.then !== 'function' ||
      typeof operation.stop !== 'function' ||
      !operation.stopped ||
      typeof operation.stopped.then !== 'function'
    ) {
      return Promise.reject(artiError('ERR_ARTI_BOOTSTRAP', 'Invalid sidecar operation'))
    }

    owner = {
      kind: 'sidecar',
      config,
      status: 'active',
      starting: operation.promise,
      stop: operation.stop,
      stopping: null
    }
    const startingOwner = owner
    operation.stopped.then(
      () => {
        if (owner === startingOwner && startingOwner.status === 'active') owner = null
      },
      (error) => {
        if (owner !== startingOwner || startingOwner.status !== 'active') return
        terminalError = shutdown(error)
        startingOwner.status = 'failed'
      }
    )
    owner.starting.then(null, () => {
      if (owner !== startingOwner || startingOwner.status !== 'active') return
      stop().catch(() => {})
    })
    return owner.starting
  }

  function start(options = {}) {
    try {
      validateStartOptions(options)
    } catch (error) {
      return Promise.reject(error)
    }
    if (terminalError) return Promise.reject(terminalError)

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
    if (owner && owner.kind === 'addon') {
      if (owner.status === 'stopping') return startDuringStop()
      return Promise.reject(conflict())
    }
    return startSelectedSidecar(options)
  }

  function stop() {
    if (terminalError) return Promise.reject(terminalError)
    if (!owner) return Promise.resolve()
    if (owner.status === 'stopping') return owner.stopping

    const stoppingOwner = owner
    stoppingOwner.status = 'stopping'
    let nativeStopping
    try {
      nativeStopping = stoppingOwner.stop()
    } catch (error) {
      nativeStopping = Promise.reject(error)
    }
    stoppingOwner.stopping = Promise.resolve(nativeStopping).then(
      () => {
        clearOwner(stoppingOwner)
      },
      (error) => {
        terminalError = shutdown(error)
        throw terminalError
      }
    )
    return stoppingOwner.stopping
  }

  function clearOwner(expected) {
    if (owner !== expected) return
    if (typeof expected.unsubscribe === 'function') expected.unsubscribe()
    owner = null
  }

  return { start, stop }
}

module.exports = { createBackend }
