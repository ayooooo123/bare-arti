#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

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

function repositorySourceSha(root, expectedSourceSha) {
  if (!/^[a-f0-9]{40}$/.test(expectedSourceSha || '')) {
    throw new Error('a full lowercase CI source SHA is required')
  }
  let head
  let status
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: root,
      encoding: 'utf8'
    })
  } catch (error) {
    throw new Error(`package source must be a Git checkout: ${error.message}`)
  }
  if (head !== expectedSourceSha) throw new Error('CI source SHA does not match Git HEAD')

  const relevant =
    /^(?:index\.js|binding\.[cj]s|Cargo\.(?:toml|lock)|CMakeLists\.txt|package(?:-lock)?\.json|README\.md|LICENSE|addon\/|src\/|lib\/|scripts\/)/
  for (const line of status.split('\n')) {
    if (line === '') continue
    const file = line.slice(3).replace(/^"|"$/g, '')
    if (line.slice(0, 2) !== '??' || relevant.test(file)) {
      throw new Error(`package source is dirty: ${file}`)
    }
  }
  return head
}

function assemblePackage(sourceRoot, destinationRoot, expectedSourceSha) {
  const source = path.resolve(sourceRoot)
  const destination = path.resolve(destinationRoot)
  const sourceSha = repositorySourceSha(source, expectedSourceSha)
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
    const [, , destination, unexpectedArgument] = process.argv
    if (unexpectedArgument) throw new Error('source SHA must come from the CI environment')
    const environmentSha = process.env.GITHUB_SHA || process.env.BARE_ARTI_SOURCE_SHA
    if (
      process.env.GITHUB_SHA &&
      process.env.BARE_ARTI_SOURCE_SHA &&
      process.env.GITHUB_SHA !== process.env.BARE_ARTI_SOURCE_SHA
    ) {
      throw new Error('GITHUB_SHA and BARE_ARTI_SOURCE_SHA disagree')
    }
    const sourceSha = positionalSha || environmentSha
    if (!destination || !sourceSha) {
      throw new Error(
        'usage: assemble-package <destination> with GITHUB_SHA or BARE_ARTI_SOURCE_SHA'
      )
    }
    console.log(assemblePackage(path.resolve(__dirname, '..'), destination, sourceSha))
  } catch (error) {
    console.error(`bare-arti package assembly failed: ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { assemblePackage, repositorySourceSha }
