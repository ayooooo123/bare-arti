#!/usr/bin/env node

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { repositorySourceSha } = require('./assemble-package')
const { ABI_VERSION, CAPABILITIES, SUPPORTED_ADDON_TARGETS } = require('./verify-package-prebuilds')

const COPY = [
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
  'scripts/verify-package-prebuilds.js'
]

function slash(relative) {
  return relative.split(path.sep).join('/')
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function regularFiles(root, directory) {
  const base = path.join(root, directory)
  if (!fs.existsSync(base)) return []
  const files = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push(slash(path.relative(root, absolute)))
      else throw new Error(`proof layout contains a non-file entry: ${absolute}`)
    }
  }
  visit(base)
  return files.sort()
}

function exactKeys(value, expected) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function verifyProofInput(root, sourceSha, target) {
  if (!SUPPORTED_ADDON_TARGETS.has(target)) throw new Error(`unsupported proof target: ${target}`)
  const relative = `prebuilds/${target}/bare-arti.bare`
  const files = regularFiles(root, 'prebuilds')
  if (files.length !== 1 || files[0] !== relative) {
    throw new Error(`proof input must contain exactly one addon at ${relative}`)
  }

  const metadataFiles = regularFiles(root, 'artifact-metadata')
  const metadataPath = `artifact-metadata/${target}.json`
  if (metadataFiles.length !== 1 || metadataFiles[0] !== metadataPath) {
    throw new Error(`proof input must contain exactly one metadata record at ${metadataPath}`)
  }
  let metadata
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(root, metadataPath), 'utf8'))
  } catch (error) {
    throw new Error(`invalid proof metadata: ${error.message}`)
  }
  if (
    !exactKeys(metadata, [
      'schemaVersion',
      'sourceSha',
      'target',
      'kind',
      'path',
      'sha256',
      'addonAbiVersion',
      'capabilities'
    ]) ||
    metadata.schemaVersion !== 1 ||
    metadata.sourceSha !== sourceSha ||
    metadata.target !== target ||
    metadata.kind !== 'addon' ||
    metadata.path !== relative ||
    metadata.addonAbiVersion !== ABI_VERSION ||
    !Array.isArray(metadata.capabilities) ||
    metadata.capabilities.length !== CAPABILITIES.length ||
    metadata.capabilities.some((value, index) => value !== CAPABILITIES[index]) ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  ) {
    if (metadata && metadata.sourceSha !== sourceSha) {
      throw new Error('proof metadata source SHA does not match package source')
    }
    throw new Error('invalid proof metadata ABI, capabilities, target, or layout')
  }
  if (sha256(path.join(root, relative)) !== metadata.sha256) {
    throw new Error('proof addon checksum mismatch')
  }
  return metadata
}

function verifyProofStage(root, sourceSha, target) {
  const relative = `prebuilds/${target}/bare-arti.bare`
  const files = regularFiles(root, 'prebuilds')
  if (files.length !== 2 || files[0] !== relative || files[1] !== 'prebuilds/provenance.json') {
    throw new Error('proof stage contains missing or extra prebuilds')
  }
  const provenance = JSON.parse(
    fs.readFileSync(path.join(root, 'prebuilds/provenance.json'), 'utf8')
  )
  if (
    !exactKeys(provenance, [
      'schemaVersion',
      'sourceSha',
      'addonAbiVersion',
      'capabilities',
      'artifacts',
      'proofOnly'
    ]) ||
    provenance.schemaVersion !== 1 ||
    provenance.sourceSha !== sourceSha ||
    provenance.addonAbiVersion !== ABI_VERSION ||
    provenance.proofOnly !== true ||
    JSON.stringify(provenance.capabilities) !== JSON.stringify(CAPABILITIES) ||
    !Array.isArray(provenance.artifacts) ||
    provenance.artifacts.length !== 1
  ) {
    throw new Error('invalid private proof provenance')
  }
  const artifact = provenance.artifacts[0]
  if (
    !exactKeys(artifact, ['target', 'kind', 'path', 'sha256']) ||
    artifact.target !== target ||
    artifact.kind !== 'addon' ||
    artifact.path !== relative ||
    artifact.sha256 !== sha256(path.join(root, relative))
  ) {
    throw new Error('private proof destination checksum or layout mismatch')
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (packageJson.private !== true || !packageJson.files.includes('prebuilds/**')) {
    throw new Error('private proof package must remain non-publishable and include prebuilds')
  }
  return provenance
}

function assembleProofPackage(sourceRoot, destinationRoot, expectedSourceSha, target) {
  const source = path.resolve(sourceRoot)
  const destination = path.resolve(destinationRoot)
  const sourceSha = repositorySourceSha(source, expectedSourceSha)
  const metadata = verifyProofInput(source, sourceSha, target)
  if (fs.existsSync(destination)) {
    throw new Error(`proof assembly destination already exists: ${destination}`)
  }
  fs.mkdirSync(destination, { recursive: true })
  try {
    for (const relative of COPY) {
      fs.cpSync(path.join(source, relative), path.join(destination, relative), {
        recursive: true,
        errorOnExist: true,
        force: false
      })
    }
    const addonDestination = path.join(destination, metadata.path)
    fs.mkdirSync(path.dirname(addonDestination), { recursive: true })
    fs.copyFileSync(path.join(source, metadata.path), addonDestination, fs.constants.COPYFILE_EXCL)
    const packageFile = path.join(destination, 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
    if (packageJson.private !== true) throw new Error('source package must be private')
    if (!packageJson.files.includes('prebuilds/**')) packageJson.files.push('prebuilds/**')
    fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`)
    const provenance = {
      schemaVersion: 1,
      sourceSha,
      addonAbiVersion: ABI_VERSION,
      capabilities: CAPABILITIES,
      artifacts: [
        {
          target,
          kind: 'addon',
          path: metadata.path,
          sha256: sha256(addonDestination)
        }
      ],
      proofOnly: true
    }
    fs.writeFileSync(
      path.join(destination, 'prebuilds/provenance.json'),
      `${JSON.stringify(provenance)}\n`
    )
    verifyProofStage(destination, sourceSha, target)
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true })
    throw error
  }
  return destination
}

if (require.main === module) {
  try {
    const [, , destination, target, unexpected] = process.argv
    if (!destination || !target || unexpected) {
      throw new Error(
        'usage: assemble-proof-package <empty-destination> <platform-arch> with GITHUB_SHA'
      )
    }
    if (
      process.env.GITHUB_SHA &&
      process.env.BARE_ARTI_SOURCE_SHA &&
      process.env.GITHUB_SHA !== process.env.BARE_ARTI_SOURCE_SHA
    ) {
      throw new Error('GITHUB_SHA and BARE_ARTI_SOURCE_SHA disagree')
    }
    const sourceSha = process.env.GITHUB_SHA || process.env.BARE_ARTI_SOURCE_SHA
    if (!sourceSha) throw new Error('a CI source SHA is required')
    console.log(assembleProofPackage(path.resolve(__dirname, '..'), destination, sourceSha, target))
  } catch (error) {
    console.error(`bare-arti private proof assembly failed: ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { assembleProofPackage, verifyProofInput, verifyProofStage }
