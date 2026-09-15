import { pathToFileURL } from 'node:url'

// The URL travels over parent/child IPC, never through a persisted config file.
process.once('message', async config => {
  try {
    const { resumableDownloadTo } = await import(pathToFileURL(config.modulePath).href)
    const result = await resumableDownloadTo({
      resumeRoot: config.resumeRoot,
      resumeKey: config.resumeKey,
      targetPath: config.targetPath,
      chunkSize: config.chunkSize,
      connections: config.connections || 1,
      getSource: async () => ({ url: config.url, totalSize: config.totalSize, identity: config.identity }),
      fetch: (url, init) => {
        if (!url.startsWith('http://127.0.0.1:')) throw new Error('Fixture only permits loopback HTTP')
        return fetch(url, init)
      },
      onCheckpoint: checkpoint => process.send?.({ type: 'checkpoint', ...checkpoint }),
    })
    process.send?.({ type: 'result', result }, () => process.disconnect())
  } catch (error) {
    process.send?.({ type: 'error', message: error.message }, () => { process.exitCode = 1; process.disconnect() })
  }
})
