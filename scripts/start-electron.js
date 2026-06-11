const { spawn } = require('child_process')
const path = require('path')

const electronBin = require('electron')

const env = Object.assign({}, process.env)
delete env.ELECTRON_RUN_AS_NODE

// Pass Vite dev server URL to Electron
const port = process.env.VITE_PORT || '5173'
env.VITE_DEV_SERVER_URL = `http://localhost:${port}`

const child = spawn(electronBin, ['.'], {
  cwd: path.resolve(__dirname, '..'),
  env,
  stdio: 'inherit',
})

child.on('exit', (code) => {
  process.exit(code || 0)
})
