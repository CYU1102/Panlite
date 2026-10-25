const http = require('http')
const { spawn } = require('child_process')
const path = require('path')

function checkServer(port = process.env.VITE_PORT || '5173', timeout = 1500) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return Promise.resolve(false)
  return new Promise(resolve => {
    const finish = value => { clearTimeout(timer); resolve(value) }
    const request = http.get(`http://localhost:${port}/__panlite_health`, res => {
      if (res.statusCode !== 200) { res.resume(); finish(false); return }
      const chunks = []
      let length = 0
      res.on('data', chunk => {
        length += chunk.length
        if (length > 4096) { res.destroy(); finish(false) }
        else chunks.push(chunk)
      })
      res.once('end', () => {
        try {
          const health = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
          finish(health.app === 'PanLite' && typeof health.projectRoot === 'string'
            && normalize(health.projectRoot) === normalize(path.resolve(__dirname, '..')))
        } catch { finish(false) }
      })
      res.once('error', () => finish(false))
      res.once('aborted', () => finish(false))
    })
    const timer = setTimeout(() => { request.destroy(); finish(false) }, timeout)
    request.on('error', () => finish(false))
  })
}

async function waitForServer(port = process.env.VITE_PORT || '5173', maxRetries = 30, interval = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    if (await checkServer(port)) {
      console.log(`Vite dev server ready on port ${port}`)
      return true
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  console.error('Vite dev server did not start in time')
  return false
}

async function runDevelopment({
  spawnProcess = spawn,
  wait = waitForServer,
  workspaceDir = path.resolve(__dirname, '..'),
  nodePath = process.execPath,
  electronPath = require('electron'),
  environment = process.env,
} = {}) {
  // The dev TypeScript watcher uses --noEmit. Always build the current main
  // sources before launch so a missing/stale dist cannot run an older backend.
  const buildCode = await new Promise((resolve, reject) => {
    const build = spawnProcess(nodePath, [path.join(workspaceDir, 'scripts/build-main.mjs')], {
      cwd: workspaceDir, env: { ...environment }, stdio: 'inherit', windowsHide: true,
    })
    build.once('error', reject)
    build.once('exit', code => resolve(code))
  })
  if (buildCode !== 0) throw new Error(`主进程构建失败（${buildCode ?? '进程中断'}），已停止启动`)
  const port = environment.VITE_PORT || '5173'
  if (!await wait(port)) throw new Error('Vite 开发服务未就绪，已停止启动')

  const env = { ...environment }
  delete env.ELECTRON_RUN_AS_NODE
  env.VITE_DEV_SERVER_URL = `http://localhost:${port}`

  return new Promise((resolve, reject) => {
    const child = spawnProcess(electronPath, ['.'], {
      cwd: workspaceDir, env, stdio: 'inherit', windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

if (require.main === module) {
  runDevelopment().then(code => { process.exitCode = code }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = { checkServer, waitForServer, runDevelopment }
