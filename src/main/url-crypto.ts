import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import log from 'electron-log'

/**
 * URL加密/解密工具
 * 参考 xinyue-search 的 encryptObject/decryptObject 实现
 * 使用 AES-256-CBC 加密算法
 */

// 加密密钥（与xinyue-search一致）
const ENCRYPTION_KEY = 'ABCD0000000000000000000000000000' // 32字节 for AES-256
const IV = '1234567890123456' // 16字节 IV（与xinyue-search一致）

/**
 * 加密URL
 * 与 xinyue-search 的 encryptObject 逻辑一致
 */
export function encryptUrl(url: string): string {
  try {
    const cipher = createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), Buffer.from(IV))
    let encrypted = cipher.update(url, 'utf8', 'base64')
    encrypted += cipher.final('base64')
    return encrypted
  } catch (err) {
    log.error('[URL Crypto] Encryption error:', String(err))
    return url
  }
}

/**
 * 解密URL
 * 与 xinyue-search 的 decryptObject 逻辑一致
 */
export function decryptUrl(encryptedUrl: string): string {
  try {
    const decipher = createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), Buffer.from(IV))
    let decrypted = decipher.update(encryptedUrl, 'base64', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch (err) {
    log.error('[URL Crypto] Decryption error:', String(err))
    return encryptedUrl
  }
}

/**
 * 批量加密URL
 */
export function encryptUrls(urls: string[]): string[] {
  return urls.map(encryptUrl)
}

/**
 * 批量解密URL
 */
export function decryptUrls(encryptedUrls: string[]): string[] {
  return encryptedUrls.map(decryptUrl)
}

/**
 * 检查字符串是否是加密的URL
 * 简单判断：加密后的字符串是base64格式且长度较长
 */
export function isEncryptedUrl(str: string): boolean {
  // Base64格式检查
  const base64Regex = /^[A-Za-z0-9+/]+=*$/
  if (!base64Regex.test(str)) return false

  // 加密后的URL通常较长
  if (str.length < 20) return false

  // 尝试解密看看是否能还原
  try {
    const decrypted = decryptUrl(str)
    // 如果解密后包含网盘链接特征，说明是加密的
    return decrypted.includes('pan.quark.cn') ||
           decrypted.includes('pan.baidu.com') ||
           decrypted.includes('drive.uc.cn') ||
           decrypted.includes('pan.xunlei.com')
  } catch {
    return false
  }
}
