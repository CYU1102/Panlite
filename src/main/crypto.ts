import { safeStorage } from 'electron'
import { getDb } from './db'
import { ProtectedCredentialStore, PROTECTED_CREDENTIAL_PREFIX } from './protected-credential-store'
import { protectWindowsKey, unprotectWindowsKey } from './windows-dpapi'

let store: ProtectedCredentialStore | undefined
let storeDatabase: ReturnType<typeof getDb> | undefined

function currentStore(): ProtectedCredentialStore {
  const db = getDb()
  if (!store || storeDatabase !== db) {
    store?.dispose()
    storeDatabase = db
    store = new ProtectedCredentialStore(db, { protect: protectWindowsKey, unprotect: unprotectWindowsKey })
  }
  return store
}

export function encryptCredential(data: string): string {
  if (process.platform === 'win32') return currentStore().encrypt(data)
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage is not available — cannot encrypt credential')
  }
  const encrypted = safeStorage.encryptString(data)
  return encrypted.toString('base64')
}

export function decryptCredential(encryptedBase64: string): string {
  if (encryptedBase64.startsWith(PROTECTED_CREDENTIAL_PREFIX)) {
    if (process.platform !== 'win32') throw new Error('该凭据只能在原 Windows 用户环境中解密')
    return currentStore().decrypt(encryptedBase64)
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage is not available — cannot decrypt credential')
  }
  const buffer = Buffer.from(encryptedBase64, 'base64')
  return safeStorage.decryptString(buffer)
}
