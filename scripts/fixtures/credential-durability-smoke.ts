import { app, safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { initDatabase, insertAccount, getAccountById, getSetting, setSetting } from '../../src/main/db'
import { decryptCredential, encryptCredential } from '../../src/main/crypto'
import { decryptUrl, encryptUrl } from '../../src/main/url-crypto'

const [mode, root, scenario] = process.argv.slice(2)
if (!root || !['write', 'read'].includes(mode) || !['protected', 'legacy'].includes(scenario)) throw new Error('Invalid isolated test parameters')
const profile = path.join(root, 'profile')
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
const accountSecret = '{"cookie":"synthetic-cookie"}'
const settingSecret = 'synthetic-provider-key'
const url = 'https://example.test/synthetic-share'

app.whenReady().then(() => {
  initDatabase()
  if (mode === 'write') {
    if (scenario === 'legacy') {
      const oldKey = randomBytes(32)
      try { writeFileSync(path.join(profile, 'url-crypto.key'), safeStorage.encryptString(oldKey.toString('base64')).toString('base64'), { flag: 'wx' }) }
      finally { oldKey.fill(0) }
    }
    const encode = scenario === 'legacy' ? (value: string) => safeStorage.encryptString(value).toString('base64') : encryptCredential
    const account = encode(accountSecret), setting = encode(settingSecret)
    if (account.includes(accountSecret) || setting.includes(settingSecret)) throw new Error('Credential stored as plaintext')
    if (scenario === 'protected' && !account.startsWith('panlite-credential-v1:')) throw new Error('New credential format was not used')
    insertAccount({ id: 'fixture', platform: 'quark', nickname: 'fixture', login_type: 'cookie', encrypted_credential: account,
      user_agent: null, status: 'active', bind_machine: 0, created_at: Date.now(), updated_at: Date.now(), last_check_at: null })
    setSetting('aiProviderApiKey', setting, true)
    setSetting('syntheticEncryptedUrl', encryptUrl(url), false)
    if (scenario === 'protected') app.exit(0)
    else app.quit()
  } else {
    const account = getAccountById('fixture'), setting = getSetting('aiProviderApiKey')
    if (!account || !setting || decryptCredential(account.encrypted_credential) !== accountSecret || decryptCredential(setting.value) !== settingSecret) {
      throw new Error('Persisted synthetic credentials did not survive restart')
    }
    const encryptedUrl = getSetting('syntheticEncryptedUrl')
    if (!encryptedUrl || decryptUrl(encryptedUrl.value) !== url) throw new Error('Persisted encrypted URL did not survive restart')
    app.quit()
  }
}).catch(error => { console.error(error.message); app.exit(1) })
