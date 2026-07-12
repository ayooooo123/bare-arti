const { artiError } = require('./errors')
const { isMobilePlatform } = require('./platform')

const DEFAULT_TIMEOUT = 600000
const MIN_TIMEOUT = 1000
const MAX_TIMEOUT = 1800000
const DOCUMENTED_ERRORS = new Set([
  'ERR_ARTI_UNSUPPORTED_PLATFORM',
  'ERR_ARTI_ADDON_MISSING',
  'ERR_ARTI_CONFIG_CONFLICT',
  'ERR_ARTI_REALM_CONFLICT',
  'ERR_ARTI_CONFIG',
  'ERR_ARTI_CANCELLED',
  'ERR_ARTI_TIMEOUT',
  'ERR_ARTI_BOOTSTRAP',
  'ERR_ARTI_BIND',
  'ERR_ARTI_SHUTDOWN'
])

function configError(message, cause) {
  return artiError('ERR_ARTI_CONFIG', message, cause)
}

function identityChanged(left, right) {
  return (
    (left.dev !== undefined && right.dev !== undefined && left.dev !== right.dev) ||
    (left.ino !== undefined && right.ino !== undefined && left.ino !== right.ino)
  )
}

function matchingConfig(left, right) {
  return (
    left.backend === right.backend &&
    left.dataDir === right.dataDir &&
    left.timeout === right.timeout
  )
}

function mapStartError(error) {
  if (error && DOCUMENTED_ERRORS.has(error.code)) return error
  return artiError('ERR_ARTI_BOOTSTRAP', 'Arti addon failed to start', error)
}

function mapStopError(error) {
  if (error && error.code === 'ERR_ARTI_SHUTDOWN') return error
  return artiError('ERR_ARTI_SHUTDOWN', 'Arti addon failed to stop', error)
}

function createAddonController({ binding, validateOptions, setTimer, clearTimer }) {
  const lifecycleObservers = new Set()
  let generation = 0
  let status = 'stopped'
  let config = null
  let starting = null
  let stopping = null
  let service = null
  let timer = null
  let rejectStart = null
  // Keep late native values reachable until native stop owns final settlement.
  let pendingNativeCompletion = null

  function observeLifecycle(observer) {
    lifecycleObservers.add(observer)
    return () => lifecycleObservers.delete(observer)
  }

  function matchesOptions(options) {
    const normalized = validateOptions(options)
    return config !== null && matchingConfig(config, normalized)
  }

  function emitLifecycle(event) {
    const frozen = Object.freeze(event)
    for (const observer of lifecycleObservers) {
      try {
        observer(frozen)
      } catch {}
    }
  }

  function reset() {
    status = 'stopped'
    config = null
    starting = null
    stopping = null
    service = null
    rejectStart = null
    pendingNativeCompletion = null
  }

  function shutdownError() {
    return artiError('ERR_ARTI_SHUTDOWN', 'Arti addon is in a failed shutdown state')
  }

  function finishStop(stopGeneration, startError, wasStarting, error) {
    if (stopGeneration !== generation) {
      if (error) throw error
      return
    }

    const reject = rejectStart
    if (error && error.code === 'ERR_ARTI_SHUTDOWN') {
      status = 'failed'
      config = null
      starting = null
      stopping = null
      service = null
      rejectStart = null
      pendingNativeCompletion = null
      emitLifecycle({ status: 'failed', error })
    } else {
      reset()
      emitLifecycle({ status: 'stopped', generation: stopGeneration })
    }

    if (wasStarting && reject) reject(error || startError)
    if (error) throw error
  }

  function beginStop(stopGeneration, startError) {
    if (status === 'stopping') return stopping

    const wasStarting = status === 'starting'
    status = 'stopping'
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }

    let nativeStopping
    try {
      nativeStopping = binding.stop(stopGeneration)
    } catch (error) {
      nativeStopping = Promise.reject(error)
    }

    stopping = Promise.resolve(nativeStopping).then(
      () => finishStop(stopGeneration, startError, wasStarting, null),
      (error) => finishStop(stopGeneration, startError, wasStarting, mapStopError(error))
    )
    return stopping
  }

  function stop(stopGeneration = generation) {
    if (status === 'failed') return Promise.reject(shutdownError())
    if (stopGeneration !== generation || status === 'stopped') return Promise.resolve()
    if (status === 'stopping') return stopping

    const startError =
      status === 'starting'
        ? artiError('ERR_ARTI_CANCELLED', 'Arti addon startup was cancelled')
        : null
    return beginStop(stopGeneration, startError)
  }

  function start(options) {
    let normalized
    try {
      normalized = validateOptions(options)
    } catch (error) {
      return Promise.reject(error)
    }

    if (status === 'failed') return Promise.reject(shutdownError())
    if (status === 'stopping') {
      const cancelled = artiError('ERR_ARTI_CANCELLED', 'Arti addon is stopping')
      return stopping.then(
        () => {
          throw cancelled
        },
        () => {
          throw cancelled
        }
      )
    }
    if (status === 'starting' || status === 'running') {
      if (!matchingConfig(config, normalized)) {
        return Promise.reject(
          artiError('ERR_ARTI_CONFIG_CONFLICT', 'Arti addon is using different configuration')
        )
      }
      return starting
    }

    generation++
    const startGeneration = generation
    status = 'starting'
    config = normalized
    starting = new Promise((resolve, reject) => {
      rejectStart = reject

      let nativeStarting
      try {
        nativeStarting = binding.start(normalized, startGeneration)
      } catch (error) {
        nativeStarting = Promise.reject(error)
      }

      Promise.resolve(nativeStarting).then(
        (result) => {
          if (startGeneration !== generation) return
          if (status === 'stopping') {
            pendingNativeCompletion = { result }
            return
          }
          if (status !== 'starting') return
          if (!Number.isInteger(result && result.port) || result.port < 1 || result.port > 65535) {
            pendingNativeCompletion = { result }
            const error = artiError(
              'ERR_ARTI_BOOTSTRAP',
              'Arti addon returned an invalid SOCKS port'
            )
            beginStop(startGeneration, error).catch(() => {})
            return
          }
          if (timer !== null) {
            clearTimer(timer)
            timer = null
          }
          service = Object.freeze({
            port: result.port,
            backend: 'addon',
            stop: () => stop(startGeneration)
          })
          status = 'running'
          rejectStart = null
          resolve(service)
        },
        (error) => {
          if (startGeneration !== generation) return
          if (status === 'stopping') {
            pendingNativeCompletion = { error }
            return
          }
          if (status !== 'starting') return
          if (timer !== null) {
            clearTimer(timer)
            timer = null
          }
          const mapped = mapStartError(error)
          if (mapped.code === 'ERR_ARTI_SHUTDOWN') {
            status = 'failed'
            config = null
            starting = null
            service = null
            rejectStart = null
            pendingNativeCompletion = null
            emitLifecycle({ status: 'failed', error: mapped })
          } else {
            reset()
            emitLifecycle({ status: 'stopped', generation: startGeneration })
          }
          reject(mapped)
        }
      )
    })

    try {
      timer = setTimer(() => {
        if (startGeneration !== generation || status !== 'starting') return
        const timeoutError = artiError('ERR_ARTI_TIMEOUT', 'Arti addon startup timed out')
        beginStop(startGeneration, timeoutError).catch(() => {})
      }, normalized.timeout)
    } catch (error) {
      beginStop(startGeneration, mapStartError(error)).catch(() => {})
    }

    return starting
  }

  return { start, stop, matchesOptions, observeLifecycle }
}

function validateAddonOptions(options, dependencies) {
  if (!options || typeof options !== 'object') {
    throw configError('Addon options are required')
  }

  if (options.backend !== undefined && options.backend !== 'addon') {
    throw configError('backend must be addon')
  }

  const { platform, fs, path, getuid } = dependencies
  const timeout = options.timeout === undefined ? DEFAULT_TIMEOUT : options.timeout

  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) {
    throw configError(
      `timeout must be an integer between ${MIN_TIMEOUT} and ${MAX_TIMEOUT} milliseconds`
    )
  }

  if (typeof options.dataDir !== 'string' || !path.isAbsolute(options.dataDir)) {
    throw configError('dataDir must be an absolute path')
  }

  let dataDir

  try {
    fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })

    const linkStat = fs.lstatSync(options.dataDir)
    if (isMobilePlatform(platform) && linkStat.isSymbolicLink()) {
      throw configError('dataDir must not be a symbolic link on mobile')
    }

    dataDir = fs.realpathSync(options.dataDir)
    const stat = fs.statSync(dataDir)

    if (!stat.isDirectory()) {
      throw configError('dataDir must be a directory')
    }

    if ((stat.mode & 0o077) !== 0) {
      throw configError('dataDir must not be accessible by group or other users')
    }

    if (typeof getuid === 'function' && Number.isInteger(stat.uid) && stat.uid !== getuid()) {
      throw configError('dataDir must be owned by the current user')
    }

    const finalStat = fs.lstatSync(options.dataDir)
    if (
      (isMobilePlatform(platform) && finalStat.isSymbolicLink()) ||
      identityChanged(linkStat, stat) ||
      identityChanged(stat, finalStat)
    ) {
      throw configError('dataDir changed during validation')
    }

    // This narrows JS races; Rust must verify the directory authoritatively immediately before Arti use.
  } catch (error) {
    if (error && error.code === 'ERR_ARTI_CONFIG') throw error
    throw configError('Could not securely prepare dataDir', error)
  }

  return Object.freeze({
    backend: 'addon',
    dataDir,
    timeout
  })
}

module.exports = {
  createAddonController,
  validateAddonOptions
}
