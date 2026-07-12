#!/usr/bin/env node

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ABI_VERSION = 2
const CAPABILITIES = ['reachableAddresses']
const REQUIRED_SIDECARS = new Map([
  ['linux-x64', 'prebuilds/linux-x64/arti-socks'],
  ['linux-arm64', 'prebuilds/linux-arm64/arti-socks'],
  ['darwin-x64', 'prebuilds/darwin-x64/arti-socks'],
  ['darwin-arm64', 'prebuilds/darwin-arm64/arti-socks'],
  ['win32-x64', 'prebuilds/win32-x64/arti-socks.exe']
])

function slash(relative) {
  return relative.split(path.sep).join('/')
}

function filesBelow(root, directory) {
  const base = path.join(root, directory)
  if (!fs.existsSync(base)) return []
  const files = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push(slash(path.relative(root, absolute)))
      else throw new Error(`prebuild layout contains a non-file entry: ${absolute}`)
    }
  }
  visit(base)
  return files.sort()
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function exactKeys(value, expected) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function verifyPackagePrebuilds(packageRoot, expectedSourceSha) {
  const root = path.resolve(packageRoot)
  if (!/^[a-f0-9]{40}$/.test(expectedSourceSha)) {
    throw new Error('expected source SHA must be a full lowercase Git commit')
  }

  const provenanceFile = path.join(root, 'prebuilds/provenance.json')
  let provenance
  try {
    provenance = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'))
  } catch (error) {
    throw new Error(`missing or invalid prebuild provenance: ${error.message}`)
  }
  if (
    !exactKeys(provenance, [
      'schemaVersion',
      'sourceSha',
      'addonAbiVersion',
      'capabilities',
      'artifacts'
    ]) ||
    provenance.schemaVersion !== 1 ||
    provenance.sourceSha !== expectedSourceSha ||
    provenance.addonAbiVersion !== ABI_VERSION ||
    !Array.isArray(provenance.capabilities) ||
    provenance.capabilities.length !== CAPABILITIES.length ||
    provenance.capabilities.some((value, index) => value !== CAPABILITIES[index]) ||
    !Array.isArray(provenance.artifacts)
  ) {
    if (provenance && provenance.sourceSha !== expectedSourceSha) {
      throw new Error('prebuild provenance source SHA does not match package source')
    }
    if (provenance && provenance.addonAbiVersion !== ABI_VERSION) {
      throw new Error(`prebuild provenance addon ABI must be ${ABI_VERSION}`)
    }
    throw new Error('invalid prebuild provenance schema or capabilities')
  }

  const paths = new Set()
  const identities = new Set()
  const sidecars = new Map()
  for (const artifact of provenance.artifacts) {
    if (
      !exactKeys(artifact, ['target', 'kind', 'path', 'sha256']) ||
      typeof artifact.target !== 'string' ||
      (artifact.kind !== 'sidecar' && artifact.kind !== 'addon') ||
      typeof artifact.path !== 'string' ||
      !/^prebuilds\/[a-z0-9-]+\/[a-z0-9.-]+$/.test(artifact.path) ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      artifact.path.split('/')[1] !== artifact.target
    ) {
      throw new Error('invalid prebuild provenance artifact entry')
    }
    if (paths.has(artifact.path)) throw new Error(`duplicate artifact path: ${artifact.path}`)
    paths.add(artifact.path)
    const identity = `${artifact.kind}:${artifact.target}`
    if (identities.has(identity)) throw new Error(`duplicate artifact identity: ${identity}`)
    identities.add(identity)
    if (artifact.kind === 'sidecar') sidecars.set(artifact.target, artifact.path)

    const file = path.join(root, artifact.path)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`prebuild layout is missing ${artifact.path}`)
    }
    if (sha256(file) !== artifact.sha256) {
      throw new Error(`prebuild checksum mismatch for ${artifact.path}`)
    }
  }

  for (const [target, expectedPath] of REQUIRED_SIDECARS) {
    if (sidecars.get(target) !== expectedPath) {
      throw new Error(`required sidecar is missing for ${target}`)
    }
  }

  const actualFiles = filesBelow(root, 'prebuilds').filter(
    (relative) => relative !== 'prebuilds/provenance.json'
  )
  const declaredFiles = [...paths].sort()
  if (
    actualFiles.length !== declaredFiles.length ||
    actualFiles.some((relative, index) => relative !== declaredFiles[index])
  ) {
    throw new Error(
      `prebuild layout contains missing or extra files: actual=${JSON.stringify(actualFiles)} declared=${JSON.stringify(declaredFiles)}`
    )
  }

  return Object.freeze({ sourceSha: provenance.sourceSha, artifacts: provenance.artifacts })
}

function repositorySourceSha(root) {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8'
  })
  const sourcePath = /^(?:index\.js|binding\.[cj]s|Cargo\.(?:toml|lock)|CMakeLists\.txt|package(?:-lock)?\.json|README\.md|LICENSE|addon\/|src\/|lib\/)/
  for (const line of status.split('\n')) {
    if (line === '') continue
    const state = line.slice(0, 2)
    const file = line.slice(3).replace(/^"|"$/g, '')
    if (state !== '??' || sourcePath.test(file)) {
      throw new Error(`refusing to package dirty source: ${file}`)
    }
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..')
    const expected = process.env.BARE_ARTI_SOURCE_SHA || repositorySourceSha(root)
    const result = verifyPackagePrebuilds(root, expected)
    console.log(`verified ${result.artifacts.length} exact-source package prebuilds`)
  } catch (error) {
    console.error(`bare-arti package prebuild verification failed: ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { ABI_VERSION, CAPABILITIES, REQUIRED_SIDECARS, verifyPackagePrebuilds }
