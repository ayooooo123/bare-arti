const { isBare, platform, arch } = require('which-runtime')
const fs = isBare ? require('bare-fs') : require('fs')
const path = isBare ? require('bare-path') : require('path')
const { spawn } = isBare ? require('bare-subprocess') : require('child_process')
const environment = isBare ? require('bare-env') : process.env
const getuid = isBare
  ? null
  : typeof process.getuid === 'function'
    ? process.getuid.bind(process)
    : null

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
        platform,
        fs,
        path,
        getuid
      }),
    setTimer: setTimeout,
    clearTimer: clearTimeout
  })
  return addonController
}

const startSidecar = createSidecar({
  platform,
  arch,
  dirname: __dirname,
  fs,
  path,
  spawn,
  environment,
  setTimer: setTimeout,
  clearTimer: clearTimeout
})

module.exports = createPublicApi({
  global: globalThis,
  platform,
  arch,
  path,
  environment,
  loadAddon,
  startSidecar
})
