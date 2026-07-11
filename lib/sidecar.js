const { artiError } = require('./errors')

function binaryNames(platform) {
  return platform === 'win32'
    ? { executable: 'arti-socks.exe', prebuildPlatform: 'win32' }
    : { executable: 'arti-socks', prebuildPlatform: platform }
}

function resolveSidecarBinary(options, { platform, arch, dirname, fs, path }) {
  if (options.bin) return options.bin

  const { executable, prebuildPlatform } = binaryNames(platform)
  const prebuild = path.join(dirname, 'prebuilds', `${prebuildPlatform}-${arch}`, executable)
  if (fs.existsSync(prebuild)) return prebuild

  if (options.dev === true) {
    const development = path.join(dirname, 'target', 'debug', executable)
    if (fs.existsSync(development)) return development
  }

  throw artiError(
    'ERR_ARTI_UNSUPPORTED_PLATFORM',
    `No arti-socks prebuild is installed for ${platform}-${arch}`
  )
}

function childEnvironment(environment, options) {
  const result = { ...environment }
  if (options.dataDir) result.BARE_ARTI_DATA = options.dataDir
  if (options.insecureFsPermissions) {
    result.FS_MISTRUST_DISABLE_PERMISSIONS_CHECKS = 'true'
  }
  return result
}

function configError(message, cause) {
  return artiError('ERR_ARTI_CONFIG', message, cause)
}

function bootstrapError(message, cause) {
  return artiError('ERR_ARTI_BOOTSTRAP', message, cause)
}

function shutdownError(message, cause) {
  return artiError('ERR_ARTI_SHUTDOWN', message, cause)
}

function rejectedOperation(error) {
  const promise = Promise.reject(error)
  return Object.freeze({ promise, stop: () => Promise.resolve(), stopped: Promise.resolve() })
}

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw configError('Sidecar options must be an object')
  }
  const timeout = options.timeout === undefined ? 60000 : options.timeout
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1800000) {
    throw configError('timeout must be an integer between 1 and 1800000 milliseconds')
  }
  if (options.bin !== undefined && typeof options.bin !== 'string') {
    throw configError('bin must be a string')
  }
  return timeout
}

function createSidecar(dependencies) {
  const { spawn, setTimer, clearTimer } = dependencies

  return function startSidecar(options = {}) {
    let timeout
    let bin
    try {
      timeout = validateOptions(options)
      bin = resolveSidecarBinary(options, dependencies)
    } catch (error) {
      return rejectedOperation(error)
    }

    let child
    try {
      child = spawn(bin, [], {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: childEnvironment(dependencies.environment, options)
      })
    } catch (error) {
      return rejectedOperation(bootstrapError('Could not spawn arti-socks', error))
    }

    let resolveStart
    let rejectStart
    const promise = new Promise((resolve, reject) => {
      resolveStart = resolve
      rejectStart = reject
    })
    let resolveExit
    const exited = new Promise((resolve) => {
      resolveExit = resolve
    })
    let resolveStopped
    let rejectStopped
    const stopped = new Promise((resolve, reject) => {
      resolveStopped = resolve
      rejectStopped = reject
    })
    stopped.catch(() => {})
    let status = 'starting'
    let startSettled = false
    let exitConfirmed = false
    let stopPromise = null
    let timer = null
    let buffer = ''
    let pendingStartError = null
    let canObserveExit = false

    const operation = Object.freeze({ promise, stop, stopped })

    try {
      child.once('exit', onTerminated)
      child.once('close', onTerminated)
      canObserveExit = true
      child.on('error', onSpawnError)
      child.stdout.on('data', onData)
      timer = setTimer(
        () =>
          requestStop(artiError('ERR_ARTI_TIMEOUT', 'embedded tor bootstrap timed out')).catch(
            () => {}
          ),
        timeout
      )
    } catch (error) {
      requestStop(bootstrapError('Could not initialize sidecar startup', error)).catch(() => {})
    }

    return operation

    function cleanupStartup() {
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      buffer = ''
      child.removeListener('error', onSpawnError)
      child.stdout.removeListener('data', onData)
    }

    function settleStartError(error) {
      if (startSettled) return
      startSettled = true
      rejectStart(error)
    }

    function onTerminated(code) {
      if (exitConfirmed) return
      exitConfirmed = true
      resolveExit()
      resolveStopped()

      if (status === 'starting') {
        cleanupStartup()
        status = 'stopped'
        settleStartError(
          bootstrapError(`arti-socks exited before startup completed (code ${code})`)
        )
      } else if (status === 'running') {
        status = 'stopped'
      }
    }

    function onSpawnError(error) {
      requestStop(bootstrapError('Could not start arti-socks', error)).catch(() => {})
    }

    function onData(data) {
      buffer += data.toString()
      const newline = buffer.indexOf('\n')
      if (newline === -1 || status !== 'starting') return

      const port = Number(buffer.slice(0, newline).trim())
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        requestStop(bootstrapError('Could not parse SOCKS port from arti-socks')).catch(() => {})
        return
      }

      cleanupStartup()
      status = 'running'
      startSettled = true
      resolveStart(
        Object.freeze({
          port,
          backend: 'sidecar',
          stop
        })
      )
    }

    function stop() {
      const error =
        status === 'starting'
          ? artiError('ERR_ARTI_CANCELLED', 'Sidecar startup was cancelled')
          : null
      return requestStop(error)
    }

    function requestStop(startError) {
      if (stopPromise) return stopPromise
      if (startError && !pendingStartError) pendingStartError = startError
      cleanupStartup()

      if (exitConfirmed || status === 'stopped') {
        status = 'stopped'
        if (pendingStartError) settleStartError(pendingStartError)
        stopPromise = Promise.resolve()
        return stopPromise
      }

      status = 'stopping'
      let resolveStop
      let rejectStop
      stopPromise = new Promise((resolve, reject) => {
        resolveStop = resolve
        rejectStop = reject
      })

      let signalled
      try {
        signalled = child.kill()
      } catch (error) {
        failShutdown(shutdownError('Could not terminate arti-socks', error))
        return stopPromise
      }
      if (signalled !== true) {
        failShutdown(
          shutdownError(
            'Could not confirm arti-socks termination request',
            new Error('child.kill() did not confirm delivery')
          )
        )
        return stopPromise
      }
      if (!canObserveExit) {
        failShutdown(
          shutdownError(
            'Could not observe arti-socks termination',
            new Error('Process termination listeners were not installed')
          )
        )
        return stopPromise
      }

      exited.then(() => {
        if (status === 'failed') return
        status = 'stopped'
        if (pendingStartError) settleStartError(pendingStartError)
        resolveStop()
      })
      return stopPromise

      function failShutdown(error) {
        status = 'failed'
        settleStartError(error)
        rejectStopped(error)
        rejectStop(error)
      }
    }
  }
}

module.exports = { createSidecar, resolveSidecarBinary }
