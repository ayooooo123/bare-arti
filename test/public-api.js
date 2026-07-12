const test = require('brittle')
const path = require('path')

const { createPublicApi } = require('../lib/public-api')
const { getRegisteredOwnership } = require('../lib/registry')

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

function sidecarFactory(calls) {
  return function startSidecar(options) {
    calls.push(options)
    let resolveStopped
    const stopped = new Promise((resolve) => {
      resolveStopped = resolve
    })
    return {
      promise: Promise.resolve({ backend: 'sidecar', port: 19050 }),
      stop() {
        resolveStopped()
        return stopped
      },
      stopped
    }
  }
}

function api({
  global = {},
  platform = 'linux',
  environment = {},
  sidecarCalls = [],
  loadAddon = () => null,
  startSidecar = sidecarFactory(sidecarCalls)
} = {}) {
  return createPublicApi({
    global,
    platform,
    arch: 'arm64',
    path,
    environment,
    loadAddon,
    startSidecar
  })
}

test('package exports exactly acquire, start, and stop', (t) => {
  t.alike(Object.keys(require('..')).sort(), ['acquire', 'start', 'stop'])
})

test('same-realm duplicate compositions share the first physical backend', async (t) => {
  const global = {}
  const firstCalls = []
  const secondCalls = []
  const first = api({ global, sidecarCalls: firstCalls })
  const second = api({ global, sidecarCalls: secondCalls })

  t.is(first.acquire, second.acquire, 'both installs expose the exact registered ownership')
  const firstLease = await first.acquire({ dataDir: '/private/arti' })
  const secondLease = await second.acquire({ dataDir: '/private/arti' })
  t.is(firstCalls.length, 1, 'first backend factory owns the physical start')
  t.is(secondCalls.length, 0, 'duplicate backend factory is never used')
  await firstLease.release()
  await secondLease.release()
})

test('registry installs one frozen non-configurable versioned record', (t) => {
  const global = {}
  const ownership = { acquire() {}, start() {}, stop() {} }
  let creates = 0
  const first = getRegisteredOwnership({
    global,
    version: 1,
    create() {
      creates++
      return ownership
    }
  })
  const second = getRegisteredOwnership({
    global,
    version: 1,
    create() {
      creates++
      return {}
    }
  })
  const descriptor = Object.getOwnPropertyDescriptor(global, Symbol.for('bare-arti.ownership'))

  t.is(first, ownership)
  t.is(second, ownership)
  t.is(creates, 1)
  t.alike(Object.keys(descriptor.value), ['version', 'ownership'])
  t.ok(Object.isFrozen(descriptor.value))
  t.is(descriptor.configurable, false)
  t.is(descriptor.writable, false)
})

for (const record of [
  Object.freeze({ version: 2, ownership: { acquire() {}, start() {}, stop() {} } }),
  null,
  Object.freeze({ version: 1 }),
  Object.freeze({ version: 1, ownership: {}, extra: true })
]) {
  test('incompatible same-realm registry record rejects stably', (t) => {
    const global = {}
    let creates = 0
    Object.defineProperty(global, Symbol.for('bare-arti.ownership'), {
      value: record,
      configurable: false
    })
    let error = null
    try {
      getRegisteredOwnership({
        global,
        version: 1,
        create() {
          creates++
        }
      })
    } catch (caught) {
      error = caught
    }
    t.is(error && error.code, 'ERR_ARTI_CONFIG_CONFLICT')
    t.is(creates, 0, 'an incompatible record never constructs a second backend')
  })
}

test('a replaceable same-realm registry property rejects', (t) => {
  const global = {}
  Object.defineProperty(global, Symbol.for('bare-arti.ownership'), {
    value: Object.freeze({
      version: 1,
      ownership: { acquire() {}, start() {}, stop() {} }
    }),
    configurable: true
  })
  let creates = 0
  let error = null
  try {
    getRegisteredOwnership({
      global,
      version: 1,
      create() {
        creates++
      }
    })
  } catch (caught) {
    error = caught
  }
  t.is(error && error.code, 'ERR_ARTI_CONFIG_CONFLICT')
  t.is(creates, 0)
})

test('public composition snapshots environment per ownership generation', async (t) => {
  const environment = {}
  const calls = []
  const arti = api({ environment, sidecarCalls: calls })
  environment.BARE_ARTI_DATA = '/first'

  const first = await arti.acquire({})
  environment.BARE_ARTI_DATA = '/ignored'
  const second = await arti.acquire({})
  t.is(calls[0].dataDir, '/first', 'environment set after composition is observed')
  await first.release()
  await second.release()

  environment.BARE_ARTI_DATA = '/next'
  const next = await arti.acquire({})
  t.is(calls[1].dataDir, '/next', 'next fully-stopped generation rereads the environment')
  await next.release()
})

test('pending public startup retains its generation environment snapshot', async (t) => {
  const environment = { BARE_ARTI_DATA: '/pending' }
  const starting = deferred()
  const stopped = deferred()
  const calls = []
  const arti = api({
    environment,
    startSidecar(options) {
      calls.push(options)
      return {
        promise: starting.promise,
        stop() {
          stopped.resolve()
          return stopped.promise
        },
        stopped: stopped.promise
      }
    }
  })
  const first = arti.acquire({})
  environment.BARE_ARTI_DATA = '/ignored'
  const second = arti.acquire({})
  starting.resolve({ backend: 'sidecar', port: 19050 })

  const firstLease = await first
  const secondLease = await second
  t.is(calls.length, 1)
  t.is(calls[0].dataDir, '/pending')
  await firstLease.release()
  await secondLease.release()
})

test('public addon receives one frozen canonical option object', async (t) => {
  const starts = []
  const addon = {
    matchesOptions() {
      return true
    },
    start(options) {
      starts.push(options)
      return Promise.resolve({ backend: 'addon', port: 19050 })
    },
    stop() {
      return Promise.resolve()
    }
  }
  const arti = api({
    platform: 'android',
    environment: { BARE_ARTI_DATA: '/environment' },
    loadAddon: () => addon
  })
  const lease = await arti.acquire({ dataDir: '/explicit' })

  t.is(starts[0].dataDir, '/explicit')
  t.is(starts[0].backend, 'addon')
  t.ok(Object.isFrozen(starts[0]))
  await lease.release()

  const fallback = await arti.acquire({})
  t.is(starts[1].dataDir, '/environment')
  await fallback.release()

  const error = await rejection(arti.acquire({ dataDir: '/explicit', insecureFsPermissions: true }))
  t.is(error && error.code, 'ERR_ARTI_CONFIG')
  t.is(starts.length, 2, 'invalid permissions never reach the native addon')
})

test('desktop sidecar retains its no-data default', async (t) => {
  const calls = []
  const arti = api({ sidecarCalls: calls })
  const lease = await arti.acquire({})
  t.is(calls[0].dataDir, undefined)
  await lease.release()
})

test('public leases are distinct and legacy ownership stays compatible', async (t) => {
  const arti = api()
  const legacyStarting = arti.start({ dataDir: '/private/arti' })
  t.is(arti.start({ dataDir: '/private/arti' }), legacyStarting)
  const legacy = await legacyStarting
  const first = await arti.acquire({ dataDir: '/private/arti' })
  const second = await arti.acquire({ dataDir: '/private/arti' })

  t.not(first, second)
  t.alike(Object.keys(first), ['backend', 'port', 'release'])
  t.alike(Object.keys(legacy), ['backend', 'port', 'stop'])
  t.ok(Object.isFrozen(first))
  t.ok(Object.isFrozen(legacy))
  t.is(first.stop, undefined, 'native stop never leaks through a lease')
  await legacy.stop()
  await first.release()
  await second.release()
})
