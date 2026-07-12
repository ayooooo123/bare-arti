const { artiError } = require('./errors')

function shutdown(error) {
  if (error && error.code === 'ERR_ARTI_SHUTDOWN') return error
  return artiError('ERR_ARTI_SHUTDOWN', 'The selected bare-arti backend failed to stop', error)
}

function cancelled() {
  return artiError('ERR_ARTI_CANCELLED', 'The previous bare-arti backend is stopping')
}

function snapshotService(service) {
  try {
    if (!service || (typeof service !== 'object' && typeof service !== 'function')) {
      throw new TypeError('Backend service must be an object')
    }

    const backend = service.backend
    const port = service.port
    if (backend !== 'addon' && backend !== 'sidecar') {
      throw new TypeError('Backend service has an invalid backend')
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError('Backend service has an invalid port')
    }
    return { backend, port }
  } catch (error) {
    throw artiError(
      'ERR_ARTI_BOOTSTRAP',
      'The selected bare-arti backend returned an invalid service',
      error
    )
  }
}

function createOwnership({ startBackend, stopBackend, beginOptionsGeneration }) {
  let resolveGeneration = null
  let backendStarting = null
  let legacy = false
  let legacyAttempt = null
  let legacyStarting = null
  let legacyService = null
  const leases = new Set()
  let pendingAcquisitions = 0
  let stopping = null
  let terminalError = null
  let enteringBackend = false

  function owners() {
    return leases.size + pendingAcquisitions + (legacy ? 1 : 0)
  }

  function ensureResolver() {
    if (!resolveGeneration) resolveGeneration = beginOptionsGeneration()
    return resolveGeneration
  }

  function reject(error) {
    return Promise.reject(error)
  }

  function normalize(options) {
    if (terminalError) throw terminalError
    return ensureResolver()(options)
  }

  function beginBackend(options) {
    if (enteringBackend) return reject(cancelled())
    enteringBackend = true
    let operation
    try {
      operation = startBackend(options)
    } catch (error) {
      operation = reject(error)
    } finally {
      enteringBackend = false
    }
    operation = Promise.resolve(operation)
    if (!backendStarting) backendStarting = operation
    return operation
  }

  function clearFailedGeneration() {
    if (owners() !== 0 || stopping) return
    resolveGeneration = null
    backendStarting = null
    legacyService = null
  }

  function finishFailedRequest(operation) {
    if (owners() !== 0) return
    if (operation === backendStarting) {
      clearFailedGeneration()
      return
    }
    beginStop().catch(() => {})
  }

  function finishProjectionFailure(error) {
    if (owners() !== 0) return reject(error)
    return beginStop().then(() => {
      throw error
    })
  }

  function beginStop() {
    if (terminalError) return reject(terminalError)
    if (stopping) return stopping
    if (owners() !== 0 || !backendStarting) return Promise.resolve()

    let resolveStopping
    let rejectStopping
    const sharedStopping = new Promise((resolve, rejectPromise) => {
      resolveStopping = resolve
      rejectStopping = rejectPromise
    })
    stopping = sharedStopping

    let operation
    try {
      operation = stopBackend()
    } catch (error) {
      operation = reject(error)
    }

    Promise.resolve(operation).then(
      () => {
        resolveGeneration = null
        backendStarting = null
        legacyService = null
        stopping = null
        resolveStopping()
      },
      (error) => {
        terminalError = shutdown(error)
        rejectStopping(terminalError)
      }
    )
    return sharedStopping
  }

  function acquire(options = {}) {
    pendingAcquisitions++

    let normalized
    try {
      normalized = normalize(options)
    } catch (error) {
      pendingAcquisitions--
      clearFailedGeneration()
      return reject(error)
    }
    if (stopping) {
      pendingAcquisitions--
      return reject(cancelled())
    }

    const operation = beginBackend(normalized)
    return operation.then(
      (service) => {
        pendingAcquisitions--
        let snapshot
        try {
          snapshot = snapshotService(service)
        } catch (error) {
          return finishProjectionFailure(error)
        }
        let released = false
        let releasePromise = null
        let lease = null

        function release() {
          if (releasePromise) return releasePromise
          if (!released) {
            released = true
            leases.delete(lease)
          }
          releasePromise = beginStop()
          return releasePromise
        }

        lease = Object.freeze({
          backend: snapshot.backend,
          port: snapshot.port,
          release
        })
        leases.add(lease)
        return lease
      },
      (error) => {
        pendingAcquisitions--
        finishFailedRequest(operation)
        throw error
      }
    )
  }

  function start(options = {}) {
    let normalized
    try {
      normalized = normalize(options)
    } catch (error) {
      clearFailedGeneration()
      return reject(error)
    }
    if (stopping) return reject(cancelled())

    const operation = beginBackend(normalized)
    if (legacy) {
      if (operation === backendStarting) return legacyStarting
      return operation.then(() => legacyStarting)
    }

    legacy = true
    const attempt = { releasePromise: null }
    legacyAttempt = attempt
    const publicStarting = operation.then(
      (service) => {
        let snapshot
        try {
          snapshot = snapshotService(service)
        } catch (error) {
          if (legacyAttempt === attempt) {
            legacy = false
            legacyAttempt = null
            legacyStarting = null
            legacyService = null
          }
          return finishProjectionFailure(error)
        }

        function stopService() {
          return releaseLegacy(attempt)
        }

        const publicService = Object.freeze({
          backend: snapshot.backend,
          port: snapshot.port,
          stop: stopService
        })
        if (legacyAttempt === attempt) legacyService = publicService
        return publicService
      },
      (error) => {
        if (legacyAttempt === attempt) {
          legacy = false
          legacyAttempt = null
          legacyStarting = null
          legacyService = null
          finishFailedRequest(operation)
        }
        throw error
      }
    )
    legacyStarting = publicStarting
    return publicStarting
  }

  function stop() {
    if (terminalError) return reject(terminalError)
    if (!legacy) return stopping || Promise.resolve()

    return releaseLegacy(legacyAttempt)
  }

  function releaseLegacy(attempt) {
    if (attempt.releasePromise) return attempt.releasePromise
    if (attempt !== legacyAttempt || !legacy) {
      attempt.releasePromise = Promise.resolve()
      return attempt.releasePromise
    }

    legacy = false
    legacyAttempt = null
    legacyStarting = null
    legacyService = null
    attempt.releasePromise = beginStop()
    return attempt.releasePromise
  }

  return Object.freeze({ acquire, start, stop })
}

module.exports = { createOwnership }
