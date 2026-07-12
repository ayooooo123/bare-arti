const Worker = require('bare-worker')

let binding
try {
  binding = require('../binding')
} catch (error) {
  Worker.parentPort.postMessage({ code: error.code, message: error.message })
}

async function main() {
  if (!binding) return
  const { mode, generation } = Worker.workerData
  if (mode === 'running') {
    const result = await binding.start(
      {
        dataDir: `/tmp/bare-arti-worker-${generation}`,
        reachableAddressesString: '*:80,*:443',
        timeout: 30000
      },
      generation
    )
    Worker.parentPort.postMessage({ status: 'running', port: result.port })
  } else if (mode === 'starting' || mode === 'late') {
    binding
      .start(
        {
          dataDir: `/tmp/bare-arti-${mode === 'late' ? 'slow-ready' : 'delay-start'}-${generation}`,
          reachableAddressesString: '*:80,*:443',
          timeout: 30000
        },
        generation
      )
      .catch(() => {})
    Worker.parentPort.postMessage({ status: 'starting' })
  } else {
    Worker.parentPort.postMessage({ status: 'loaded' })
  }
}

Worker.parentPort.on('message', (message) => {
  if (message === 'close') Worker.parentPort.close()
})

main().catch((error) => {
  Worker.parentPort.postMessage({ code: error.code, message: error.message })
})
