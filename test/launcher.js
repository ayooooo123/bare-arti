const test = require('brittle')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const { createSidecar, resolveSidecarBinary } = require('../lib/sidecar')

const start = createSidecar({
  platform: process.platform,
  arch: process.arch,
  dirname: path.join(__dirname, '..'),
  fs,
  path,
  spawn,
  environment: process.env,
  setTimer: setTimeout,
  clearTimer: clearTimeout
})

// Verifies the sidecar launcher logic — spawn the proxy, parse the SOCKS port it
// prints on stdout, and stop it — using a fake executable in place of the real
// arti-socks (which needs Tor network access to finish bootstrapping). The fake
// mimics the contract: print "<port>\n", then stay alive.
function fakeBinary(name, body) {
  const p = path.join(os.tmpdir(), name + '-' + process.pid + '.sh')
  fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n', { mode: 0o755 })
  return p
}

test('start() parses the printed port and returns a working handle', async (t) => {
  const bin = fakeBinary('arti-ok', 'echo 41337\nwhile true; do sleep 1; done')
  let handle

  try {
    handle = await start({ bin, timeout: 5000 })
    t.is(handle.port, 41337, 'port parsed from stdout')
    t.is(handle.backend, 'sidecar')
    t.is(typeof handle.stop, 'function')
  } finally {
    if (handle) handle.stop()
    fs.unlinkSync(bin)
  }
})

test('start() rejects when the proxy exits before printing a port', async (t) => {
  const bin = fakeBinary('arti-die', 'exit 3')

  try {
    await t.exception(start({ bin, timeout: 5000 }), /exited early/)
  } finally {
    fs.unlinkSync(bin)
  }
})

test('start() times out if no port is ever printed', async (t) => {
  const bin = fakeBinary('arti-hang', 'while true; do sleep 1; done')

  try {
    await t.exception(start({ bin, timeout: 500 }), /timed out/)
  } finally {
    fs.unlinkSync(bin)
  }
})

test('sidecar receives explicit dataDir in BARE_ARTI_DATA', async (t) => {
  const bin = fakeBinary(
    'arti-data-dir',
    'test "$BARE_ARTI_DATA" = "/tmp/bare-arti-explicit" || exit 9\necho 41339\nwhile true; do sleep 1; done'
  )
  let handle

  try {
    handle = await start({ bin, dataDir: '/tmp/bare-arti-explicit', timeout: 5000 })
    t.is(handle.port, 41339)
  } finally {
    if (handle) handle.stop()
    fs.unlinkSync(bin)
  }
})

test('sidecar inherits BARE_ARTI_DATA without dataDir', async (t) => {
  const bin = fakeBinary(
    'arti-inherited-data',
    'test "$BARE_ARTI_DATA" = "/tmp/bare-arti-inherited" || exit 9\necho 41340\nwhile true; do sleep 1; done'
  )
  const priorData = process.env.BARE_ARTI_DATA
  let handle
  process.env.BARE_ARTI_DATA = '/tmp/bare-arti-inherited'

  try {
    handle = await start({ bin, timeout: 5000 })
    t.is(handle.port, 41340)
  } finally {
    if (handle) handle.stop()
    fs.unlinkSync(bin)
    restoreEnv('BARE_ARTI_DATA', priorData)
  }
})

test('sidecar receives insecure filesystem permission opt-in', async (t) => {
  const bin = fakeBinary(
    'arti-insecure-fs',
    'test "$FS_MISTRUST_DISABLE_PERMISSIONS_CHECKS" = "true" || exit 9\necho 41341\nwhile true; do sleep 1; done'
  )
  let handle

  try {
    handle = await start({ bin, insecureFsPermissions: true, timeout: 5000 })
    t.is(handle.port, 41341)
  } finally {
    if (handle) handle.stop()
    fs.unlinkSync(bin)
  }
})

test('published sidecar missing prebuild never falls back to target/debug', (t) => {
  const checked = []
  let error = null

  try {
    resolveSidecarBinary(
      {},
      {
        platform: 'linux',
        arch: 'x64',
        dirname: '/package',
        path,
        fs: {
          existsSync(filename) {
            checked.push(filename)
            return false
          }
        }
      }
    )
  } catch (caught) {
    error = caught
  }

  t.is(error && error.code, 'ERR_ARTI_UNSUPPORTED_PLATFORM')
  t.ok(error.message.includes('prebuild'))
  t.alike(checked, [path.join('/package', 'prebuilds', 'linux-x64', 'arti-socks')])
})

test('target/debug sidecar requires explicit dev opt-in', (t) => {
  const debug = path.join('/package', 'target', 'debug', 'arti-socks')
  const selected = resolveSidecarBinary(
    { dev: true },
    {
      platform: 'linux',
      arch: 'x64',
      dirname: '/package',
      path,
      fs: { existsSync: (filename) => filename === debug }
    }
  )

  t.is(selected, debug)
})

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
