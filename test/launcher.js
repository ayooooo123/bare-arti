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

function fakeChild(killResult) {
  if (arguments.length === 0) killResult = true
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
    setShutdownTimer: () => 2,
    clearShutdownTimer() {},
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

test('undefined Bare kill result waits for confirmed exit', async (t) => {
  const child = fakeChild(undefined)
  const operation = fakeSidecar(child)({ bin: '/fake/arti-socks' })
  child.stdout.emit('data', Buffer.from('19050\n'))
  const handle = await operation.promise
  const stopping = handle.stop()
  const stoppingOutcome = rejection(stopping)
  let settled = false
  stoppingOutcome.then(() => (settled = true))

  t.is(child.killCalls, 1)
  await Promise.resolve()
  t.is(settled, false, 'undefined means signal delivery is not known to have failed')
  child.emit('exit', 0)
  t.is(await stoppingOutcome, null)
})

test('real Node ENOENT remains bootstrap and confirms no child', async (t) => {
  const operation = startSidecar({
    bin: path.join(os.tmpdir(), `bare-arti-does-not-exist-${process.pid}`),
    timeout: 1000
  })
  const error = await rejection(operation.promise)

  t.is(error.code, 'ERR_ARTI_BOOTSTRAP')
  await operation.stopped
})

test('real Node EACCES remains bootstrap and confirms no child', async (t) => {
  const bin = path.join(os.tmpdir(), `bare-arti-not-executable-${process.pid}`)
  fs.writeFileSync(bin, '#!/bin/sh\necho 19050\n', { mode: 0o644 })

  try {
    const operation = startSidecar({ bin, timeout: 1000 })
    const error = await rejection(operation.promise)
    const stoppedError = await rejection(operation.stopped)

    t.is(error.code, 'ERR_ARTI_BOOTSTRAP')
    t.is(stoppedError, null, 'process absence is confirmed by close')
  } finally {
    fs.unlinkSync(bin)
  }
})

test('unspawned close confirmation is bounded', async (t) => {
  const child = fakeChild()
  const watchdogs = []
  const operation = fakeSidecar(child, {
    shutdownTimeout: 25,
    setShutdownTimer(callback) {
      watchdogs.push(callback)
      return watchdogs.length
    }
  })({ bin: '/fake/arti-socks' })
  const startingOutcome = rejection(operation.promise)
  const stoppedOutcome = rejection(operation.stopped)
  let settled = false
  stoppedOutcome.then(() => (settled = true))
  const error = new Error('permission denied before spawn')
  error.code = 'EACCES'
  child.emit('error', error)

  t.is(child.killCalls, 0, 'does not signal a process that never spawned')
  t.is(watchdogs.length, 1)
  watchdogs[0]()
  await Promise.resolve()
  await Promise.resolve()
  t.is(settled, true, 'watchdog settles unconfirmed process absence')
  if (!settled) {
    child.emit('close', -1)
    await startingOutcome
    return
  }
  t.is((await startingOutcome).code, 'ERR_ARTI_SHUTDOWN')
  t.is((await stoppedOutcome).code, 'ERR_ARTI_SHUTDOWN')
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

test('sidecar removes startup data listener and retains runtime error handler', async (t) => {
  const child = fakeChild()
  const operation = fakeSidecar(child)({ bin: '/fake/arti-socks' })
  child.stdout.emit('data', Buffer.from('19050\n'))
  await operation.promise

  t.is(child.stdout.listenerCount('data'), 0)
  t.is(child.listenerCount('error'), 1)
  child.stdout.emit('data', Buffer.alloc(1024 * 1024))

  const stopping = operation.stop()
  child.emit('exit', 0)
  await stopping
})

test('runtime child error remains handled and terminal', async (t) => {
  const child = fakeChild()
  const operation = fakeSidecar(child)({ bin: '/fake/arti-socks' })
  child.stdout.emit('data', Buffer.from('19050\n'))
  await operation.promise
  const runtimeError = new Error('runtime child failure')
  const stoppedOutcome = rejection(operation.stopped)
  let thrown = null
  try {
    child.emit('error', runtimeError)
  } catch (error) {
    thrown = error
  }

  t.is(thrown, null, 'runtime error remains observed')
  if (thrown) return
  t.is(child.killCalls, 1)
  child.emit('exit', 1)
  const error = await stoppedOutcome
  t.is(error.code, 'ERR_ARTI_SHUTDOWN')
  t.is(error.cause, runtimeError)
})

test('shutdown watchdog escalates then fails terminal without exit', async (t) => {
  const child = fakeChild()
  const watchdogs = []
  const operation = fakeSidecar(child, {
    shutdownTimeout: 25,
    setShutdownTimer(callback, timeout) {
      t.is(timeout, 25)
      watchdogs.push(callback)
      return watchdogs.length
    },
    clearShutdownTimer() {}
  })({ bin: '/fake/arti-socks' })
  child.stdout.emit('data', Buffer.from('19050\n'))
  const handle = await operation.promise
  const stopping = handle.stop()
  const stopOutcome = rejection(stopping)

  t.is(watchdogs.length, 1, 'arms confirmation watchdog')
  if (watchdogs.length === 0) return
  watchdogs[0]()
  t.is(child.killCalls, 2, 'escalates once')
  t.is(watchdogs.length, 2, 'arms final watchdog')
  watchdogs[1]()
  const error = await stopOutcome
  t.is(error.code, 'ERR_ARTI_SHUTDOWN')
  t.is((await rejection(operation.stopped)).code, 'ERR_ARTI_SHUTDOWN')
})

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
