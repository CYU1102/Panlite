import { app, safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import log from 'electron-log'

const FORMAT_PREFIX = 'pl2'
const KEY_FILE_NAME = 'url-crypto.key'
const LEGACY_KEY = Buffer.from('ABCD0000000000000000000000000000')
const LEGACY_IV = Buffer.from('1234567890123456')

let cachedKey: Buffer | null = null

function getOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保护 URL 加密密钥')

  const keyPath = join(app.getPath('userData'), KEY_FILE_NAME)
  if (existsSync(keyPath)) {
    const protectedKey = Buffer.from(readFileSync(keyPath, 'utf8'), 'base64')
    cachedKey = Buffer.from(safeStorage.decryptString(protectedKey), 'base64')
    if (cachedKey.length !== 32) throw new Error('URL 加密密钥损坏')
    return cachedKey
  }

  const key = randomBytes(32)
  const protectedKey = safeStorage.encryptString(key.toString('base64'))
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, protectedKey.toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  cachedKey = key
  return key
}

function decryptLegacy(value: string): string {
  const decipher = createDecipheriv('aes-256-cbc', LEGACY_KEY, LEGACY_IV)
  return decipher.update(value, 'base64', 'utf8') + decipher.final('utf8')
}

/** Encrypt with a per-installation key, a random nonce, and authenticated AES-256-GCM. */
export function encryptUrl(url: string): string {
  try {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', getOrCreateKey(), nonce)
    const ciphertext = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [FORMAT_PREFIX, nonce.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
  } catch (err) {
    log.error('[URL Crypto] Encryption error:', String(err))
    throw err
  }
}

/** Decrypt the authenticated format, with read-only support for legacy CBC values. */
export function decryptUrl(encryptedUrl: string): string {
  try {
    if (!encryptedUrl.startsWith(`${FORMAT_PREFIX}.`)) return decryptLegacy(encryptedUrl)

    const parts = encryptedUrl.split('.')
    if (parts.length !== 4) throw new Error('无效的 URL 加密格式')
    const nonce = Buffer.from(parts[1], 'base64url')
    const tag = Buffer.from(parts[2], 'base64url')
    const ciphertext = Buffer.from(parts[3], 'base64url')
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('无效的 URL 加密参数')

    const decipher = createDecipheriv('aes-256-gcm', getOrCreateKey(), nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch (err) {
    log.error('[URL Crypto] Decryption error:', String(err))
    throw err
  }
}

export function encryptUrls(urls: string[]): string[] {
  return urls.map(encryptUrl)
}

export function decryptUrls(encryptedUrls: string[]): string[] {
  return encryptedUrls.map(decryptUrl)
}

export function isEncryptedUrl(value: string): boolean {
  if (value.startsWith(`${FORMAT_PREFIX}.`)) {
    try {
      return decryptUrl(value).startsWith('http')
    } catch {
      return false
    }
  }

  if (!/^[A-Za-z0-9+/]+=*$/.test(value) || value.length < 20) return false
  try {
    const decrypted = decryptLegacy(value)
    return decrypted.includes('pan.quark.cn') ||
      decrypted.includes('pan.baidu.com') ||
      decrypted.includes('drive.uc.cn') ||
      decrypted.includes('pan.xunlei.com')
  } catch {
    return false
  }
}
