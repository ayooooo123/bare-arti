const test = require('brittle')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { EventEmitter } = require('events')
const { spawn } = require('child_process')
const { createSidecar, resolveSidecarBinary } = require('../lib/sidecar')

const startSidecar = createSidecar({
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
const start = (options) => startSidecar(options).promise

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  return null
}

function fakeChild(killResult = true) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.killCalls = 0
  child.kill = () => {
    child.killCalls++
    return killResult
  }
  return child
}

function fakeSidecar(child, overrides = {}) {
  return createSidecar({
    platform: 'linux',
    arch: 'x64',
    dirname: '/package',
    fs: { existsSync: () => true },
    path,
    spawn: () => child,
    environment: {},
    setTimer: () => 1,
    clearTimer() {},
    ...overrides
  })
}

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
    const error = await rejection(start({ bin, timeout: 5000 }))
    t.is(error.code, 'ERR_ARTI_BOOTSTRAP')
    t.ok(error.message.includes('exited'))
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

test('sidecar stop during bootstrap is immediate, shared, and exit-confirmed', async (t) => {
  const child = fakeChild()
  const operation = fakeSidecar(child)({ bin: '/fake/arti-socks' })
  const startingOutcome = rejection(operation.promise)
  const firstStop = operation.stop()
  const matchingStop = operation.stop()
  let stopSettled = false
  firstStop.then(() => (stopSettled = true))

  t.is(firstStop, matchingStop)
  t.is(child.killCalls, 1)
  await Promise.resolve()
  t.is(stopSettled, false, 'waits for process exit')

  child.emit('exit', 0)
  await firstStop
  t.is((await startingOutcome).code, 'ERR_ARTI_CANCELLED')
})

test('sidecar handle stop is idempotent and waits for exit', async (t) => {
  const child = fakeChild()
  const operation = fakeSidecar(child)({ bin: '/fake/arti-socks' })
  child.stdout.emit('data', Buffer.from('19050\n'))
  const handle = await operation.promise
  const firstStop = handle.stop()
  const matchingStop = handle.stop()
  let settled = false
  firstStop.then(() => (settled = true))

  t.is(firstStop, matchingStop)
  t.is(child.killCalls, 1)
  await Promise.resolve()
  t.is(settled, false)
  child.emit('close', 0)
  await firstStop
})

test('unconfirmed sidecar kill rejects shutdown', async (t) => {
  const child = fakeChild(false)
  const operation = fakeSidecar(child)({ bin: '/fake/arti-socks' })
  child.stdout.emit('data', Buffer.from('19050\n'))
  const handle = await operation.promise
  const error = await rejection(handle.stop())

  t.is(error.code, 'ERR_ARTI_SHUTDOWN')
  t.ok(error.cause instanceof Error)
  t.is(child.killCalls, 1)
})

test('sidecar timeout is stable and cleanup-owned', async (t) => {
  const child = fakeChild()
  let timeoutCallback = null
  const operation = fakeSidecar(child, {
    setTimer(callback) {
      timeoutCallback = callback
      return 1
    }
  })({ bin: '/fake/arti-socks', timeout: 10 })
  const outcome = rejection(operation.promise)

  timeoutCallback()
  t.is(child.killCalls, 1)
  child.emit('exit', 0)
  t.is((await outcome).code, 'ERR_ARTI_TIMEOUT')
})

for (const failure of ['spawn', 'early-exit', 'invalid-port']) {
  test(`sidecar ${failure} maps to bootstrap`, async (t) => {
    const child = fakeChild()
    const operation = fakeSidecar(child)({ bin: '/fake/arti-socks' })
    const outcome = rejection(operation.promise)

    if (failure === 'spawn') child.emit('error', new Error('spawn failed'))
    if (failure === 'early-exit') child.emit('exit', 3)
    if (failure === 'invalid-port') child.stdout.emit('data', Buffer.from('invalid\n'))
    if (failure !== 'early-exit') child.emit('close', 0)

    t.is((await outcome).code, 'ERR_ARTI_BOOTSTRAP')
  })
}

test('sidecar validates options before spawn', async (t) => {
  let spawnCalls = 0
  const sidecar = fakeSidecar(fakeChild(), {
    spawn() {
      spawnCalls++
    }
  })

  t.is((await rejection(sidecar(null).promise)).code, 'ERR_ARTI_CONFIG')
  t.is((await rejection(sidecar({ bin: '/fake', timeout: 0 }).promise)).code, 'ERR_ARTI_CONFIG')
  t.is(spawnCalls, 0)
})

test('post-spawn setup failure is cleaned before bootstrap rejection', async (t) => {
  const child = fakeChild()
  const setupError = new Error('timer setup failed')
  const operation = fakeSidecar(child, {
    setTimer() {
      throw setupError
    }
  })({ bin: '/fake/arti-socks' })
  const outcome = rejection(operation.promise)
  let settled = false
  outcome.then(() => (settled = true))

  t.is(child.killCalls, 1)
  await Promise.resolve()
  t.is(settled, false)
  child.emit('exit', 0)
  const error = await outcome
  t.is(error.code, 'ERR_ARTI_BOOTSTRAP')
  t.is(error.cause, setupError)
})

test('post-spawn listener setup failure is stop-owned', async (t) => {
  const child = fakeChild()
  const setupError = new Error('stdout listener setup failed')
  child.stdout.on = () => {
    throw setupError
  }
  let operation = null
  let thrown = null
  try {
    operation = fakeSidecar(child)({ bin: '/fake/arti-socks' })
  } catch (error) {
    thrown = error
  }

  t.is(thrown, null, 'does not throw after spawning')
  if (thrown) return
  const outcome = rejection(operation.promise)
  t.is(child.killCalls, 1)
  child.emit('exit', 0)
  const error = await outcome
  t.is(error.code, 'ERR_ARTI_BOOTSTRAP')
  t.is(error.cause, setupError)
})

test('sidecar removes startup listeners after success', async (t) => {
  const child = fakeChild()
  const operation = fakeSidecar(child)({ bin: '/fake/arti-socks' })
  child.stdout.emit('data', Buffer.from('19050\n'))
  await operation.promise

  t.is(child.stdout.listenerCount('data'), 0)
  t.is(child.listenerCount('error'), 0)
  child.stdout.emit('data', Buffer.alloc(1024 * 1024))

  const stopping = operation.stop()
  child.emit('exit', 0)
  await stopping
})

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
