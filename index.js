const { isBare } = require('which-runtime')
const path = isBare ? require('bare-path') : require('path')

// Bundled Tor for the dht-relay-tor stack — no external `tor` daemon.
//
// This boots the embedded Arti (Rust Tor) SOCKS5 proxy and returns its local
// port. dht-relay-tor's SOCKS5 client then points at that port, so the whole
// "run the DHT over Tor" flow works with nothing installed on the machine.
//
// Two backends, in preference order:
//   1. in-process Bare addon  (require.addon → prebuilds/, fully embedded)
//   2. prebuilt sidecar binary (spawn `arti-socks`, portable to Node + Bare)
//
// Both resolve to the same shape: `{ port, stop() }`.

const { spawn } = isBare ? require('bare-subprocess') : require('child_process')

// Try the in-process native addon first (Bare/Pear). It exposes start()/stop().
function tryAddon() {
  try {
    return require('./binding')
  } catch {
    return null
  }
}

// Locate the sidecar binary: a per-platform prebuild, or the cargo dev build.
function binaryPath() {
  const exe = process.platform === 'win32' ? 'arti-socks.exe' : 'arti-socks'
  const platform = `${process.platform}-${process.arch}`
  return {
    prebuild: path.join(__dirname, 'prebuilds', platform, exe),
    dev: path.join(__dirname, 'target', 'debug', exe)
  }
}

// Start embedded Tor. Resolves once the SOCKS proxy is listening.
// options: { timeout = 60000 } — bootstrap can take a while on first run.
async function start(options = {}) {
  const { timeout = 60000, bin = null } = options

  // Skip the addon when an explicit binary is requested (used by tests).
  if (!bin) {
    const addon = tryAddon()
    if (addon && typeof addon.start === 'function') {
      const priorData = process.env.BARE_ARTI_DATA
      const priorPermissions = process.env.FS_MISTRUST_DISABLE_PERMISSIONS_CHECKS
      if (options.dataDir) process.env.BARE_ARTI_DATA = options.dataDir
      if (options.insecureFsPermissions) {
        process.env.FS_MISTRUST_DISABLE_PERMISSIONS_CHECKS = 'true'
      }
      let port
      try {
        port = addon.start()
      } finally {
        restoreEnv('BARE_ARTI_DATA', priorData)
        restoreEnv('FS_MISTRUST_DISABLE_PERMISSIONS_CHECKS', priorPermissions)
      }
      return { port, backend: 'addon', stop: () => addon.stop() }
    }
  }

  return startSidecar(timeout, bin, options)
}

function childEnv(options) {
  const env = { ...process.env }
  // Persistent Tor state/cache directory for this app.
  if (options.dataDir) env.BARE_ARTI_DATA = options.dataDir
  // Relax Arti's filesystem-ownership hardening. Needed in containers where an
  // ancestor dir is owned by another uid; a security downgrade, so opt-in only.
  if (options.insecureFsPermissions) env.FS_MISTRUST_DISABLE_PERMISSIONS_CHECKS = 'true'
  return env
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function startSidecar(timeout, override, options) {
  const { prebuild, dev } = binaryPath()
  const fs = isBare ? require('bare-fs') : require('fs')
  const bin = override || (fs.existsSync(prebuild) ? prebuild : dev)

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { stdio: ['ignore', 'pipe', 'inherit'], env: childEnv(options) })

    let buf = ''
    let settled = false

    const timer = setTimeout(() => fail(new Error('embedded tor bootstrap timed out')), timeout)

    child.on('error', fail)
    child.on('exit', (code) => fail(new Error('arti-socks exited early (code ' + code + ')')))

    child.stdout.on('data', (d) => {
      buf += d.toString()
      const nl = buf.indexOf('\n')
      if (nl === -1 || settled) return
      const port = Number(buf.slice(0, nl).trim())
      if (!port) return fail(new Error('could not parse SOCKS port from arti-socks'))
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', fail)
      resolve({
        port,
        backend: 'sidecar',
        stop: () => child.kill()
      })
    })

    function fail(err) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {}
      reject(err)
    }
  })
}

module.exports = { start }
