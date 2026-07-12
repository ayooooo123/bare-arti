const test = require('brittle')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const { verifyPackagePrebuilds } = require('../scripts/verify-package-prebuilds')
const { assemblePackage } = require('../scripts/assemble-package')

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

function assemblySource(t) {
  const source = fixture(t)
  const repository = path.join(__dirname, '..')
  for (const relative of [
    'index.js',
    'binding.c',
    'binding.js',
    'Cargo.toml',
    'Cargo.lock',
    'CMakeLists.txt',
    'LICENSE',
    'README.md',
    'package.json',
    'package-lock.json',
    'addon/Cargo.toml',
    'addon/Cargo.lock',
    'addon/src',
    'src',
    'lib',
    'scripts/assemble-package.js',
    'scripts/verify-package-prebuilds.js'
  ]) {
    fs.cpSync(path.join(repository, relative), path.join(source, relative), { recursive: true })
  }
  fs.writeFileSync(path.join(source, '.gitignore'), 'prebuilds/\n')
  execFileSync('git', ['init', '-q'], { cwd: source })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: source })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: source })
  execFileSync('git', ['add', '.'], { cwd: source })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: source })
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8'
  }).trim()
  const provenanceFile = path.join(source, 'prebuilds/provenance.json')
  const provenance = JSON.parse(fs.readFileSync(provenanceFile))
  provenance.sourceSha = sourceSha
  fs.writeFileSync(provenanceFile, JSON.stringify(provenance))
  return { source, sourceSha }
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

for (const [name, target, addonPath] of [
  ['wrong basename', 'darwin-arm64', 'prebuilds/darwin-arm64/not-bare-arti.bare'],
  ['nested path', 'darwin-arm64', 'prebuilds/darwin-arm64/nested/bare-arti.bare'],
  ['unsupported target', 'solaris-sparc', 'prebuilds/solaris-sparc/bare-arti.bare'],
  ['target mismatch', 'linux-x64', 'prebuilds/darwin-arm64/bare-arti.bare']
]) {
  test(`package provenance rejects addon ${name}`, (t) => {
    const root = fixture(t)
    const provenanceFile = path.join(root, 'prebuilds/provenance.json')
    const provenance = JSON.parse(fs.readFileSync(provenanceFile))
    const addon = provenance.artifacts.find((entry) => entry.kind === 'addon')
    const oldFile = path.join(root, addon.path)
    const newFile = path.join(root, addonPath)
    if (oldFile !== newFile) {
      fs.mkdirSync(path.dirname(newFile), { recursive: true })
      fs.renameSync(oldFile, newFile)
    }
    addon.target = target
    addon.path = addonPath
    addon.sha256 = sha256(newFile)
    fs.writeFileSync(provenanceFile, JSON.stringify(provenance))

    t.exception(() => verifyPackagePrebuilds(root, SOURCE_SHA), /addon artifact/)
  })
}

test('verified assembly is the only package metadata that includes prebuilds', (t) => {
  const { source, sourceSha } = assemblySource(t)
  const destination = path.join(os.tmpdir(), `bare-arti-assembled-${process.pid}-${Date.now()}`)
  t.teardown(() => fs.rmSync(destination, { recursive: true, force: true }))

  assemblePackage(source, destination, sourceSha)
  const sourcePackage = require('../package.json')
  const assembledPackage = JSON.parse(fs.readFileSync(path.join(destination, 'package.json')))
  t.is(sourcePackage.private, true)
  t.absent(sourcePackage.files.find((entry) => entry.startsWith('prebuilds')))
  t.absent(assembledPackage.private)
  t.ok(assembledPackage.files.includes('prebuilds/**'))
  t.ok(fs.existsSync(path.join(destination, 'prebuilds/provenance.json')))
})

test('assembly rejects non-Git, mismatched SHA, and dirty package source', (t) => {
  const nonGit = fixture(t)
  t.exception(() => assemblePackage(nonGit, path.join(nonGit, 'stage'), SOURCE_SHA), /Git checkout/)

  const mismatch = assemblySource(t)
  t.exception(
    () => assemblePackage(mismatch.source, path.join(mismatch.source, 'stage'), 'b'.repeat(40)),
    /does not match/
  )

  const dirty = assemblySource(t)
  fs.appendFileSync(path.join(dirty.source, 'lib/options.js'), '\n// dirty\n')
  t.exception(
    () => assemblePackage(dirty.source, path.join(dirty.source, 'stage'), dirty.sourceSha),
    /source is dirty/
  )

  const untracked = assemblySource(t)
  fs.writeFileSync(path.join(untracked.source, 'lib/untracked.js'), 'untracked\n')
  t.exception(
    () =>
      assemblePackage(untracked.source, path.join(untracked.source, 'stage'), untracked.sourceSha),
    /source is dirty/
  )
})

test('clean committed checkout assembles through the exact CI CLI invocation', (t) => {
  const { source, sourceSha } = assemblySource(t)
  const destination = path.join(os.tmpdir(), `bare-arti-cli-stage-${process.pid}-${Date.now()}`)
  t.teardown(() => fs.rmSync(destination, { recursive: true, force: true }))

  const output = execFileSync(process.execPath, ['scripts/assemble-package.js', destination], {
    cwd: source,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_SHA: sourceSha, BARE_ARTI_SOURCE_SHA: sourceSha }
  })
  t.is(output.trim(), destination)
  t.ok(fs.existsSync(path.join(destination, 'prebuilds/provenance.json')))
  t.absent(JSON.parse(fs.readFileSync(path.join(destination, 'package.json'))).private)
})
