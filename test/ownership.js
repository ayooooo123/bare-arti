const test = require('brittle')

const { createOwnership } = require('../lib/ownership')
const { artiError } = require('../lib/errors')

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

function fixture({
  pendingStart = false,
  pendingStop = false,
  failStop = null,
  serviceFactory = null
} = {}) {
  let generation = 0
  let active = null
  let startCalls = 0
  let nativeStarts = 0
  let stopCalls = 0
  const starts = []
  const stops = []

  function beginOptionsGeneration() {
    const current = ++generation
    return (options) =>
      Object.freeze({
        backend: options.backend || 'addon',
        dataDir: options.dataDir,
        generation: current
      })
  }

  function matches(left, right) {
    return left.backend === right.backend && left.dataDir === right.dataDir
  }

  function startBackend(options) {
    startCalls++
    if (active) {
      if (active.stopping) return Promise.reject(artiError('ERR_ARTI_CANCELLED', 'stopping'))
      if (!matches(active.options, options)) {
        return Promise.reject(artiError('ERR_ARTI_CONFIG_CONFLICT', 'conflict'))
      }
      return active.starting
    }

    nativeStarts++
    const control = deferred()
    const service = serviceFactory
      ? serviceFactory(nativeStarts, options)
      : Object.freeze({
          backend: options.backend,
          port: 19049 + nativeStarts,
          stop() {}
        })
    active = {
      options,
      control,
      service,
      starting: pendingStart ? control.promise : Promise.resolve(service),
      stopping: null
    }
    active.starting.then(null, () => {
      if (active && active.control === control && !active.stopping) active = null
    })
    starts.push(active)
    return active.starting
  }

  function stopBackend() {
    stopCalls++
    const owner = active
    if (!owner) return Promise.resolve()
    if (owner.stopping) return owner.stopping
    const control = deferred()
    stops.push(control)
    owner.stopping = pendingStop
      ? control.promise
      : failStop
        ? Promise.reject(failStop)
        : Promise.resolve()
    owner.stopping.then(
      () => {
        if (active === owner) active = null
        if (pendingStart) owner.control.reject(artiError('ERR_ARTI_CANCELLED', 'cancelled'))
      },
      () => {}
    )
    return owner.stopping
  }

  return {
    ownership: createOwnership({ startBackend, stopBackend, beginOptionsGeneration }),
    get generation() {
      return generation
    },
    get startCalls() {
      return startCalls
    },
    get nativeStarts() {
      return nativeStarts
    },
    get stopCalls() {
      return stopCalls
    },
    starts,
    stops
  }
}

test('matching acquisitions create distinct frozen leases and share one backend', async (t) => {
  const f = fixture()
  const first = await f.ownership.acquire({ dataDir: '/private/a' })
  const second = await f.ownership.acquire({ backend: 'addon', dataDir: '/private/a' })

  t.is(f.nativeStarts, 1)
  t.is(f.startCalls, 2)
  t.not(first, second)
  t.alike(Object.keys(first), ['backend', 'port', 'release'])
  t.ok(Object.isFrozen(first))
  t.is(first.backend, 'addon')
  t.is(first.port, 19050)

  const releasing = first.release()
  t.is(first.release(), releasing)
  await releasing
  t.is(f.stopCalls, 0)
  await second.release()
  t.is(f.stopCalls, 1)
  const restarted = await f.ownership.acquire({ dataDir: '/private/a' })
  t.is(f.generation, 2, 'the successful final shutdown clears the resolver')
  await restarted.release()
})

test('pending acquisitions reserve ownership and failure permits retry', async (t) => {
  const f = fixture({ pendingStart: true })
  const first = f.ownership.acquire({ dataDir: '/private/a' })
  const second = f.ownership.acquire({ dataDir: '/private/a' })
  f.starts[0].control.resolve(f.starts[0].service)

  const firstLease = await first
  const secondLease = await second
  await firstLease.release()
  t.is(f.stopCalls, 0)
  await secondLease.release()
  t.is(f.stopCalls, 1)

  const failedFixture = fixture({ pendingStart: true })
  const failed = failedFixture.ownership.acquire({ dataDir: '/private/a' })
  failedFixture.starts[0].control.reject(new Error('bootstrap failed'))
  t.is((await rejection(failed)).message, 'bootstrap failed')
  const retry = failedFixture.ownership.acquire({ dataDir: '/private/a' })
  t.is(failedFixture.generation, 2)
  failedFixture.starts[1].control.resolve(failedFixture.starts[1].service)
  await (await retry).release()
})

test('legacy start has one owner, one frozen wrapper, and backend stop stays private', async (t) => {
  const f = fixture()
  const first = f.ownership.start({ dataDir: '/private/a' })
  const repeated = f.ownership.start({ backend: 'addon', dataDir: '/private/a' })
  t.is(repeated, first)
  const service = await first

  t.alike(Object.keys(service), ['backend', 'port', 'stop'])
  t.ok(Object.isFrozen(service))
  t.is(f.nativeStarts, 1)
  t.is(f.startCalls, 2)
  const stopping = service.stop()
  t.is(f.ownership.stop(), stopping)
  await stopping
  t.is(f.stopCalls, 1)
})

test('a stale legacy handle cannot stop a restarted generation', async (t) => {
  const f = fixture()
  const stale = await f.ownership.start({ dataDir: '/private/a' })
  const firstStop = stale.stop()
  t.is(stale.stop(), firstStop)
  await firstStop

  const current = await f.ownership.start({ dataDir: '/private/a' })
  t.is(stale.stop(), firstStop)
  t.is(f.stopCalls, 1, 'stale handle does not release the current legacy owner')
  await current.stop()
  t.is(f.stopCalls, 2)
})

test('legacy conflicts propagate without changing its owner', async (t) => {
  const f = fixture({ pendingStart: true })
  const first = f.ownership.start({ dataDir: '/private/a' })
  const conflict = f.ownership.start({ dataDir: '/private/b' })
  t.is((await rejection(conflict)).code, 'ERR_ARTI_CONFIG_CONFLICT')
  f.starts[0].control.resolve(f.starts[0].service)
  const service = await first
  await service.stop()
  t.is(f.stopCalls, 1)
})

test('running legacy starts preserve public promise identity and ownership', async (t) => {
  const f = fixture()
  const first = f.ownership.start({ dataDir: '/private/a' })
  const service = await first

  t.is(f.ownership.start({ dataDir: '/private/a' }), first, 'matching promise is exact')
  t.is(
    f.ownership.start({ backend: 'addon', dataDir: '/private/a' }),
    first,
    'canonical-equivalent promise is exact'
  )
  t.is(
    (await rejection(f.ownership.start({ dataDir: '/private/b' }))).code,
    'ERR_ARTI_CONFIG_CONFLICT'
  )
  t.is(f.nativeStarts, 1, 'the conflict does not replace the running owner')
  await service.stop()
  t.is(f.stopCalls, 1, 'the original service performs the sole final stop')
})

test('a failed reservation performs the deferred final shutdown', async (t) => {
  const f = fixture()
  const lease = await f.ownership.acquire({ dataDir: '/private/a' })
  const conflict = f.ownership.acquire({ dataDir: '/private/b' })
  const released = lease.release()
  t.is(f.stopCalls, 0, 'the pending reservation holds the backend')
  await released
  t.is((await rejection(conflict)).code, 'ERR_ARTI_CONFIG_CONFLICT')
  await Promise.resolve()
  t.is(f.stopCalls, 1, 'reservation failure transitions ownership to zero')
})

test('legacy and acquired ownership release independently', async (t) => {
  const f = fixture()
  const legacy = await f.ownership.start({ dataDir: '/private/a' })
  const lease = await f.ownership.acquire({ dataDir: '/private/a' })
  await lease.release()
  t.is(f.stopCalls, 0, 'legacy survives acquired release')
  await legacy.stop()
  t.is(f.stopCalls, 1)

  const g = fixture()
  const legacyAgain = await g.ownership.start({ dataDir: '/private/a' })
  const leaseAgain = await g.ownership.acquire({ dataDir: '/private/a' })
  await legacyAgain.stop()
  t.is(g.stopCalls, 0, 'lease survives legacy stop')
  await leaseAgain.release()
  t.is(g.stopCalls, 1)
})

test('an acquired reservation prevents pending legacy stop', async (t) => {
  const f = fixture({ pendingStart: true })
  const legacy = f.ownership.start({ dataDir: '/private/a' })
  const acquiring = f.ownership.acquire({ dataDir: '/private/a' })
  await f.ownership.stop()
  t.is(f.stopCalls, 0)
  f.starts[0].control.resolve(f.starts[0].service)
  await legacy
  const lease = await acquiring
  await lease.release()
  t.is(f.stopCalls, 1)
})

test('stopping a pending legacy start preserves cancellation and blocks retry', async (t) => {
  const f = fixture({ pendingStart: true, pendingStop: true })
  const starting = f.ownership.start({ dataDir: '/private/a' })
  const stopping = f.ownership.stop()
  const retry = f.ownership.start({ dataDir: '/private/a' })
  t.is((await rejection(retry)).code, 'ERR_ARTI_CANCELLED')
  f.stops[0].resolve()
  await stopping
  t.is((await rejection(starting)).code, 'ERR_ARTI_CANCELLED')

  const restarted = f.ownership.start({ dataDir: '/private/a' })
  f.starts[1].control.resolve(f.starts[1].service)
  await restarted
  t.is(f.generation, 2)
  const stopped = f.ownership.stop()
  f.stops[1].resolve()
  await stopped
})

test('acquire during final stopping rejects until shutdown settles', async (t) => {
  const f = fixture({ pendingStop: true })
  const lease = await f.ownership.acquire({ dataDir: '/private/a' })
  const stopping = lease.release()
  const blocked = f.ownership.acquire({ dataDir: '/private/a' })
  t.is((await rejection(blocked)).code, 'ERR_ARTI_CANCELLED')
  f.stops[0].resolve()
  await stopping
  const restarted = await f.ownership.acquire({ dataDir: '/private/a' })
  t.is(f.nativeStarts, 2)
  const restopping = restarted.release()
  f.stops[1].resolve()
  await restopping
})

test('final stop publishes its promise before calling a reentrant backend', async (t) => {
  const nativeStop = deferred()
  let ownership = null
  let nativeStarts = 0
  let nativeStops = 0
  let reentrantAcquire = null
  let reentrantStart = null
  let reentrantStop = null
  const service = Object.freeze({ backend: 'addon', port: 19050 })

  ownership = createOwnership({
    beginOptionsGeneration: () => (options) => options,
    startBackend() {
      nativeStarts++
      return Promise.resolve(service)
    },
    stopBackend() {
      nativeStops++
      reentrantAcquire = ownership.acquire({ backend: 'addon' })
      reentrantStart = ownership.start({ backend: 'addon' })
      reentrantAcquire.catch(() => {})
      reentrantStart.catch(() => {})
      reentrantStop = ownership.stop()
      return nativeStop.promise
    }
  })

  const lease = await ownership.acquire({ backend: 'addon' })
  const stopping = lease.release()
  t.is(reentrantStop, stopping, 'every stop caller receives the published sentinel')
  t.is(ownership.stop(), stopping, 'later stop callers receive the same promise')
  t.is((await rejection(reentrantAcquire)).code, 'ERR_ARTI_CANCELLED')
  t.is((await rejection(reentrantStart)).code, 'ERR_ARTI_CANCELLED')
  t.is(nativeStarts, 1, 'reentrant starts never reach the backend')
  t.is(nativeStops, 1, 'reentrant stop never enters the backend twice')

  nativeStop.resolve()
  await stopping
  const restarted = await ownership.acquire({ backend: 'addon' })
  t.is(nativeStarts, 2, 'state clears only after stop settlement')
  nativeStop.resolve()
  await restarted.release()
})

for (const kind of ['null', 'throwing backend getter', 'throwing port getter']) {
  for (const api of ['acquire', 'start']) {
    test(`${api} cleans a fulfilled ${kind} service before retry`, async (t) => {
      const getterError = new Error('untrusted getter failed')
      const f = fixture({
        serviceFactory(attempt, options) {
          if (attempt > 1) return Object.freeze({ backend: options.backend, port: 19050 })
          if (kind === 'null') return null
          return Object.defineProperties(
            {},
            {
              backend:
                kind === 'throwing backend getter'
                  ? {
                      get() {
                        throw getterError
                      }
                    }
                  : { value: 'addon' },
              port:
                kind === 'throwing port getter'
                  ? {
                      get() {
                        throw getterError
                      }
                    }
                  : { value: 19050 }
            }
          )
        }
      })

      const error = await rejection(f.ownership[api]({ dataDir: '/private/a' }))
      t.is(error.code, 'ERR_ARTI_BOOTSTRAP')
      if (kind !== 'null') t.is(error.cause, getterError)
      t.is(f.stopCalls, 1, 'malformed fulfilled backend is stopped')
      const restarted = await f.ownership[api]({ dataDir: '/private/a' })
      t.is(f.nativeStarts, 2, 'retry starts only after cleanup')
      await (api === 'acquire' ? restarted.release() : restarted.stop())
    })
  }
}

test('malformed service retry waits for cleanup settlement', async (t) => {
  const f = fixture({
    pendingStop: true,
    serviceFactory: (attempt, options) =>
      attempt === 1 ? null : Object.freeze({ backend: options.backend, port: 19050 })
  })
  const malformed = f.ownership.acquire({ dataDir: '/private/a' })
  await Promise.resolve()
  const premature = f.ownership.acquire({ dataDir: '/private/a' })
  t.is((await rejection(premature)).code, 'ERR_ARTI_CANCELLED')
  f.stops[0].resolve()
  t.is((await rejection(malformed)).code, 'ERR_ARTI_BOOTSTRAP')

  const restarted = await f.ownership.acquire({ dataDir: '/private/a' })
  t.is(f.nativeStarts, 2)
  const stopping = restarted.release()
  f.stops[1].resolve()
  await stopping
})

test('malformed service cleanup failure becomes terminal shutdown', async (t) => {
  const cleanupFailure = new Error('cleanup failed')
  const f = fixture({ failStop: cleanupFailure, serviceFactory: () => null })

  const error = await rejection(f.ownership.acquire({ dataDir: '/private/a' }))
  t.is(error.code, 'ERR_ARTI_SHUTDOWN')
  t.is(error.cause, cleanupFailure)
  t.is(await rejection(f.ownership.start({ dataDir: '/private/a' })), error)
  t.is(await rejection(f.ownership.stop()), error)
  t.is(f.nativeStarts, 1)
})

test('stop failures become terminal ERR_ARTI_SHUTDOWN errors', async (t) => {
  const cause = new Error('native stop failed')
  const f = fixture({ failStop: cause })
  const lease = await f.ownership.acquire({ dataDir: '/private/a' })
  const error = await rejection(lease.release())
  t.is(error.code, 'ERR_ARTI_SHUTDOWN')
  t.is(error.cause, cause)
  t.is(await rejection(f.ownership.start({ dataDir: '/private/a' })), error)
  t.is(await rejection(f.ownership.acquire({ dataDir: '/private/a' })), error)
  t.is(await rejection(f.ownership.stop()), error)
})

test('sync resolver and backend failures do not leak reservations', async (t) => {
  let generations = 0
  let attempts = 0
  const ownership = createOwnership({
    beginOptionsGeneration() {
      generations++
      return (options) => {
        if (options.invalid) throw artiError('ERR_ARTI_CONFIG', 'invalid')
        return options
      }
    },
    startBackend() {
      attempts++
      if (attempts === 1) throw new Error('sync start failure')
      return Promise.resolve({ backend: 'addon', port: 19050 })
    },
    stopBackend() {}
  })

  t.is((await rejection(ownership.acquire({ invalid: true }))).code, 'ERR_ARTI_CONFIG')
  t.is((await rejection(ownership.acquire({}))).message, 'sync start failure')
  const lease = await ownership.acquire({})
  t.is(generations, 3)
  await lease.release()
})
