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
    async startSidecar() {
      sidecarCalls++
      return expected
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

test('backend stop delegates to the selected backend', async (t) => {
  let stops = 0
  const backend = createBackend({
    platform: 'linux',
    arch: 'x64',
    loadAddon: t.fail,
    async startSidecar() {
      return { port: 19050, backend: 'sidecar', stop: () => stops++ }
    }
  })

  await backend.start({})
  await backend.stop()
  t.is(stops, 1)
})

test('public module exports only start and stop', (t) => {
  t.alike(Object.keys(require('..')).sort(), ['start', 'stop'])
})
