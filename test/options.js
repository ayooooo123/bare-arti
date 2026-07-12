const test = require('brittle')
const { isBare } = require('which-runtime')
const path = isBare ? require('bare-path') : require('path')

const { createOptionResolver } = require('../lib/options')
const { ArtiError } = require('../lib/errors')

function resolver(platform = 'linux', environment = {}) {
  return createOptionResolver({ platform, path, environment })
}

function configError(t, fn, message) {
  let error = null

  try {
    fn()
  } catch (caught) {
    error = caught
  }

  t.is(error && error.code, 'ERR_ARTI_CONFIG', message)
}

test('explicit absolute dataDir wins over BARE_ARTI_DATA', (t) => {
  const resolve = resolver('linux', { BARE_ARTI_DATA: '/environment' }).beginGeneration()

  t.is(resolve({ dataDir: '/explicit' }).dataDir, '/explicit')
})

test('absent explicit dataDir uses absolute BARE_ARTI_DATA', (t) => {
  const resolve = resolver('linux', { BARE_ARTI_DATA: '/environment' }).beginGeneration()

  t.is(resolve({}).dataDir, '/environment')
})

for (const dataDir of ['', 42, 'relative/path']) {
  test(`invalid explicit dataDir ${JSON.stringify(dataDir)} rejects without fallback`, (t) => {
    const resolve = resolver('linux', { BARE_ARTI_DATA: '/environment' }).beginGeneration()

    configError(t, () => resolve({ dataDir }))
  })
}

for (const dataDir of ['', 'relative/path']) {
  test(`invalid BARE_ARTI_DATA ${JSON.stringify(dataDir)} rejects without fallback`, (t) => {
    const resolve = resolver('linux', { BARE_ARTI_DATA: dataDir }).beginGeneration()

    configError(t, () => resolve({}))
  })
}

test('desktop sidecar permits an absent dataDir', (t) => {
  const resolved = resolver('linux').beginGeneration()({})

  t.is(resolved.backend, 'sidecar')
  t.is(resolved.dataDir, undefined)
})

test('reachableAddresses snapshots, sorts, deduplicates, and freezes relay endpoints', (t) => {
  const resolve = resolver('linux').beginGeneration()
  const input = ['*:443', '*:80', '*:443']
  const resolved = resolve({ reachableAddresses: input })

  input[0] = '*:1'
  t.alike(resolved.reachableAddresses, ['*:80', '*:443'])
  t.ok(Object.isFrozen(resolved.reachableAddresses))
  t.ok(Object.isFrozen(resolved))
})

for (const reachableAddresses of [
  null,
  false,
  ' *:443',
  [],
  [80],
  ['*:0'],
  ['*:65536'],
  ['*:*'],
  ['localhost:443']
]) {
  test(`invalid reachableAddresses ${JSON.stringify(reachableAddresses)} fails closed`, (t) => {
    configError(t, () => resolver('linux').beginGeneration()({ reachableAddresses }))
  })
}

test('reachableAddresses elements are snapshotted exactly once', (t) => {
  let reads = 0
  const reachableAddresses = []
  Object.defineProperty(reachableAddresses, 0, {
    enumerable: true,
    get() {
      reads++
      return reads === 1 ? '*:443' : '*:1'
    }
  })
  reachableAddresses.length = 1

  const resolved = resolver('linux').beginGeneration()({ reachableAddresses })
  t.is(reads, 1)
  t.alike(resolved.reachableAddresses, ['*:443'])
})

for (const length of [Symbol('length'), NaN, -1, 1.5, 65]) {
  test(`adversarial reachableAddresses length ${String(length)} fails stably`, (t) => {
    const value = new Proxy(['*:443'], {
      get(target, property, receiver) {
        if (property === 'length') return length
        return Reflect.get(target, property, receiver)
      }
    })
    configError(t, () => resolver('linux').beginGeneration()({ reachableAddresses: value }))
  })
}

for (const platform of ['android', 'ios', 'ios-simulator']) {
  test(`${platform} requires a dataDir for its default addon`, (t) => {
    const resolve = resolver(platform).beginGeneration()

    configError(t, () => resolve({}))
  })
}

test('explicit addon requires a dataDir', (t) => {
  const resolve = resolver('linux').beginGeneration()

  configError(t, () => resolve({ backend: 'addon' }))
})

test('addon rejects insecureFsPermissions true', (t) => {
  const resolve = resolver('linux').beginGeneration()

  configError(t, () =>
    resolve({ backend: 'addon', dataDir: '/private/arti', insecureFsPermissions: true })
  )
})

for (const insecureFsPermissions of [undefined, false]) {
  test(`addon accepts insecureFsPermissions ${String(insecureFsPermissions)}`, (t) => {
    const resolve = resolver('linux').beginGeneration()
    const options = { backend: 'addon', dataDir: '/private/arti' }
    if (insecureFsPermissions !== undefined) options.insecureFsPermissions = false

    t.is(resolve(options).insecureFsPermissions, insecureFsPermissions)
  })
}

for (const insecureFsPermissions of [true, false]) {
  test(`sidecar accepts insecureFsPermissions ${insecureFsPermissions}`, (t) => {
    const resolved = resolver('linux').beginGeneration()({ insecureFsPermissions })

    t.is(resolved.insecureFsPermissions, insecureFsPermissions)
  })
}

test('beginGeneration snapshots BARE_ARTI_DATA', (t) => {
  const environment = { BARE_ARTI_DATA: '/first' }
  const options = resolver('linux', environment)
  const firstGeneration = options.beginGeneration()

  environment.BARE_ARTI_DATA = '/second'

  t.is(firstGeneration({}).dataDir, '/first')
  t.is(firstGeneration({}).dataDir, '/first')
  t.is(options.beginGeneration()({}).dataDir, '/second')
})

for (const environment of [
  Object.defineProperty({}, 'BARE_ARTI_DATA', {
    get() {
      throw new Error('environment getter failed')
    }
  }),
  (() => {
    const environment = Proxy.revocable({}, {})
    environment.revoke()
    return environment.proxy
  })()
]) {
  test('environment read failures map to ERR_ARTI_CONFIG', (t) => {
    let error = null
    try {
      resolver('linux', environment).beginGeneration()
    } catch (caught) {
      error = caught
    }
    t.is(error && error.code, 'ERR_ARTI_CONFIG')
    t.ok(error && error.cause)
  })
}

for (const options of [undefined, null, false, [], 'options']) {
  test(`invalid options ${JSON.stringify(options)} reject`, (t) => {
    const resolve = resolver().beginGeneration()

    configError(t, () => resolve(options))
  })
}

for (const backend of ['', null, false, 'tor', 'ADDON']) {
  test(`invalid backend ${JSON.stringify(backend)} rejects`, (t) => {
    const resolve = resolver().beginGeneration()

    configError(t, () => resolve({ backend }))
  })
}

test('resolved options are frozen and preserve caller options', (t) => {
  const resolved = resolver().beginGeneration()({ timeout: 1234 })

  t.ok(Object.isFrozen(resolved))
  t.is(resolved.timeout, 1234)
})

test('security-relevant option accessors are read once and returned unchanged', (t) => {
  const reads = { backend: 0, dataDir: 0, insecureFsPermissions: 0 }
  const options = {
    get backend() {
      reads.backend++
      return 'sidecar'
    },
    get dataDir() {
      reads.dataDir++
      return reads.dataDir === 1 ? '/validated' : '/changed'
    },
    get insecureFsPermissions() {
      reads.insecureFsPermissions++
      return reads.insecureFsPermissions === 1 ? false : true
    }
  }

  const resolved = resolver().beginGeneration()(options)

  t.alike(reads, { backend: 1, dataDir: 1, insecureFsPermissions: 1 })
  t.is(resolved.backend, 'sidecar')
  t.is(resolved.dataDir, '/validated')
  t.is(resolved.insecureFsPermissions, false)
  t.ok(Object.isFrozen(resolved))
})

test('option accessor failures map to ERR_ARTI_CONFIG', (t) => {
  const failure = new Error('getter failed')
  const options = {
    get dataDir() {
      throw failure
    }
  }
  let error = null

  try {
    resolver().beginGeneration()(options)
  } catch (caught) {
    error = caught
  }

  t.is(error && error.code, 'ERR_ARTI_CONFIG')
  t.is(error && error.cause, failure)
})

test('option accessor cannot spoof an ERR_ARTI_CONFIG error', (t) => {
  const failure = new Error('spoofed config error')
  failure.code = 'ERR_ARTI_CONFIG'
  const options = {
    get dataDir() {
      throw failure
    }
  }
  let error = null

  try {
    resolver().beginGeneration()(options)
  } catch (caught) {
    error = caught
  }

  t.ok(error instanceof ArtiError)
  t.not(error, failure)
  t.is(error.code, 'ERR_ARTI_CONFIG')
  t.is(error.cause, failure)
})

test('revoked option proxies map inspection failures to ERR_ARTI_CONFIG', (t) => {
  const revocable = Proxy.revocable({}, {})
  revocable.revoke()
  let error = null

  try {
    resolver().beginGeneration()(revocable.proxy)
  } catch (caught) {
    error = caught
  }

  t.ok(error instanceof ArtiError)
  t.is(error.code, 'ERR_ARTI_CONFIG')
  t.ok(error.cause instanceof TypeError)
})
