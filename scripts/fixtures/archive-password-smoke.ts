import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { archiveTaskPassword, protectArchiveTaskOptions } from '../../src/main/archive-task-password'

const [mode, root, shutdown] = process.argv.slice(2)
const fixturePassword = '合成 password 1234'
if (!root || !['write', 'read'].includes(mode)) throw new Error('Invalid isolated test parameters')
const profile = path.join(root, 'profile')
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

app.whenReady().then(async () => {
  const payloadPath = path.join(root, 'task.json')
  if (mode === 'write') {
    const options = await protectArchiveTaskOptions({ targetDir: root, password: fixturePassword })
    if (await archiveTaskPassword(options) !== fixturePassword) throw new Error('Same-process password round trip failed')
    if (!options.encryptedPassword?.startsWith('win-dpapi-v1:')) throw new Error('Windows DPAPI protection was not used')
    const payload = JSON.stringify(options)
    if (payload.includes(fixturePassword)) throw new Error('Task password was stored in plaintext')
    writeFileSync(payloadPath, payload, { flag: 'wx' })
  } else {
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
    if (!payload.encryptedPassword || payload.password !== undefined || await archiveTaskPassword(payload) !== fixturePassword) {
      throw new Error('Protected task password could not be recovered in a new process')
    }
  }
  if (mode === 'write' && shutdown === 'force') app.exit(0)
  else app.quit()
}).catch(error => { console.error(error.message); app.exit(1) })
