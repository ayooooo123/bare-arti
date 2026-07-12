const test = require('brittle')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { gzipSize, verifyMobilePrebuilds } = require('../scripts/verify-mobile-prebuild')

const TARGETS = ['android-arm64', 'ios-arm64', 'ios-arm64-simulator']

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-arti-mobile-artifacts-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'prebuilds'), { recursive: true })
  fs.mkdirSync(path.join(root, 'manifests'), { recursive: true })

  for (const target of TARGETS) {
    const relative = `prebuilds/${target}/bare-arti.bare`
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `bare-arti fixture for ${target}\n`)
    fs.writeFileSync(
      path.join(root, 'manifests', `${target}.json`),
      JSON.stringify({ [relative]: sha256(file) })
    )
  }
  return root
}

test('accepts only the complete mobile module and manifest layout', (t) => {
  const root = fixture(t)
  const result = verifyMobilePrebuilds(root)
  t.alike(
    result.modules,
    TARGETS.map((target) => `prebuilds/${target}/bare-arti.bare`)
  )
  t.alike(
    result.manifests,
    TARGETS.map((target) => `manifests/${target}.json`)
  )
  t.ok(result.modules.every((relative) => gzipSize(path.join(root, relative)) > 0))
})

test('rejects missing, extra, and incorrectly named artifacts', (t) => {
  const missing = fixture(t)
  fs.rmSync(path.join(missing, 'prebuilds/android-arm64/bare-arti.bare'))
  t.exception(() => verifyMobilePrebuilds(missing), /artifact layout/)

  const extra = fixture(t)
  fs.writeFileSync(path.join(extra, 'manifests/unexpected.json'), '{}')
  t.exception(() => verifyMobilePrebuilds(extra), /artifact layout/)

  const misnamed = fixture(t)
  fs.renameSync(
    path.join(misnamed, 'prebuilds/ios-arm64/bare-arti.bare'),
    path.join(misnamed, 'prebuilds/ios-arm64/bare-arti.node')
  )
  t.exception(() => verifyMobilePrebuilds(misnamed), /artifact layout/)
})

test('rejects checksum mismatches and oversized compressed modules', (t) => {
  const mismatched = fixture(t)
  fs.writeFileSync(
    path.join(mismatched, 'manifests/android-arm64.json'),
    JSON.stringify({ 'prebuilds/android-arm64/bare-arti.bare': '0'.repeat(64) })
  )
  t.exception(() => verifyMobilePrebuilds(mismatched), /checksum/)

  const oversized = fixture(t)
  const file = path.join(oversized, 'prebuilds/android-arm64/bare-arti.bare')
  fs.writeFileSync(file, crypto.randomBytes(31 * 1024 * 1024))
  fs.writeFileSync(
    path.join(oversized, 'manifests/android-arm64.json'),
    JSON.stringify({ 'prebuilds/android-arm64/bare-arti.bare': sha256(file) })
  )
  t.exception(() => verifyMobilePrebuilds(oversized), /compressed size/)
})
