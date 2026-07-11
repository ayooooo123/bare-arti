const { isBare } = require('which-runtime')
const fs = isBare ? require('bare-fs') : require('fs')
const path = isBare ? require('bare-path') : require('path')
const { spawn } = isBare ? require('bare-subprocess') : require('child_process')

const { createAddonController, validateAddonOptions } = require('./lib/addon-controller')
const { createBackend } = require('./lib/backend')
const { createSidecar } = require('./lib/sidecar')

let addonController = null

function loadAddon() {
  if (addonController) return addonController
  const binding = require('./binding')
  addonController = createAddonController({
    binding,
    validateOptions: (options) =>
      validateAddonOptions(options, {
        platform: process.platform,
        fs,
        path,
        getuid: typeof process.getuid === 'function' ? process.getuid.bind(process) : null
      }),
    setTimer: setTimeout,
    clearTimer: clearTimeout
  })
  return addonController
}

const startSidecar = createSidecar({
  platform: process.platform,
  arch: process.arch,
  dirname: __dirname,
  fs,
  path,
  spawn,
  environment: process.env,
  setTimer: setTimeout,
  clearTimer: clearTimeout
})

const backend = createBackend({
  platform: process.platform,
  arch: process.arch,
  loadAddon,
  startSidecar
})

module.exports = {
  start: backend.start,
  stop: backend.stop
}
