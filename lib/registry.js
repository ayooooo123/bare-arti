const { artiError } = require('./errors')

const OWNERSHIP = Symbol.for('bare-arti.ownership')

function conflict(cause) {
  return artiError(
    'ERR_ARTI_CONFIG_CONFLICT',
    'Another bare-arti installation owns this JavaScript realm',
    cause
  )
}

function validOwnership(ownership) {
  try {
    const keys = Reflect.ownKeys(ownership)
    const descriptors = Object.getOwnPropertyDescriptors(ownership)
    return (
      ownership &&
      typeof ownership === 'object' &&
      Object.isFrozen(ownership) &&
      keys.length === 3 &&
      keys[0] === 'acquire' &&
      keys[1] === 'start' &&
      keys[2] === 'stop' &&
      Object.prototype.hasOwnProperty.call(descriptors.acquire, 'value') &&
      Object.prototype.hasOwnProperty.call(descriptors.start, 'value') &&
      Object.prototype.hasOwnProperty.call(descriptors.stop, 'value') &&
      typeof descriptors.acquire.value === 'function' &&
      typeof descriptors.start.value === 'function' &&
      typeof descriptors.stop.value === 'function'
    )
  } catch {
    return false
  }
}

function readRecord(global) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(global, OWNERSHIP)
  } catch (error) {
    throw conflict(error)
  }
  if (!descriptor) return { found: false, value: undefined }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw conflict()
  return { found: true, descriptor, value: descriptor.value }
}

function validRecord(record, version) {
  try {
    const keys = Reflect.ownKeys(record)
    const descriptors = Object.getOwnPropertyDescriptors(record)
    return (
      record !== null &&
      typeof record === 'object' &&
      Object.isFrozen(record) &&
      keys.length === 2 &&
      keys[0] === 'version' &&
      keys[1] === 'ownership' &&
      Object.prototype.hasOwnProperty.call(descriptors.version, 'value') &&
      Object.prototype.hasOwnProperty.call(descriptors.ownership, 'value') &&
      descriptors.version.value === version &&
      validOwnership(descriptors.ownership.value)
    )
  } catch {
    return false
  }
}

function getRegisteredOwnership({ global, version, create }) {
  const existing = readRecord(global)
  if (existing.found) {
    if (
      existing.descriptor.configurable !== false ||
      existing.descriptor.enumerable !== false ||
      existing.descriptor.writable !== false ||
      !validRecord(existing.value, version)
    ) {
      throw conflict()
    }
    let ownership
    try {
      ownership = existing.value.ownership
    } catch (error) {
      throw conflict(error)
    }
    if (!validOwnership(ownership)) throw conflict()
    return ownership
  }

  let ownership
  try {
    ownership = create()
    Object.freeze(ownership)
  } catch (error) {
    throw conflict(error)
  }
  if (!validOwnership(ownership)) throw conflict()

  const record = Object.freeze({ version, ownership })
  try {
    Object.defineProperty(global, OWNERSHIP, {
      value: record,
      configurable: false,
      enumerable: false,
      writable: false
    })
  } catch (error) {
    throw conflict(error)
  }
  const installed = readRecord(global)
  if (
    !installed.found ||
    installed.value !== record ||
    installed.descriptor.configurable !== false ||
    installed.descriptor.enumerable !== false ||
    installed.descriptor.writable !== false ||
    !validRecord(installed.value, version)
  ) {
    throw conflict()
  }
  return ownership
}

module.exports = { getRegisteredOwnership }
