// Compatibility entry point: the SVG renderer is the only icon generator.
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const result = spawnSync(process.execPath, [path.join(__dirname, 'build-icons.mjs')], { stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
