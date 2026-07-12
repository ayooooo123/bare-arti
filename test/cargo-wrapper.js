const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const wrapper = path.join(__dirname, '..', 'scripts', 'locked-bin', 'cargo')

function run(t, args) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-arti-cargo-wrapper-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const realCargo = path.join(root, 'real-cargo')
  const log = path.join(root, 'argv.json')
  fs.writeFileSync(
    realCargo,
    '#!/bin/sh\nprintf \'[\' > "$BARE_ARTI_CARGO_LOG"\nfirst=1\nfor arg in "$@"; do\n  if [ "$first" = 0 ]; then printf \',\' >> "$BARE_ARTI_CARGO_LOG"; fi\n  first=0\n  printf \'"%s"\' "$arg" >> "$BARE_ARTI_CARGO_LOG"\ndone\nprintf \']\\n\' >> "$BARE_ARTI_CARGO_LOG"\n',
    { mode: 0o755 }
  )
  const result = spawnSync(wrapper, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      BARE_ARTI_REAL_CARGO: realCargo,
      BARE_ARTI_CARGO_LOG: log
    }
  })
  t.is(result.status, 0, result.stderr || 'wrapper exits successfully')
  return JSON.parse(fs.readFileSync(log, 'utf8'))
}

test('locked Cargo wrapper is executable', (t) => {
  t.ok((fs.statSync(wrapper).mode & 0o111) !== 0)
})

test('locked Cargo wrapper locks build and metadata', (t) => {
  t.alike(run(t, ['build', '--release']), ['build', '--release', '--locked'])
  t.alike(run(t, ['metadata', '--format-version', '1']), [
    'metadata',
    '--format-version',
    '1',
    '--locked'
  ])
})

test('locked Cargo wrapper rewrites only the invalid Android target', (t) => {
  t.alike(run(t, ['build', '--target', 'aarch64-unknown-android']), [
    'build',
    '--target',
    'aarch64-linux-android',
    '--locked'
  ])
  t.alike(run(t, ['build', '--target', 'x86_64-unknown-linux-gnu']), [
    'build',
    '--target',
    'x86_64-unknown-linux-gnu',
    '--locked'
  ])
})

test('locked Cargo wrapper passes unrelated subcommands through', (t) => {
  t.alike(run(t, ['test', '--all-targets']), ['test', '--all-targets'])
})

test('locked Cargo wrapper inserts locks before compiler arguments', (t) => {
  t.alike(run(t, ['build', '--release', '--', '--cfg', 'mobile_feature']), [
    'build',
    '--release',
    '--locked',
    '--',
    '--cfg',
    'mobile_feature'
  ])
  t.alike(run(t, ['metadata', '--', '--locked']), ['metadata', '--locked', '--', '--locked'])
})

test('locked Cargo wrapper leaves post-separator targets untouched', (t) => {
  t.alike(run(t, ['build', '--', '--target', 'aarch64-unknown-android']), [
    'build',
    '--locked',
    '--',
    '--target',
    'aarch64-unknown-android'
  ])
})
