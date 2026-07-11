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

function createSidecar(dependencies) {
  const { spawn, setTimer, clearTimer } = dependencies

  return function startSidecar(options = {}) {
    let bin
    try {
      bin = resolveSidecarBinary(options, dependencies)
    } catch (error) {
      return Promise.reject(error)
    }

    const timeout = options.timeout === undefined ? 60000 : options.timeout
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(bin, [], {
          stdio: ['ignore', 'pipe', 'inherit'],
          env: childEnvironment(dependencies.environment, options)
        })
      } catch (error) {
        reject(error)
        return
      }

      let buffer = ''
      let settled = false
      const timer = setTimer(() => fail(new Error('embedded tor bootstrap timed out')), timeout)

      child.on('error', fail)
      child.on('exit', (code) => fail(new Error('arti-socks exited early (code ' + code + ')')))
      child.stdout.on('data', (data) => {
        buffer += data.toString()
        const newline = buffer.indexOf('\n')
        if (newline === -1 || settled) return

        const port = Number(buffer.slice(0, newline).trim())
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          fail(new Error('could not parse SOCKS port from arti-socks'))
          return
        }

        settled = true
        clearTimer(timer)
        resolve(
          Object.freeze({
            port,
            backend: 'sidecar',
            stop: () => child.kill()
          })
        )
      })

      function fail(error) {
        if (settled) return
        settled = true
        clearTimer(timer)
        try {
          child.kill()
        } catch {}
        reject(error)
      }
    })
  }
}

module.exports = { createSidecar, resolveSidecarBinary }
