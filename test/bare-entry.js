const test = require('brittle')
const path = require('bare-path')

const arti = require('..')
const { createPublicApi } = require('../lib/public-api')

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  return null
}

test('Bare loads the root API with exact frozen exports', (t) => {
  t.alike(Object.keys(arti).sort(), ['acquire', 'start', 'stop'])
  t.ok(Object.isFrozen(arti))
})

test('Bare ios-simulator composition is addon-only and fails closed', async (t) => {
  const starts = []
  let sidecarStarts = 0
  const api = createPublicApi({
    global: {},
    platform: 'ios-simulator',
    arch: 'arm64',
    path,
    environment: { BARE_ARTI_DATA: '/app/private/arti' },
    loadAddon: () => ({
      matchesOptions: () => true,
      start(options) {
        starts.push(options)
        return Promise.resolve({ backend: 'addon', port: 19050 })
      },
      stop: () => Promise.resolve()
    }),
    startSidecar() {
      sidecarStarts++
    }
  })
  const lease = await api.acquire({})
  t.is(starts[0].backend, 'addon')
  t.is(starts[0].dataDir, '/app/private/arti')
  t.is(sidecarStarts, 0)
  await lease.release()

  const missing = createPublicApi({
    global: {},
    platform: 'ios-simulator',
    arch: 'arm64',
    path,
    environment: {},
    loadAddon: t.fail,
    startSidecar: t.fail
  })
  t.is((await rejection(missing.acquire({}))).code, 'ERR_ARTI_CONFIG')
})
