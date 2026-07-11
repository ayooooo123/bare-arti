const test = require('brittle')

const { createBackend } = require('../lib/backend')
const { ArtiError } = require('../lib/errors')

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }

  return null
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

const never = new Promise(() => {})

function sidecarOperation(starting, stopping = never) {
  return { promise: starting, stop: () => stopping, stopped: stopping }
}

function observableAddon({ start, stop }) {
  const observers = new Set()
  return {
    start,
    stop,
    observeLifecycle(observer) {
      observers.add(observer)
      return () => observers.delete(observer)
    },
    emit(event) {
      for (const observer of observers) observer(event)
    }
  }
}

for (const platform of ['android', 'ios']) {
  test(`${platform} requires the addon and never falls back to sidecar`, async (t) => {
    let sidecarCalls = 0
    const missing = new Error('missing addon prebuild')
    const backend = createBackend({
      platform,
      arch: 'arm64',
      loadAddon() {
        throw missing
      },
      startSidecar() {
        sidecarCalls++
      }
    })

    const error = await rejection(backend.start({ dataDir: '/private/arti' }))
    t.ok(error instanceof ArtiError)
    t.is(error.code, 'ERR_ARTI_ADDON_MISSING')
    t.is(error.cause, missing)
    t.is(sidecarCalls, 0)
  })

  test(`${platform} rejects an explicit sidecar`, async (t) => {
    let addonLoads = 0
    let sidecarCalls = 0
    const backend = createBackend({
      platform,
      arch: 'arm64',
      loadAddon() {
        addonLoads++
      },
      startSidecar() {
        sidecarCalls++
      }
    })

    const error = await rejection(backend.start({ backend: 'sidecar' }))
    t.is(error.code, 'ERR_ARTI_UNSUPPORTED_PLATFORM')
    t.is(addonLoads, 0)
    t.is(sidecarCalls, 0)
  })
}

test('desktop defaults to sidecar without loading addon', async (t) => {
  let addonLoads = 0
  let sidecarCalls = 0
  const expected = Object.freeze({ port: 19050, backend: 'sidecar', stop() {} })
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon() {
      addonLoads++
    },
    startSidecar() {
      sidecarCalls++
      return sidecarOperation(Promise.resolve(expected))
    }
  })

  t.is(await backend.start({}), expected)
  t.is(addonLoads, 0)
  t.is(sidecarCalls, 1)
})

test('desktop explicit addon starts only addon', async (t) => {
  let addonStarts = 0
  let sidecarCalls = 0
  const expected = Object.freeze({ port: 19050, backend: 'addon', stop() {} })
  const backend = createBackend({
    platform: 'darwin',
    arch: 'arm64',
    loadAddon() {
      return {
        async start(options) {
          addonStarts++
          t.is(options.backend, 'addon')
          return expected
        },
        stop() {}
      }
    },
    startSidecar() {
      sidecarCalls++
    }
  })

  t.is(await backend.start({ backend: 'addon', dataDir: '/private/arti' }), expected)
  t.is(addonStarts, 1)
  t.is(sidecarCalls, 0)
})

test('matching addon starts share one stored backend promise', async (t) => {
  const nativeStart = deferred()
  let startCalls = 0
  const addon = observableAddon({
    start() {
      startCalls++
      return nativeStart.promise
    },
    stop: () => Promise.resolve()
  })
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon: () => addon,
    startSidecar: t.fail
  })
  const first = backend.start({ backend: 'addon', dataDir: '/private/a', timeout: 1000 })
  const matching = backend.start({ backend: 'addon', dataDir: '/private/a', timeout: 1000 })
  const conflicting = backend.start({
    backend: 'addon',
    dataDir: '/private/b',
    timeout: 1000
  })

  t.is(first, matching)
  t.is(startCalls, 1)
  nativeStart.resolve({ port: 19050, backend: 'addon', stop() {} })
  const conflictError = await rejection(conflicting)
  t.is(conflictError && conflictError.code, 'ERR_ARTI_CONFIG_CONFLICT')
  await first
})

test('backend stop delegates to the selected backend', async (t) => {
  let stops = 0
  const stopped = deferred()
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon: t.fail,
    startSidecar: () => ({
      promise: Promise.resolve({ port: 19050, backend: 'sidecar', stop() {} }),
      stop() {
        stops++
        stopped.resolve()
        return stopped.promise
      },
      stopped: stopped.promise
    })
  })

  await backend.start({})
  await backend.stop()
  t.is(stops, 1)
})

test('public module exports only start and stop', (t) => {
  t.alike(Object.keys(require('..')).sort(), ['start', 'stop'])
})

test('matching sidecar starts share one operation', async (t) => {
  const starting = deferred()
  let sidecarCalls = 0
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon: t.fail,
    startSidecar() {
      sidecarCalls++
      return sidecarOperation(starting.promise)
    }
  })
  const first = backend.start({ dataDir: '/private/a', timeout: 1000 })
  const matching = backend.start({ dataDir: '/private/a', timeout: 1000 })

  t.is(first, matching, 'shares the identical promise')
  t.is(sidecarCalls, 1, 'spawns once')
  starting.resolve({ port: 19050, backend: 'sidecar', stop() {} })
  await first
})

test('active sidecar rejects conflicting config and backend', async (t) => {
  const starting = deferred()
  let addonLoads = 0
  let sidecarCalls = 0
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon() {
      addonLoads++
    },
    startSidecar() {
      sidecarCalls++
      return sidecarOperation(starting.promise)
    }
  })
  backend.start({ dataDir: '/private/a', timeout: 1000 })

  t.is(
    (await rejection(backend.start({ dataDir: '/private/b', timeout: 1000 }))).code,
    'ERR_ARTI_CONFIG_CONFLICT'
  )
  t.is(
    (await rejection(backend.start({ backend: 'addon', dataDir: '/private/a' }))).code,
    'ERR_ARTI_CONFIG_CONFLICT'
  )
  t.is(sidecarCalls, 1)
  t.is(addonLoads, 0)
  starting.resolve({ port: 19050, backend: 'sidecar', stop() {} })
})

test('active addon prevents a sidecar spawn', async (t) => {
  const addonStart = deferred()
  let sidecarCalls = 0
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon() {
      return { start: () => addonStart.promise, stop() {} }
    },
    startSidecar() {
      sidecarCalls++
    }
  })
  backend.start({ backend: 'addon', dataDir: '/private/a' })
  const error = await rejection(backend.start({ dataDir: '/private/a' }))

  t.is(error.code, 'ERR_ARTI_CONFIG_CONFLICT')
  t.is(sidecarCalls, 0)
  addonStart.resolve({ port: 19050, backend: 'addon', stop() {} })
})

test('sidecar stop owns bootstrap settlement and backend switching', async (t) => {
  const starting = deferred()
  const stopping = deferred()
  let sidecarStops = 0
  let addonStarts = 0
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon() {
      return {
        start() {
          addonStarts++
          return Promise.resolve({ port: 19051, backend: 'addon', stop() {} })
        },
        stop() {}
      }
    },
    startSidecar() {
      return {
        promise: starting.promise,
        stopped: stopping.promise,
        stop() {
          sidecarStops++
          return stopping.promise
        }
      }
    }
  })
  const first = backend.start({ dataDir: '/private/a' })
  const firstOutcome = rejection(first)
  const firstStop = backend.stop()
  const matchingStop = backend.stop()
  const blockedStart = backend.start({ backend: 'addon', dataDir: '/private/a' })
  let blockedSettled = false
  blockedStart.catch(() => (blockedSettled = true))

  t.is(firstStop, matchingStop, 'shares the stop promise')
  t.is(sidecarStops, 1, 'requests sidecar stop once')
  await Promise.resolve()
  t.is(blockedSettled, false, 'new backend waits for stop')
  t.is(addonStarts, 0)

  starting.reject(new Error('cancelled by sidecar stop'))
  await Promise.resolve()
  t.is((await firstOutcome) instanceof Error, true, 'startup is handled while stopping')
  stopping.resolve()
  await firstStop
  const blockedError = await rejection(blockedStart)
  t.is(blockedError && blockedError.code, 'ERR_ARTI_CANCELLED')
  t.is((await backend.start({ backend: 'addon', dataDir: '/private/a' })).port, 19051)
  t.is(addonStarts, 1, 'switches only after confirmed stop')
})

test('failed sidecar startup releases ownership only after confirmed cleanup', async (t) => {
  const firstStart = deferred()
  const firstStop = deferred()
  const secondStart = deferred()
  let operations = 0
  let stopCalls = 0
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon: t.fail,
    startSidecar() {
      operations++
      if (operations === 1) {
        return {
          promise: firstStart.promise,
          stopped: firstStop.promise,
          stop() {
            stopCalls++
            return firstStop.promise
          }
        }
      }
      return sidecarOperation(secondStart.promise)
    }
  })
  const starting = backend.start({ dataDir: '/private/a' })
  firstStart.reject(new Error('bootstrap failed'))
  await rejection(starting)
  const blocked = backend.start({ dataDir: '/private/a' })
  let blockedSettled = false
  blocked.catch(() => (blockedSettled = true))

  await Promise.resolve()
  t.is(stopCalls, 1, 'cleanup owns the failed operation')
  t.is(blockedSettled, false, 'does not clear ownership before cleanup')
  t.is(operations, 1)

  firstStop.resolve()
  t.is((await rejection(blocked)).code, 'ERR_ARTI_CANCELLED')
  const restarted = backend.start({ dataDir: '/private/a' })
  t.is(operations, 2)
  secondStart.resolve({ port: 19051, backend: 'sidecar', stop() {} })
  t.is((await restarted).port, 19051)
})

test('confirmed handle-level sidecar stop releases backend ownership', async (t) => {
  const stopped = deferred()
  let operations = 0
  const stop = () => stopped.promise
  const firstHandle = { port: 19050, backend: 'sidecar', stop }
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon: t.fail,
    startSidecar() {
      operations++
      if (operations === 1) {
        return { promise: Promise.resolve(firstHandle), stop, stopped: stopped.promise }
      }
      return sidecarOperation(
        Promise.resolve({ port: 19051, backend: 'sidecar', stop() {} }),
        Promise.resolve()
      )
    }
  })
  const handle = await backend.start({ dataDir: '/private/a' })
  const stopping = handle.stop()
  const beforeExit = backend.start({ dataDir: '/private/a' })

  t.is(await beforeExit, firstHandle, 'retains ownership before confirmed stop')
  t.is(operations, 1)
  stopped.resolve()
  await stopping
  await Promise.resolve()

  t.is((await backend.start({ dataDir: '/private/a' })).port, 19051)
  t.is(operations, 2, 'starts a new operation after confirmed handle stop')
})

test('invalid addon candidate is never cached', async (t) => {
  let loads = 0
  const backend = createBackend({
    platform: 'android',
    arch: 'arm64',
    loadAddon() {
      loads++
      return { start() {} }
    },
    startSidecar: t.fail
  })

  t.is((await rejection(backend.start({ dataDir: '/private/a' }))).code, 'ERR_ARTI_ADDON_MISSING')
  t.is((await rejection(backend.start({ dataDir: '/private/a' }))).code, 'ERR_ARTI_ADDON_MISSING')
  t.is(loads, 2, 'validates before caching')
})

test('start null rejects a promise config error', async (t) => {
  let sidecarCalls = 0
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon: t.fail,
    startSidecar() {
      sidecarCalls++
    }
  })
  const starting = backend.start(null)

  t.ok(starting instanceof Promise)
  t.is((await rejection(starting)).code, 'ERR_ARTI_CONFIG')
  t.is(sidecarCalls, 0)
})

test('rejected addon startup cleans ownership before sidecar', async (t) => {
  const bootstrap = new Error('addon bootstrap failed')
  let sidecarCalls = 0
  let addon
  addon = observableAddon({
    start: () => Promise.reject(bootstrap),
    stop() {
      return Promise.resolve().then(() => addon.emit({ status: 'stopped' }))
    }
  })
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon: () => addon,
    startSidecar() {
      sidecarCalls++
      return sidecarOperation(Promise.resolve({ port: 19051, backend: 'sidecar', stop() {} }))
    }
  })

  await rejection(backend.start({ backend: 'addon', dataDir: '/private/a' }))
  const started = await backend.start({ dataDir: '/private/a' })
  t.is(started && started.port, 19051)
  t.is(sidecarCalls, 1)
})

test('addon cleanup failure dominates rejected startup', async (t) => {
  const bootstrap = new Error('addon bootstrap failed')
  const cleanup = new Error('addon cleanup failed')
  const addon = observableAddon({
    start: () => Promise.reject(bootstrap),
    stop: () => Promise.reject(cleanup)
  })
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon: () => addon,
    startSidecar: t.fail
  })
  const error = await rejection(
    backend.start({ backend: 'addon', dataDir: '/private/a', timeout: 1000 })
  )

  t.is(error.code, 'ERR_ARTI_SHUTDOWN')
  t.is(error.cause, cleanup)
  t.is(
    (await rejection(backend.start({ backend: 'addon', dataDir: '/private/a' }))).code,
    'ERR_ARTI_SHUTDOWN'
  )
})

test('direct addon handle stop releases backend ownership', async (t) => {
  let addon
  addon = observableAddon({
    start: () =>
      Promise.resolve({
        port: 19050,
        backend: 'addon',
        stop() {
          addon.emit({ status: 'stopped' })
          return Promise.resolve()
        }
      }),
    stop: () => Promise.resolve()
  })
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon: () => addon,
    startSidecar: () =>
      sidecarOperation(Promise.resolve({ port: 19051, backend: 'sidecar', stop() {} }))
  })
  const handle = await backend.start({ backend: 'addon', dataDir: '/private/a' })
  await handle.stop()
  await Promise.resolve()

  t.is((await backend.start({ dataDir: '/private/a' })).port, 19051)
})

test('terminal addon lifecycle blocks every backend', async (t) => {
  const shutdown = new ArtiError('ERR_ARTI_SHUTDOWN', 'terminal addon failure')
  let addon
  addon = observableAddon({
    start: () => Promise.resolve({ port: 19050, backend: 'addon', stop() {} }),
    stop: () => Promise.reject(shutdown)
  })
  let sidecarCalls = 0
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon: () => addon,
    startSidecar() {
      sidecarCalls++
    }
  })
  await backend.start({ backend: 'addon', dataDir: '/private/a' })
  addon.emit({ status: 'failed', error: shutdown })

  const error = await rejection(backend.start({ dataDir: '/private/a' }))
  t.is(error && error.code, 'ERR_ARTI_SHUTDOWN')
  t.is(sidecarCalls, 0)
})
