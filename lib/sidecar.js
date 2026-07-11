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
  const setShutdownTimer = dependencies.setShutdownTimer || setTimer
  const clearShutdownTimer = dependencies.clearShutdownTimer || clearTimer
  const shutdownTimeout =
    dependencies.shutdownTimeout === undefined ? 5000 : dependencies.shutdownTimeout

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
    let resolveStop = null
    let rejectStop = null
    let timer = null
    let shutdownTimer = null
    let escalated = false
    let waitingForExit = false
    let buffer = ''
    let pendingStartError = null
    let pendingStopError = null
    let canObserveExit = false

    const operation = Object.freeze({ promise, stop, stopped })

    try {
      child.once('exit', onTerminated)
      child.once('close', onTerminated)
      canObserveExit = true
      child.on('error', onChildError)
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
      child.stdout.removeListener('data', onData)
    }

    function clearWatchdog() {
      if (shutdownTimer === null) return
      clearShutdownTimer(shutdownTimer)
      shutdownTimer = null
    }

    function settleStartError(error) {
      if (startSettled) return
      startSettled = true
      rejectStart(error)
    }

    function onTerminated(code) {
      if (exitConfirmed) return
      exitConfirmed = true
      clearWatchdog()
      child.removeListener('error', onChildError)
      resolveExit()

      if (status === 'starting') {
        cleanupStartup()
        status = 'stopped'
        settleStartError(
          bootstrapError(`arti-socks exited before startup completed (code ${code})`)
        )
        resolveStopped()
      } else if (status === 'running') {
        status = 'stopped'
        resolveStopped()
      }
    }

    function onChildError(error) {
      if (status === 'starting' && error && error.code === 'ENOENT') {
        waitForUnspawned(bootstrapError('Could not spawn arti-socks', error))
        return
      }
      if (status === 'starting') {
        requestStop(bootstrapError('Could not start arti-socks', error)).catch(() => {})
        return
      }

      const terminal = shutdownError('arti-socks emitted a runtime error', error)
      if (status === 'stopping') {
        if (!pendingStopError) pendingStopError = terminal
        return
      }
      if (status === 'running') requestStop(null, terminal).catch(() => {})
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

    function createStopPromise() {
      if (stopPromise) return
      stopPromise = new Promise((resolve, reject) => {
        resolveStop = resolve
        rejectStop = reject
      })
    }

    function waitForExit() {
      if (waitingForExit) return
      waitingForExit = true
      exited.then(() => {
        if (status === 'failed') return
        if (pendingStopError) {
          failShutdown(pendingStopError)
          return
        }
        status = 'stopped'
        if (pendingStartError) settleStartError(pendingStartError)
        resolveStopped()
        resolveStop()
      })
    }

    function waitForUnspawned(error) {
      if (stopPromise) return stopPromise
      pendingStartError = error
      cleanupStartup()
      status = 'stopping'
      createStopPromise()
      waitForExit()
      return stopPromise
    }

    function requestStop(startError, terminalError) {
      if (stopPromise) return stopPromise
      if (startError && !pendingStartError) pendingStartError = startError
      if (terminalError && !pendingStopError) pendingStopError = terminalError
      cleanupStartup()

      if (exitConfirmed || status === 'stopped') {
        if (pendingStopError) {
          createStopPromise()
          failShutdown(pendingStopError)
          return stopPromise
        }
        status = 'stopped'
        if (pendingStartError) settleStartError(pendingStartError)
        resolveStopped()
        stopPromise = Promise.resolve()
        return stopPromise
      }

      status = 'stopping'
      createStopPromise()
      waitForExit()

      let signalled
      try {
        signalled = child.kill()
      } catch (error) {
        failShutdown(shutdownError('Could not terminate arti-socks', error))
        return stopPromise
      }
      if (signalled === false) {
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
      armWatchdog()
      return stopPromise
    }

    function armWatchdog() {
      try {
        shutdownTimer = setShutdownTimer(onShutdownTimeout, shutdownTimeout)
      } catch (error) {
        failShutdown(shutdownError('Could not monitor arti-socks shutdown', error))
      }
    }

    function onShutdownTimeout() {
      shutdownTimer = null
      if (exitConfirmed || status === 'failed') return
      if (!escalated) {
        escalated = true
        let signalled
        try {
          signalled = child.kill('SIGKILL')
        } catch (error) {
          failShutdown(shutdownError('Could not escalate arti-socks termination', error))
          return
        }
        if (signalled === false) {
          failShutdown(
            shutdownError(
              'Could not confirm escalated arti-socks termination',
              new Error('child.kill(SIGKILL) did not confirm delivery')
            )
          )
          return
        }
        armWatchdog()
        return
      }
      failShutdown(
        shutdownError(
          'arti-socks did not terminate before the shutdown deadline',
          new Error('Timed out waiting for process exit')
        )
      )
    }

    function failShutdown(error) {
      if (status === 'failed') return
      clearWatchdog()
      status = 'failed'
      settleStartError(error)
      rejectStopped(error)
      if (rejectStop) rejectStop(error)
    }
  }
}

module.exports = { createSidecar, resolveSidecarBinary }
