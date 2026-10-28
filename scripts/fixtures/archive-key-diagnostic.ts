import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [operation, root, method, shutdown] = process.argv.slice(2)
if (!root || !['write', 'read'].includes(operation) || !['sync', 'async'].includes(method)) throw new Error('Invalid diagnostic parameters')
const profile = path.join(root, 'profile')
const localState = path.join(profile, 'Local State')
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
const password = 'isolated synthetic fixture'
const keyState = () => {
  try {
    const state = JSON.parse(readFileSync(localState, 'utf8'))
    return { exists: true, hasKey: typeof state.os_crypt?.encrypted_key === 'string' && state.os_crypt.encrypted_key.length > 0 }
  } catch { return { exists: existsSync(localState), hasKey: false } }
}

app.whenReady().then(async () => {
  const task = path.join(root, 'task.json')
  if (operation === 'write') {
    const encrypted = method === 'async' ? await safeStorage.encryptStringAsync(password) : safeStorage.encryptString(password)
    const before = keyState()
    let waitedMs = 0
    if (shutdown === 'wait') {
      const start = Date.now()
      while (!keyState().hasKey && Date.now() - start < 12000) await new Promise(resolve => setTimeout(resolve, 100))
      waitedMs = Date.now() - start
    }
    const after = keyState()
    writeFileSync(task, JSON.stringify({ encrypted: encrypted.toString('base64'), before, after, waitedMs }), { flag: 'wx' })
    if (shutdown === 'normal') app.quit()
    else app.exit(0)
  } else {
    const saved = JSON.parse(readFileSync(task, 'utf8'))
    let ok = false
    try {
      const encrypted = Buffer.from(saved.encrypted, 'base64')
      const value = method === 'async' ? (await safeStorage.decryptStringAsync(encrypted)).result : safeStorage.decryptString(encrypted)
      ok = value === password
    } catch { /* Report failure without disclosing ciphertext or synthetic plaintext. */ }
    console.log(JSON.stringify({ ok, before: saved.before, after: saved.after, waitedMs: saved.waitedMs, stateAfterRestart: keyState() }))
    app.quit()
  }
}).catch(error => { console.error(error.message); app.exit(1) })
