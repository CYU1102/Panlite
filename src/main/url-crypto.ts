import { app, safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import log from 'electron-log'
import { isWindowsTaskPassword, protectWindowsKey, unprotectWindowsKey } from './windows-dpapi'

const FORMAT_PREFIX = 'pl2'
const KEY_FILE_NAME = 'url-crypto.key'
const LEGACY_KEY = Buffer.from('ABCD0000000000000000000000000000')
const LEGACY_IV = Buffer.from('1234567890123456')

let cachedKey: Buffer | null = null

function readKey(keyPath: string): Buffer {
  const stored = readFileSync(keyPath, 'utf8')
  let key: Buffer
  if (isWindowsTaskPassword(stored)) {
    if (process.platform !== 'win32') throw new Error('URL 密钥只能在原 Windows 用户环境中解密')
    key = unprotectWindowsKey(stored)
  } else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取 URL 加密密钥')
    key = Buffer.from(safeStorage.decryptString(Buffer.from(stored, 'base64')), 'base64')
  }
  if (key.length !== 32) { key.fill(0); throw new Error('URL 加密密钥损坏') }
  return key
}

function getOrCreateKey(create: boolean): Buffer {
  const keyPath = join(app.getPath('userData'), KEY_FILE_NAME)
  if (cachedKey) {
    if (!existsSync(keyPath)) throw new Error('URL 加密密钥缺失，请从完整快照恢复')
    return cachedKey
  }
  if (existsSync(keyPath)) {
    cachedKey = readKey(keyPath)
    return cachedKey
  }
  if (!create) throw new Error('URL 加密密钥缺失，请从完整快照恢复')

  const key = randomBytes(32)
  const temporary = join(dirname(keyPath), `.${KEY_FILE_NAME}.${randomUUID()}.tmp`)
  let temporaryCreated = false
  try {
    let protectedKey: string
    let verified: Buffer
    if (process.platform === 'win32') {
      protectedKey = protectWindowsKey(key)
      verified = unprotectWindowsKey(protectedKey)
    } else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保护 URL 加密密钥')
      protectedKey = safeStorage.encryptString(key.toString('base64')).toString('base64')
      verified = Buffer.from(safeStorage.decryptString(Buffer.from(protectedKey, 'base64')), 'base64')
    }
    try {
      if (verified.length !== key.length || !timingSafeEqual(verified, key)) throw new Error('URL 加密密钥校验失败')
    } finally { verified.fill(0) }
    mkdirSync(dirname(keyPath), { recursive: true })
    const fd = openSync(temporary, 'wx', 0o600)
    temporaryCreated = true
    try { writeFileSync(fd, protectedKey, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      // Hard-linking publishes the completed file without replacing a competing key.
      linkSync(temporary, keyPath)
      cachedKey = Buffer.from(key)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      cachedKey = readKey(keyPath)
    }
    return cachedKey
  } finally {
    key.fill(0)
    if (temporaryCreated) unlinkSync(temporary)
  }
}

function decryptLegacy(value: string): string {
  const decipher = createDecipheriv('aes-256-cbc', LEGACY_KEY, LEGACY_IV)
  return decipher.update(value, 'base64', 'utf8') + decipher.final('utf8')
}

/** Encrypt with a per-installation key, a random nonce, and authenticated AES-256-GCM. */
export function encryptUrl(url: string): string {
  try {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', getOrCreateKey(true), nonce)
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

    const decipher = createDecipheriv('aes-256-gcm', getOrCreateKey(false), nonce)
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
