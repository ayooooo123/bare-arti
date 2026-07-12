#!/usr/bin/env node

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const MAX_COMPRESSED_SIZE = 30 * 1024 * 1024
const TARGETS = ['android-arm64', 'ios-arm64', 'ios-arm64-simulator']
const MODULES = TARGETS.map((target) => `prebuilds/${target}/bare-arti.bare`)
const MANIFESTS = TARGETS.map((target) => `manifests/${target}.json`)

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
      else throw new Error(`artifact layout contains a non-file entry: ${absolute}`)
    }
  }
  visit(base)
  return files.sort()
}

function sameFiles(actual, expected) {
  if (actual.length !== expected.length) return false
  const sortedExpected = [...expected].sort()
  return actual.every((file, index) => file === sortedExpected[index])
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function gzipSize(file) {
  return zlib.gzipSync(fs.readFileSync(file), { level: 9, mtime: 0 }).byteLength
}

function readManifest(file, expectedModule) {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`invalid checksum manifest ${file}: ${error.message}`)
  }
  if (
    manifest === null ||
    Array.isArray(manifest) ||
    typeof manifest !== 'object' ||
    Object.keys(manifest).length !== 1 ||
    Object.keys(manifest)[0] !== expectedModule ||
    typeof manifest[expectedModule] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest[expectedModule])
  ) {
    throw new Error(`invalid checksum manifest entry for ${expectedModule}`)
  }
  return manifest[expectedModule]
}

function verifyMobilePrebuilds(artifactRoot) {
  const root = path.resolve(artifactRoot)
  const modules = filesBelow(root, 'prebuilds')
  const manifests = filesBelow(root, 'manifests')
  if (!sameFiles(modules, MODULES) || !sameFiles(manifests, MANIFESTS)) {
    throw new Error(
      `artifact layout mismatch: modules=${JSON.stringify(modules)} manifests=${JSON.stringify(manifests)}`
    )
  }

  for (let index = 0; index < MODULES.length; index++) {
    const relative = MODULES[index]
    const file = path.join(root, relative)
    const expected = readManifest(path.join(root, MANIFESTS[index]), relative)
    const actual = sha256(file)
    if (actual !== expected) throw new Error(`checksum mismatch for ${relative}`)
    const compressed = gzipSize(file)
    if (compressed > MAX_COMPRESSED_SIZE) {
      throw new Error(`compressed size exceeds 30 MiB for ${relative}: ${compressed} bytes`)
    }
  }

  return { modules: [...MODULES], manifests: [...MANIFESTS] }
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error('usage: verify-mobile-prebuild <artifact-root>')
    process.exitCode = 1
  } else {
    try {
      const result = verifyMobilePrebuilds(process.argv[2])
      console.log(`verified ${result.modules.length} mobile addon prebuilds`)
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}

module.exports = {
  MAX_COMPRESSED_SIZE,
  gzipSize,
  verifyMobilePrebuilds
}
