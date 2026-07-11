const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { validateAddonOptions } = require('../lib/addon-controller')

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
  let error = null

  try {
    fn()
  } catch (caught) {
    error = caught
  }

  t.is(error && error.code, 'ERR_ARTI_CONFIG', message)
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

test('explicit maximum-normal timeout is accepted', (t) => {
  const root = temporaryDirectory()
  const dataDir = path.join(root, 'state')

  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

  const options = validateAddonOptions(
    { backend: 'addon', dataDir, timeout: 600000 },
    dependencies('ios')
  )

  t.is(options.timeout, 600000)
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
