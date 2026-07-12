const test = require('brittle')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { verifyPackagePrebuilds } = require('../scripts/verify-package-prebuilds')

const SOURCE_SHA = 'a'.repeat(40)
const SIDECARS = [
  ['linux-x64', 'arti-socks'],
  ['linux-arm64', 'arti-socks'],
  ['darwin-x64', 'arti-socks'],
  ['darwin-arm64', 'arti-socks'],
  ['win32-x64', 'arti-socks.exe']
]

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function fixture(t, { addon = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-arti-package-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const artifacts = []
  for (const [target, name] of SIDECARS) {
    const relative = `prebuilds/${target}/${name}`
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${target} sidecar`)
    artifacts.push({ target, kind: 'sidecar', path: relative, sha256: sha256(file) })
  }
  if (addon) {
    const relative = 'prebuilds/darwin-arm64/bare-arti.bare'
    const file = path.join(root, relative)
    fs.writeFileSync(file, 'current addon')
    artifacts.push({
      target: 'darwin-arm64',
      kind: 'addon',
      path: relative,
      sha256: sha256(file)
    })
  }
  fs.writeFileSync(
    path.join(root, 'prebuilds/provenance.json'),
    JSON.stringify({
      schemaVersion: 1,
      sourceSha: SOURCE_SHA,
      addonAbiVersion: 2,
      capabilities: ['reachableAddresses'],
      artifacts
    })
  )
  return root
}

test('package provenance accepts exact-source sidecars and current addons', (t) => {
  const result = verifyPackagePrebuilds(fixture(t), SOURCE_SHA)
  t.is(result.sourceSha, SOURCE_SHA)
  t.is(result.artifacts.length, 6)
})

test('package provenance rejects stale source, hash, missing, extra, and duplicate artifacts', (t) => {
  t.exception(() => verifyPackagePrebuilds(fixture(t), 'b'.repeat(40)), /source SHA/)

  const mismatched = fixture(t)
  fs.appendFileSync(path.join(mismatched, 'prebuilds/linux-x64/arti-socks'), 'changed')
  t.exception(() => verifyPackagePrebuilds(mismatched, SOURCE_SHA), /checksum/)

  const missing = fixture(t)
  fs.rmSync(path.join(missing, 'prebuilds/linux-arm64/arti-socks'))
  t.exception(() => verifyPackagePrebuilds(missing, SOURCE_SHA), /layout/)

  const extra = fixture(t)
  fs.writeFileSync(path.join(extra, 'prebuilds/stale.bare'), 'stale')
  t.exception(() => verifyPackagePrebuilds(extra, SOURCE_SHA), /layout/)

  const duplicate = fixture(t)
  const provenance = JSON.parse(fs.readFileSync(path.join(duplicate, 'prebuilds/provenance.json')))
  provenance.artifacts.push(provenance.artifacts[0])
  fs.writeFileSync(path.join(duplicate, 'prebuilds/provenance.json'), JSON.stringify(provenance))
  t.exception(() => verifyPackagePrebuilds(duplicate, SOURCE_SHA), /duplicate/)
})

test('package provenance requires every production sidecar and current addon metadata', (t) => {
  const noAddon = fixture(t, { addon: false })
  t.is(verifyPackagePrebuilds(noAddon, SOURCE_SHA).artifacts.length, 5)

  const missingSidecar = fixture(t)
  const provenanceFile = path.join(missingSidecar, 'prebuilds/provenance.json')
  const provenance = JSON.parse(fs.readFileSync(provenanceFile))
  provenance.artifacts = provenance.artifacts.filter((entry) => entry.target !== 'win32-x64')
  fs.rmSync(path.join(missingSidecar, 'prebuilds/win32-x64/arti-socks.exe'))
  fs.writeFileSync(provenanceFile, JSON.stringify(provenance))
  t.exception(() => verifyPackagePrebuilds(missingSidecar, SOURCE_SHA), /required sidecar/)

  const oldAddon = fixture(t)
  const oldFile = path.join(oldAddon, 'prebuilds/provenance.json')
  const old = JSON.parse(fs.readFileSync(oldFile))
  old.addonAbiVersion = 1
  fs.writeFileSync(oldFile, JSON.stringify(old))
  t.exception(() => verifyPackagePrebuilds(oldAddon, SOURCE_SHA), /addon ABI/)
})
