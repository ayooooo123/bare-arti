const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { validateAddonOptions } = require('../lib/addon-controller')
const { ArtiError } = require('../lib/errors')

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
