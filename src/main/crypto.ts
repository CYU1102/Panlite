import { safeStorage } from 'electron'

export function encryptCredential(data: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage is not available — cannot encrypt credential')
  }
  const encrypted = safeStorage.encryptString(data)
  return encrypted.toString('base64')
}

export function decryptCredential(encryptedBase64: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage is not available — cannot decrypt credential')
  }
  const buffer = Buffer.from(encryptedBase64, 'base64')
  return safeStorage.decryptString(buffer)
}
