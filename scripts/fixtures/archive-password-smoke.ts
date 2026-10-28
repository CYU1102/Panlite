import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { archiveTaskPassword, protectArchiveTaskOptions } from '../../src/main/archive-task-password'

const [mode, root] = process.argv.slice(2)
const fixturePassword = '合成 password 1234'
if (!root || !['write', 'read'].includes(mode)) throw new Error('Invalid isolated test parameters')
const profile = path.join(root, 'profile')
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

app.whenReady().then(() => {
  const payloadPath = path.join(root, 'task.json')
  if (mode === 'write') {
    const payload = JSON.stringify(protectArchiveTaskOptions({ targetDir: root, password: fixturePassword }))
    if (payload.includes(fixturePassword)) throw new Error('Task password was stored in plaintext')
    writeFileSync(payloadPath, payload, { flag: 'wx' })
  } else {
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
    if (!payload.encryptedPassword || payload.password !== undefined || archiveTaskPassword(payload) !== fixturePassword) {
      throw new Error('Protected task password could not be recovered in a new process')
    }
  }
  app.exit(0)
}).catch(error => { console.error(error.message); app.exit(1) })
