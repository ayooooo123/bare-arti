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
    return (
      ownership &&
      (typeof ownership === 'object' || typeof ownership === 'function') &&
      typeof ownership.acquire === 'function' &&
      typeof ownership.start === 'function' &&
      typeof ownership.stop === 'function'
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
    return existing.value.ownership
  }

  let ownership
  try {
    ownership = create()
  } catch (error) {
    throw error
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
  return ownership
}

module.exports = { getRegisteredOwnership }
