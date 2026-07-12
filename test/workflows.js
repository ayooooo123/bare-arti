const test = require('brittle')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', '.github', 'workflows')
const mobile = fs.readFileSync(path.join(root, 'mobile.yml'), 'utf8')
const prebuild = fs.readFileSync(path.join(root, 'prebuild.yml'), 'utf8')

test('release workflow requires exact mobile inputs and verified package staging', (t) => {
  for (const value of [
    'uses: ./.github/workflows/mobile.yml',
    'name: mobile-release-input',
    'expected eight artifact metadata records',
    'node scripts/verify-package-prebuilds.js',
    'node scripts/assemble-package.js publication-stage',
    'BARE_ARTI_SOURCE_SHA="$GITHUB_SHA" npm pack',
    'sort -o expected-prebuilds.txt expected-prebuilds.txt',
    'sort -o expected-package-prebuilds.txt expected-package-prebuilds.txt',
    'prebuilds/android-arm64/bare-arti.bare',
    'prebuilds/ios-arm64/bare-arti.bare',
    'prebuilds/ios-arm64-simulator/bare-arti.bare'
  ]) {
    t.ok(prebuild.includes(value), value)
  }
})

test('mobile workflow is reusable and emits exact ABI metadata without packing', (t) => {
  t.ok(mobile.includes('workflow_call:'))
  t.ok(mobile.includes('addonAbiVersion:2'))
  t.ok(mobile.includes("capabilities:['reachableAddresses']"))
  t.ok(mobile.includes('name: mobile-release-input'))
  t.absent(mobile.match(/npm pack/))
})

test('sidecar jobs install Node before generating artifact metadata', (t) => {
  const sidecar = prebuild.slice(prebuild.indexOf('\n  sidecar:'), prebuild.indexOf('\n  mobile:'))
  const setup = sidecar.indexOf('uses: actions/setup-node@')
  const metadata = sidecar.indexOf("node -e \"const c=require('crypto')")
  t.ok(setup !== -1)
  t.ok(metadata !== -1)
  t.ok(setup < metadata)
})

test('workflow actions are immutable and permissions are read-only', (t) => {
  for (const workflow of [mobile, prebuild]) {
    t.ok(workflow.includes('permissions:\n  contents: read'))
    for (const match of workflow.matchAll(/^\s*uses:\s*(\S+)/gm)) {
      if (match[1].startsWith('./')) continue
      t.ok(/@[a-f0-9]{40}$/.test(match[1]), `pinned action ${match[1]}`)
    }
    const checkouts = [...workflow.matchAll(/uses: actions\/checkout@/g)].length
    const hardened = [
      ...workflow.matchAll(
        /uses: actions\/checkout@[^\n]+\n\s+with:\n\s+persist-credentials: false/g
      )
    ].length
    t.is(hardened, checkouts, 'every checkout disables persisted credentials')
  }
  const release = prebuild.slice(prebuild.indexOf('\n  release:'))
  t.absent(release.match(/actions\/checkout/), 'release job stays checkout-free')
})
