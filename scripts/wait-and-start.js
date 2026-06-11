const http = require('http')
const { spawn } = require('child_process')
const path = require('path')

const port = process.env.VITE_PORT || '5173'
const electronBin = require('electron')

function checkServer() {
  return new Promise((resolve) => {
    http.get(`http://localhost:${port}`, (res) => {
      resolve(res.statusCode === 200)
    }).on('error', () => resolve(false))
  })
}

async function waitForServer(maxRetries = 30, interval = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    if (await checkServer()) {
      console.log(`Vite dev server ready on port ${port}`)
      return true
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  console.error('Vite dev server did not start in time')
  return false
}

async function main() {
  const ready = await waitForServer()
  if (!ready) process.exit(1)

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  env.VITE_DEV_SERVER_URL = `http://localhost:${port}`

  const child = spawn(electronBin, ['.'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'inherit',
  })

  child.on('exit', (code) => {
    process.exit(code || 0)
  })
}

main()
