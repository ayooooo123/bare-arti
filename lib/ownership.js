const { artiError } = require('./errors')

function shutdown(error) {
  if (error && error.code === 'ERR_ARTI_SHUTDOWN') return error
  return artiError('ERR_ARTI_SHUTDOWN', 'The selected bare-arti backend failed to stop', error)
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
    let operation
    try {
      operation = startBackend(options)
    } catch (error) {
      operation = reject(error)
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

  function beginStop() {
    if (terminalError) return reject(terminalError)
    if (stopping) return stopping
    if (owners() !== 0 || !backendStarting) return Promise.resolve()

    let operation
    try {
      operation = stopBackend()
    } catch (error) {
      operation = reject(error)
    }

    stopping = Promise.resolve(operation).then(
      () => {
        resolveGeneration = null
        backendStarting = null
        legacyService = null
        stopping = null
      },
      (error) => {
        terminalError = shutdown(error)
        throw terminalError
      }
    )
    return stopping
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

    const operation = beginBackend(normalized)
    return operation.then(
      (service) => {
        pendingAcquisitions--
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
          backend: service.backend,
          port: service.port,
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
        function stopService() {
          return releaseLegacy(attempt)
        }

        const publicService = Object.freeze({
          backend: service.backend,
          port: service.port,
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

  return { acquire, start, stop }
}

module.exports = { createOwnership }
