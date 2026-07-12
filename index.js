const { isBare } = require('which-runtime')
const fs = isBare ? require('bare-fs') : require('fs')
const path = isBare ? require('bare-path') : require('path')
const { spawn } = isBare ? require('bare-subprocess') : require('child_process')

const { createAddonController, validateAddonOptions } = require('./lib/addon-controller')
const { createPublicApi } = require('./lib/public-api')
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

module.exports = createPublicApi({
  global: globalThis,
  platform: process.platform,
  arch: process.arch,
  path,
  environment: process.env,
  loadAddon,
  startSidecar
})
