import electron from 'electron'
import { stat } from 'node:fs/promises'

if (typeof electron !== 'string') throw new Error('Electron executable path is unavailable')
const executable = await stat(electron)
if (!executable.isFile()) throw new Error('Electron executable is missing')
console.log(`Electron runtime ready: ${electron}`)
