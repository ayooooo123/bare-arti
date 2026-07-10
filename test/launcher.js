const test = require('brittle')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { start } = require('..')

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

test('addon start receives scoped Arti environment options', async (t) => {
  const indexPath = require.resolve('..')
  const bindingPath = require.resolve('../binding')
  const cachedIndex = require.cache[indexPath]
  const cachedBinding = require.cache[bindingPath]
  const priorData = process.env.BARE_ARTI_DATA
  const priorPermissions = process.env.FS_MISTRUST_DISABLE_PERMISSIONS_CHECKS
  const observed = {}

  process.env.BARE_ARTI_DATA = 'prior-data'
  process.env.FS_MISTRUST_DISABLE_PERMISSIONS_CHECKS = 'prior-permissions'
  require.cache[bindingPath] = {
    exports: {
      start() {
        observed.data = process.env.BARE_ARTI_DATA
        observed.permissions = process.env.FS_MISTRUST_DISABLE_PERMISSIONS_CHECKS
        return 41338
      },
      stop() {}
    }
  }
  delete require.cache[indexPath]

  try {
    const fresh = require('..')
    const handle = await fresh.start({
      dataDir: '/tmp/bare-arti-test-data',
      insecureFsPermissions: true
    })

    t.is(handle.backend, 'addon')
    t.is(observed.data, '/tmp/bare-arti-test-data')
    t.is(observed.permissions, 'true')
    t.is(process.env.BARE_ARTI_DATA, 'prior-data')
    t.is(process.env.FS_MISTRUST_DISABLE_PERMISSIONS_CHECKS, 'prior-permissions')
  } finally {
    if (cachedIndex) require.cache[indexPath] = cachedIndex
    else delete require.cache[indexPath]
    if (cachedBinding) require.cache[bindingPath] = cachedBinding
    else delete require.cache[bindingPath]
    restoreEnv('BARE_ARTI_DATA', priorData)
    restoreEnv('FS_MISTRUST_DISABLE_PERMISSIONS_CHECKS', priorPermissions)
  }
})

test('overlapping addon starts restore the original environment', async (t) => {
  const indexPath = require.resolve('..')
  const bindingPath = require.resolve('../binding')
  const cachedIndex = require.cache[indexPath]
  const cachedBinding = require.cache[bindingPath]
  const priorData = process.env.BARE_ARTI_DATA
  const observed = []

  process.env.BARE_ARTI_DATA = 'original-data'
  require.cache[bindingPath] = {
    exports: {
      start() {
        observed.push(process.env.BARE_ARTI_DATA)
        return 41342
      },
      stop() {}
    }
  }
  delete require.cache[indexPath]

  try {
    const fresh = require('..')
    await Promise.all([
      fresh.start({ dataDir: 'first-data' }),
      fresh.start({ dataDir: 'second-data' })
    ])

    t.alike(observed, ['first-data', 'second-data'])
    t.is(process.env.BARE_ARTI_DATA, 'original-data')
  } finally {
    if (cachedIndex) require.cache[indexPath] = cachedIndex
    else delete require.cache[indexPath]
    if (cachedBinding) require.cache[bindingPath] = cachedBinding
    else delete require.cache[bindingPath]
    restoreEnv('BARE_ARTI_DATA', priorData)
  }
})

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
