const { artiError } = require('./errors')

const DEFAULT_BOOTSTRAP_TIMEOUT = 600000
const MIN_BOOTSTRAP_TIMEOUT = 1000
const MAX_BOOTSTRAP_TIMEOUT = 1800000

function configError(message, cause) {
  return artiError('ERR_ARTI_CONFIG', message, cause)
}

function validateAddonOptions(options, dependencies) {
  if (!options || typeof options !== 'object') {
    throw configError('Addon options are required')
  }

  const { platform, fs, path, getuid } = dependencies
  const bootstrapTimeout =
    options.bootstrapTimeout === undefined ? DEFAULT_BOOTSTRAP_TIMEOUT : options.bootstrapTimeout

  if (
    !Number.isInteger(bootstrapTimeout) ||
    bootstrapTimeout < MIN_BOOTSTRAP_TIMEOUT ||
    bootstrapTimeout > MAX_BOOTSTRAP_TIMEOUT
  ) {
    throw configError(
      `bootstrapTimeout must be an integer between ${MIN_BOOTSTRAP_TIMEOUT} and ${MAX_BOOTSTRAP_TIMEOUT} milliseconds`
    )
  }

  if (typeof options.dataDir !== 'string' || !path.isAbsolute(options.dataDir)) {
    throw configError('dataDir must be an absolute path')
  }

  let dataDir

  try {
    fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })

    const linkStat = fs.lstatSync(options.dataDir)
    if ((platform === 'android' || platform === 'ios') && linkStat.isSymbolicLink()) {
      throw configError('dataDir must not be a symbolic link on mobile')
    }

    dataDir = fs.realpathSync(options.dataDir)
    const stat = fs.statSync(dataDir)

    if (!stat.isDirectory()) {
      throw configError('dataDir must be a directory')
    }

    if ((stat.mode & 0o077) !== 0) {
      throw configError('dataDir must not be accessible by group or other users')
    }

    if (typeof getuid === 'function' && Number.isInteger(stat.uid) && stat.uid !== getuid()) {
      throw configError('dataDir must be owned by the current user')
    }
  } catch (error) {
    if (error && error.code === 'ERR_ARTI_CONFIG') throw error
    throw configError('Could not securely prepare dataDir', error)
  }

  return Object.freeze({
    ...options,
    backend: 'addon',
    dataDir,
    bootstrapTimeout
  })
}

module.exports = {
  validateAddonOptions
}
