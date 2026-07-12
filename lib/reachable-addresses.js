const { artiError } = require('./errors')

function invalid() {
  return artiError(
    'ERR_ARTI_CONFIG',
    'reachableAddresses must be a non-empty array of wildcard address and port patterns'
  )
}

function normalizeReachableAddresses(value) {
  if (value === undefined) return undefined
  let isArray
  let length
  try {
    isArray = Array.isArray(value)
    length = value.length
  } catch (error) {
    throw artiError('ERR_ARTI_CONFIG', 'Could not read reachableAddresses', error)
  }
  if (!isArray || length === 0 || length > 64) throw invalid()

  const snapshot = new Array(length)
  for (let i = 0; i < length; i++) {
    let pattern
    try {
      pattern = value[i]
    } catch (error) {
      throw artiError('ERR_ARTI_CONFIG', 'Could not read reachableAddresses', error)
    }
    if (typeof pattern !== 'string') throw invalid()

    const match = /^\*:([1-9][0-9]{0,4})$/.exec(pattern)
    if (!match || Number(match[1]) > 65535) throw invalid()
    snapshot[i] = pattern
  }

  return Object.freeze(
    [...new Set(snapshot)].sort((left, right) => {
      const leftPort = Number(left.slice(2))
      const rightPort = Number(right.slice(2))
      return leftPort - rightPort
    })
  )
}

function matchingReachableAddresses(left, right) {
  if (left === right) return true
  if (left === undefined || right === undefined || left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

module.exports = { normalizeReachableAddresses, matchingReachableAddresses }
