const test = require('brittle')
const Worker = require('bare-worker')

let binding

const options = (name, timeout = 30000) => ({
  dataDir: `/tmp/bare-arti-${name}-${Bare.pid}`,
  reachableAddressesString: '*:80,*:443',
  timeout
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function rejected(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  return null
}

function once(emitter, name) {
  return new Promise((resolve, reject) => {
    emitter.once(name, resolve)
    if (name !== 'error') emitter.once('error', reject)
  })
}

async function workerRealm(mode, generation) {
  const worker = new Worker(require.resolve('./addon-worker'), {
    workerData: { mode, generation }
  })
  const message = await once(worker, 'message')
  return { worker, message }
}

async function closeWorker(worker) {
  worker.ref()
  try {
    await worker.terminate()
  } finally {
    worker.unref()
  }
}

test('process realm ownership survives two serial worker cycles', async (t) => {
  t.timeout(10000)
  const keepAlive = setInterval(() => {}, 1000)
  t.teardown(() => clearInterval(keepAlive))

  const first = await workerRealm('starting', 7001)
  t.is(first.message.status, 'starting')
  const firstConflict = await workerRealm('loaded', 7002)
  t.is(firstConflict.message.code, 'ERR_ARTI_REALM_CONFLICT')
  await closeWorker(firstConflict.worker)
  await closeWorker(first.worker)

  const second = await workerRealm('running', 7003)
  t.is(second.message.status, 'running')
  const runningConflict = await workerRealm('loaded', 7004)
  t.is(runningConflict.message.code, 'ERR_ARTI_REALM_CONFLICT')
  await closeWorker(runningConflict.worker)
  await closeWorker(second.worker)

  const late = await workerRealm('late', 7005)
  t.is(late.message.status, 'starting')
  await closeWorker(late.worker)

  binding = require('../binding')
  t.is(typeof binding.start, 'function', 'main realm claims ownership after worker teardown')
  const diagnostics = binding.diagnostics()
  t.ok(diagnostics.late >= 1, 'late native callbacks after teardown do not touch JavaScript')
  t.is(diagnostics.jsAfterAbort, 0, 'aborted thread-safe functions run no JS callback')
  t.is(diagnostics.allocations, diagnostics.frees, 'teardown frees every worker request context')
})

test('raw addon startup returns immediately and keeps the Bare loop responsive', async (t) => {
  t.timeout(10000)
  const generation = 8001
  const ticks = []
  const before = Date.now()
  const starting = binding.start(options('slow-ready'), generation)
  const returnedAfter = Date.now() - before

  t.ok(starting instanceof Promise, 'returns a native Promise')
  t.ok(returnedAfter < 100, 'returns without blocking startup')

  await delay(1000)
  let previous = Date.now()
  const heartbeat = setInterval(() => {
    const now = Date.now()
    ticks.push(now - previous)
    previous = now
  }, 50)

  const result = await starting
  clearInterval(heartbeat)
  t.is(result.port, 19050, 'resolves the loopback SOCKS port')
  t.ok(ticks.length >= 30, 'heartbeats continue during delayed readiness')
  t.ok(Math.max(...ticks) < 250, 'no heartbeat gap exceeds 250ms')
  await binding.stop(generation)
  await delay(25)
})

test('raw start and stop while starting have distinct promises', async (t) => {
  const generation = 8002
  const starting = binding.start(options('delay-start'), generation)
  const stopping = binding.stop(generation)

  t.ok(starting instanceof Promise)
  t.ok(stopping instanceof Promise)
  t.not(starting, stopping, 'native start and stop own separate deferreds')
  const error = await rejected(starting)
  t.is(error && error.code, 'ERR_ARTI_CANCELLED')
  await stopping
  await delay(25)
})

test('synchronous native rejection releases its request context', async (t) => {
  const before = binding.diagnostics()
  let error = null
  try {
    binding.start(options('native-rejection'), 8099)
  } catch (caught) {
    error = caught
  }
  t.is(error && error.code, 'ERR_ARTI_BOOTSTRAP')
  await delay(25)
  const after = binding.diagnostics()
  t.is(after.allocations - before.allocations, 1)
  t.is(after.frees - before.frees, 1)
})

test('duplicate raw stop is rejected synchronously', async (t) => {
  const generation = 8003
  await binding.start(options('running'), generation)
  const stopping = binding.stop(generation)
  let error = null
  try {
    binding.stop(generation)
  } catch (caught) {
    error = caught
  }
  t.is(error && error.code, 'ERR_ARTI_SHUTDOWN')
  await stopping
  await delay(25)
})

test('duplicate native completion settles once and frees one context', async (t) => {
  const generation = 8004
  const before = binding.diagnostics()
  const result = await binding.start(options('duplicate-completion'), generation)
  t.is(result.port, 19050)
  await delay(25)
  const afterStart = binding.diagnostics()
  t.is(afterStart.allocations - before.allocations, 1)
  t.is(afterStart.frees - before.frees, 1)
  t.is(afterStart.completions - before.completions, 1)
  t.is(afterStart.duplicates - before.duplicates, 1)
  await binding.stop(generation)
  await delay(25)
})

test('raw addon can stop and restart with increasing generations', async (t) => {
  for (const generation of [8005, 8006]) {
    const result = await binding.start(options(`restart-${generation}`), generation)
    t.is(result.port, 19050)
    await binding.stop(generation)
  }
  await delay(25)
  const diagnostics = binding.diagnostics()
  t.is(diagnostics.allocations, diagnostics.frees, 'all request contexts are freed')
})
