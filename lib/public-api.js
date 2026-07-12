const { createBackend } = require('./backend')
const { createOptionResolver } = require('./options')
const { createOwnership } = require('./ownership')
const { getRegisteredOwnership } = require('./registry')

function createPublicApi({ global, platform, arch, path, environment, loadAddon, startSidecar }) {
  const ownership = getRegisteredOwnership({
    global,
    version: 1,
    create() {
      const options = createOptionResolver({ platform, path, environment })
      const backend = createBackend({ platform, arch, loadAddon, startSidecar })
      return createOwnership({
        startBackend: backend.start,
        stopBackend: backend.stop,
        beginOptionsGeneration: options.beginGeneration
      })
    }
  })

  return Object.freeze({
    acquire: ownership.acquire,
    start: ownership.start,
    stop: ownership.stop
  })
}

module.exports = { createPublicApi }
