const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createAddonController, validateAddonOptions } = require('../lib/addon-controller')
const { ArtiError, artiError } = require('../lib/errors')

const dependencies = (platform) => ({
  platform,
  fs,
  path,
  getuid: typeof process.getuid === 'function' ? process.getuid : null
})

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bare-arti-addon-'))
}

function expectConfigError(t, fn, message) {
  const error = captureError(fn)

  t.is(error && error.code, 'ERR_ARTI_CONFIG', message)
}

function captureError(fn) {
  let error = null

  try {
    fn()
  } catch (caught) {
    error = caught
  }

  return error
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })

  return { promise, resolve, reject }
}

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }

  return null
}

function controllerOptions(binding, overrides = {}) {
  return {
    binding,
    validateOptions(options) {
      return Object.freeze({
        backend: 'addon',
        dataDir: options.dataDir,
        timeout: options.timeout || 600000
      })
    },
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    ...overrides
  }
}

test('valid Android addon options are normalized and frozen', (t) => {
  const root = temporaryDirectory()
  const dataDir = path.join(root, 'state')
  const beforeEnvironment = { ...process.env }

  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

  const options = validateAddonOptions(
    { backend: 'addon', dataDir, bootstrapTimeout: 42 },
    dependencies('android')
  )

  t.is(options.backend, 'addon', 'keeps the addon backend')
  t.is(options.timeout, 600000, 'uses the exact default timeout')
  t.absent(options.bootstrapTimeout, 'does not expose the obsolete timeout field')
  t.is(options.dataDir, fs.realpathSync(dataDir), 'returns the canonical path')
  t.ok(Object.isFrozen(options), 'freezes the normalized options')
  t.alike({ ...process.env }, beforeEnvironment, 'does not mutate process.env')
  t.is(fs.statSync(dataDir).mode & 0o777, 0o700, 'creates mode 0700')
})

test('explicit default timeout is accepted', (t) => {
  const root = temporaryDirectory()
  const dataDir = path.join(root, 'state')

  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

  const options = validateAddonOptions(
    { backend: 'addon', dataDir, timeout: 600000 },
    dependencies('ios')
  )

  t.is(options.timeout, 600000)
})

test('timeout boundaries are accepted', (t) => {
  for (const timeout of [1000, 1800000]) {
    const root = temporaryDirectory()
    const dataDir = path.join(root, 'state')

    const options = validateAddonOptions(
      { backend: 'addon', dataDir, timeout },
      dependencies('android')
    )

    t.is(options.timeout, timeout, `accepts ${timeout}`)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('invalid addon timeouts are rejected', (t) => {
  const invalid = [999, 1800001, 1000.5, '600000']

  for (const timeout of invalid) {
    const root = temporaryDirectory()
    const dataDir = path.join(root, 'state')

    expectConfigError(
      t,
      () => validateAddonOptions({ backend: 'addon', dataDir, timeout }, dependencies('android')),
      `rejects ${timeout}`
    )

    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('mobile addon requires an absolute data directory', (t) => {
  expectConfigError(
    t,
    () => validateAddonOptions({ backend: 'addon' }, dependencies('android')),
    'rejects a missing directory'
  )
  expectConfigError(
    t,
    () =>
      validateAddonOptions({ backend: 'addon', dataDir: 'relative/state' }, dependencies('ios')),
    'rejects a relative directory'
  )
})

test('mobile addon rejects an explicit non-addon backend', (t) => {
  const root = temporaryDirectory()
  const dataDir = path.join(root, 'state')

  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

  expectConfigError(
    t,
    () => validateAddonOptions({ backend: 'sidecar', dataDir }, dependencies('android')),
    'rejects sidecar backend'
  )
})

for (const platform of ['android', 'ios']) {
  test(`mobile addon rejects a final data directory symlink on ${platform}`, (t) => {
    const root = temporaryDirectory()
    const target = path.join(root, 'target')
    const dataDir = path.join(root, 'state')

    t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.mkdirSync(target, { mode: 0o700 })
    fs.symlinkSync(target, dataDir, 'dir')

    expectConfigError(
      t,
      () => validateAddonOptions({ backend: 'addon', dataDir }, dependencies(platform)),
      'rejects the symlink'
    )
  })
}

test('mobile addon rejects an owner mismatch when uid APIs exist', (t) => {
  const root = temporaryDirectory()
  const dataDir = path.join(root, 'state')
  fs.mkdirSync(dataDir, { mode: 0o700 })

  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

  const stat = fs.statSync(dataDir)
  expectConfigError(
    t,
    () =>
      validateAddonOptions(
        { backend: 'addon', dataDir },
        { platform: 'android', fs, path, getuid: () => stat.uid + 1 }
      ),
    'rejects a directory owned by another uid'
  )
})

test('mobile addon rejects group or other permissions', (t) => {
  const root = temporaryDirectory()
  const dataDir = path.join(root, 'state')
  fs.mkdirSync(dataDir, { mode: 0o750 })
  fs.chmodSync(dataDir, 0o750)

  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

  expectConfigError(
    t,
    () => validateAddonOptions({ backend: 'addon', dataDir }, dependencies('ios')),
    'rejects accessible group bits'
  )
})

for (const changedFinalEntry of ['identity', 'symlink']) {
  test(`mobile addon rejects a final ${changedFinalEntry} race`, (t) => {
    const root = temporaryDirectory()
    const dataDir = path.join(root, 'state')
    fs.mkdirSync(dataDir, { mode: 0o700 })
    const safe = fs.lstatSync(dataDir)
    let lstatCalls = 0
    const injectedFs = {
      ...fs,
      lstatSync(filename) {
        lstatCalls++
        if (lstatCalls === 1) return safe

        return {
          dev: changedFinalEntry === 'identity' ? safe.dev + 1 : safe.dev,
          ino: safe.ino,
          isSymbolicLink: () => changedFinalEntry === 'symlink'
        }
      }
    }

    t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

    expectConfigError(
      t,
      () =>
        validateAddonOptions(
          { backend: 'addon', dataDir },
          { ...dependencies('android'), fs: injectedFs }
        ),
      'rejects a changed final entry'
    )
  })
}

test('mobile addon rejects a stable replacement after the initial lstat', (t) => {
  const root = temporaryDirectory()
  const dataDir = path.join(root, 'state')
  fs.mkdirSync(dataDir, { mode: 0o700 })
  const replacement = fs.lstatSync(dataDir)
  let lstatCalls = 0
  const injectedFs = {
    ...fs,
    lstatSync(filename) {
      lstatCalls++
      if (lstatCalls > 1) return replacement

      return {
        dev: replacement.dev + 1,
        ino: replacement.ino,
        isSymbolicLink: () => false
      }
    }
  }

  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

  expectConfigError(
    t,
    () =>
      validateAddonOptions(
        { backend: 'addon', dataDir },
        { ...dependencies('android'), fs: injectedFs }
      ),
    'rejects replacement identity B even when it stays stable'
  )
})

test('filesystem failures preserve a stable ArtiError shape and cause', (t) => {
  const original = new Error('injected mkdir failure')
  const injectedFs = {
    mkdirSync() {
      throw original
    }
  }
  const error = captureError(() =>
    validateAddonOptions(
      { backend: 'addon', dataDir: '/private/arti' },
      { platform: 'android', fs: injectedFs, path, getuid: null }
    )
  )

  t.ok(error instanceof ArtiError, 'uses ArtiError')
  t.is(error.name, 'ArtiError', 'uses the stable error name')
  t.is(error.code, 'ERR_ARTI_CONFIG', 'uses the stable error code')
  t.is(error.cause, original, 'preserves the original cause')
})

test('controller start always returns a promise on synchronous validation failure', async (t) => {
  const expected = artiError('ERR_ARTI_CONFIG', 'invalid test config')
  const controller = createAddonController(
    controllerOptions(
      { start: t.fail, stop: t.fail },
      {
        validateOptions() {
          throw expected
        }
      }
    )
  )

  const starting = controller.start({})
  t.ok(starting instanceof Promise, 'returns a promise')
  t.is(await rejection(starting), expected, 'rejects with the validation error')
})

test('matching starts share one promise and conflicting starts reject', async (t) => {
  const nativeStart = deferred()
  let startCalls = 0
  const controller = createAddonController(
    controllerOptions({
      start() {
        startCalls++
        return nativeStart.promise
      },
      stop: t.fail
    })
  )
  const first = controller.start({ dataDir: '/private/a', timeout: 1000 })
  const matching = controller.start({ dataDir: '/private/a', timeout: 1000 })
  const conflicting = controller.start({ dataDir: '/private/b', timeout: 1000 })

  t.is(first, matching, 'returns the identical startup promise')
  t.is(startCalls, 1, 'starts native once')
  t.is((await rejection(conflicting)).code, 'ERR_ARTI_CONFIG_CONFLICT')

  nativeStart.resolve({ port: 19050 })
  const handle = await first
  t.is(handle.port, 19050)
})

test('timeout cancels native startup before rejecting all callers', async (t) => {
  const nativeStart = deferred()
  const nativeStop = deferred()
  let timeoutCallback = null
  const stopGenerations = []
  const controller = createAddonController(
    controllerOptions(
      {
        start: () => nativeStart.promise,
        stop(generation) {
          stopGenerations.push(generation)
          return nativeStop.promise
        }
      },
      {
        setTimer(callback, timeout) {
          t.is(timeout, 1000, 'arms the configured timeout')
          timeoutCallback = callback
          return 1
        },
        clearTimer() {}
      }
    )
  )
  const first = controller.start({ dataDir: '/private/a', timeout: 1000 })
  const matching = controller.start({ dataDir: '/private/a', timeout: 1000 })
  const firstOutcome = rejection(first)

  timeoutCallback()
  t.alike(stopGenerations, [1], 'cancels the native generation once')

  let settled = false
  firstOutcome.then(() => (settled = true))
  await Promise.resolve()
  t.is(settled, false, 'waits for native stop to settle')

  nativeStop.resolve()
  t.is((await firstOutcome).code, 'ERR_ARTI_TIMEOUT')
  t.is((await rejection(matching)).code, 'ERR_ARTI_TIMEOUT')

  nativeStart.resolve({ port: 19050 })
})

test('a cleared queued timeout cannot stop a running generation', async (t) => {
  let timeoutCallback = null
  let stopCalls = 0
  const controller = createAddonController(
    controllerOptions(
      {
        start: async () => ({ port: 19050 }),
        stop() {
          stopCalls++
          return Promise.resolve()
        }
      },
      {
        setTimer(callback) {
          timeoutCallback = callback
          return 1
        },
        clearTimer() {}
      }
    )
  )

  await controller.start({ dataDir: '/private/a' })
  timeoutCallback()
  await Promise.resolve()
  t.is(stopCalls, 0, 'ignores a timeout callback after startup completed')
})

test('controller stop during startup cancels the generation', async (t) => {
  const nativeStart = deferred()
  const nativeStop = deferred()
  let stopCalls = 0
  const controller = createAddonController(
    controllerOptions({
      start: () => nativeStart.promise,
      stop() {
        stopCalls++
        return nativeStop.promise
      }
    })
  )
  const starting = controller.start({ dataDir: '/private/a' })
  const startingOutcome = rejection(starting)
  const stopping = controller.stop()

  t.is(stopCalls, 1, 'cancels native once')
  nativeStop.resolve()
  await stopping
  t.is((await startingOutcome).code, 'ERR_ARTI_CANCELLED')
  nativeStart.resolve({ port: 19050 })
})

test('matching handles share one stop operation', async (t) => {
  const nativeStop = deferred()
  let stopCalls = 0
  const controller = createAddonController(
    controllerOptions({
      start: async () => ({ port: 19050 }),
      stop() {
        stopCalls++
        return nativeStop.promise
      }
    })
  )
  const first = controller.start({ dataDir: '/private/a' })
  const matching = controller.start({ dataDir: '/private/a' })
  const firstHandle = await first
  const matchingHandle = await matching

  t.is(firstHandle, matchingHandle, 'matching starts resolve to one handle')
  t.ok(Object.isFrozen(firstHandle), 'freezes the public handle')

  const firstStop = firstHandle.stop()
  const matchingStop = matchingHandle.stop()
  const controllerStop = controller.stop()
  t.is(firstStop, matchingStop, 'handle stops share one promise')
  t.is(firstStop, controllerStop, 'controller stop shares that promise')
  t.is(stopCalls, 1, 'stops native once')

  nativeStop.resolve()
  await firstStop
})

test('a stale handle cannot stop a restarted generation', async (t) => {
  const nativeStarts = [deferred(), deferred()]
  const nativeStops = [deferred(), deferred()]
  const stoppedGenerations = []
  const controller = createAddonController(
    controllerOptions({
      start(config, generation) {
        return nativeStarts[generation - 1].promise
      },
      stop(generation) {
        stoppedGenerations.push(generation)
        return nativeStops[generation - 1].promise
      }
    })
  )

  const firstStart = controller.start({ dataDir: '/private/a' })
  nativeStarts[0].resolve({ port: 19050 })
  const firstHandle = await firstStart
  const firstStop = firstHandle.stop()
  nativeStops[0].resolve()
  await firstStop

  const secondStart = controller.start({ dataDir: '/private/a' })
  nativeStarts[1].resolve({ port: 19051 })
  const secondHandle = await secondStart
  await firstHandle.stop()
  t.alike(stoppedGenerations, [1], 'stale stop does not reach native')

  const secondStop = secondHandle.stop()
  nativeStops[1].resolve()
  await secondStop
  t.alike(stoppedGenerations, [1, 2])
})

test('stopping blocks restart and settles only after native stop', async (t) => {
  const nativeStarts = [deferred(), deferred()]
  const nativeStop = deferred()
  let starts = 0
  const controller = createAddonController(
    controllerOptions({
      start() {
        return nativeStarts[starts++].promise
      },
      stop: () => nativeStop.promise
    })
  )
  const starting = controller.start({ dataDir: '/private/a' })
  nativeStarts[0].resolve({ port: 19050 })
  const handle = await starting
  const stopping = handle.stop()
  let stopSettled = false
  stopping.then(() => (stopSettled = true))
  const blockedStart = controller.start({ dataDir: '/private/a' })
  let blockedSettled = false
  let blockedError = null
  blockedStart.catch((error) => {
    blockedSettled = true
    blockedError = error
  })

  await Promise.resolve()
  t.is(stopSettled, false, 'stop remains pending with native')
  t.is(blockedSettled, false, 'start remains pending with native stop')
  t.is(starts, 1, 'does not restart early')

  nativeStop.resolve()
  await stopping
  await Promise.resolve()
  t.is(blockedError.code, 'ERR_ARTI_CANCELLED', 'rejects after native stop')
  const restarted = controller.start({ dataDir: '/private/a' })
  t.is(starts, 2, 'restarts only after native stop')
  nativeStarts[1].resolve({ port: 19051 })
  t.is((await restarted).port, 19051)
})

for (const nativeCompletion of ['resolve', 'reject']) {
  test(`native start ${nativeCompletion} during stop stays owned by stop`, async (t) => {
    const firstNativeStart = deferred()
    const secondNativeStart = deferred()
    const nativeStop = deferred()
    let startCalls = 0
    const controller = createAddonController(
      controllerOptions({
        start() {
          startCalls++
          return startCalls === 1 ? firstNativeStart.promise : secondNativeStart.promise
        },
        stop: () => nativeStop.promise
      })
    )
    const starting = controller.start({ dataDir: '/private/a' })
    const startingOutcome = rejection(starting)
    const stopping = controller.stop()

    if (nativeCompletion === 'resolve') firstNativeStart.resolve({ port: 19050 })
    else firstNativeStart.reject(new Error('late native failure'))

    let startSettled = false
    let stopSettled = false
    startingOutcome.then(() => (startSettled = true))
    stopping.then(() => (stopSettled = true))
    await Promise.resolve()
    await Promise.resolve()
    t.is(startSettled, false, 'does not settle cancelled start early')
    t.is(stopSettled, false, 'native stop remains the settlement owner')
    t.is(startCalls, 1, 'does not reset or restart')

    nativeStop.resolve()
    await stopping
    t.is((await startingOutcome).code, 'ERR_ARTI_CANCELLED')

    const restarted = controller.start({ dataDir: '/private/a' })
    t.is(startCalls, 2, 'restarts after native stop')
    secondNativeStart.resolve({ port: 19051 })
    t.is((await restarted).port, 19051)
  })
}

test('documented native errors are preserved and unknown failures map to bootstrap', async (t) => {
  const documented = artiError('ERR_ARTI_BIND', 'bind failed')
  const documentedController = createAddonController(
    controllerOptions({ start: () => Promise.reject(documented), stop: t.fail })
  )
  const preserved = await rejection(documentedController.start({ dataDir: '/private/a' }))
  t.is(preserved, documented, 'preserves the documented error object')

  const unknown = new Error('native exploded')
  const unknownController = createAddonController(
    controllerOptions({ start: () => Promise.reject(unknown), stop: t.fail })
  )
  const mapped = await rejection(unknownController.start({ dataDir: '/private/a' }))
  t.ok(mapped instanceof ArtiError)
  t.is(mapped.code, 'ERR_ARTI_BOOTSTRAP')
  t.is(mapped.cause, unknown)
})
