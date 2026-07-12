#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const { verifyPackagePrebuilds } = require('./verify-package-prebuilds')

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
  'scripts/verify-package-prebuilds.js',
  'prebuilds'
]

function assemblePackage(sourceRoot, destinationRoot, sourceSha) {
  const source = path.resolve(sourceRoot)
  const destination = path.resolve(destinationRoot)
  verifyPackagePrebuilds(source, sourceSha)
  if (fs.existsSync(destination)) {
    throw new Error(`package assembly destination already exists: ${destination}`)
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
    const packageFile = path.join(destination, 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
    delete packageJson.private
    packageJson.files.push('prebuilds/**')
    fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`)
    verifyPackagePrebuilds(destination, sourceSha)
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true })
    throw error
  }
  return destination
}

if (require.main === module) {
  try {
    const [, , destination, sourceSha = process.env.BARE_ARTI_SOURCE_SHA] = process.argv
    if (!destination || !sourceSha) {
      throw new Error('usage: assemble-package <destination> <full-source-sha>')
    }
    console.log(assemblePackage(path.resolve(__dirname, '..'), destination, sourceSha))
  } catch (error) {
    console.error(`bare-arti package assembly failed: ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { assemblePackage }
