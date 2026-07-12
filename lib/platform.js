function isMobilePlatform(platform) {
  return platform === 'android' || platform === 'ios' || platform === 'ios-simulator'
}

module.exports = { isMobilePlatform }
