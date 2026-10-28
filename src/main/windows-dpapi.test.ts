import { describe, expect, it } from 'vitest'
import { isWindowsTaskPassword, protectWindowsKey, protectWindowsTaskPassword, unprotectWindowsKey, unprotectWindowsTaskPassword } from './windows-dpapi'

describe.skipIf(process.platform !== 'win32')('Windows DPAPI task password integration', () => {
  it('round trips Unicode, spaces and symbols without storing plaintext', async () => {
    const password = ' 测试 & $() ` 密码 '
    const encrypted = await protectWindowsTaskPassword(password)
    expect(isWindowsTaskPassword(encrypted)).toBe(true)
    expect(encrypted).not.toContain(password)
    expect(await unprotectWindowsTaskPassword(encrypted)).toBe(password)
  }, 15000)

  it('rejects malformed and modified ciphertext without returning a password', async () => {
    await expect(unprotectWindowsTaskPassword('win-dpapi-v1:!!!!')).rejects.toThrow()
    const encrypted = await protectWindowsTaskPassword('synthetic test')
    const prefix = 'win-dpapi-v1:'
    const data = Buffer.from(encrypted.slice(prefix.length), 'base64')
    data[data.length - 1] ^= 1
    await expect(unprotectWindowsTaskPassword(prefix + data.toString('base64'))).rejects.toThrow()
  }, 15000)

  it('protects a binary master key with the same system account', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
    const protectedKey = protectWindowsKey(key)
    expect(unprotectWindowsKey(protectedKey)).toEqual(key)
    expect(protectedKey).not.toContain(key.toString('base64'))
  }, 15000)
})
