class ArtiError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ArtiError'
    this.code = code
  }
}

function artiError(code, message, cause) {
  return new ArtiError(code, message, cause)
}

module.exports = { ArtiError, artiError }
