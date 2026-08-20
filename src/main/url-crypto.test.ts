import { afterAll, describe, expect, it, vi } from 'vitest'
import { createCipheriv } from 'node:crypto'
import { rmSync } from 'node:fs'

const testState = vi.hoisted(() => ({
  userData: `${process.env.TEMP || process.cwd()}\\panlite-url-crypto-${process.pid}`,
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

vi.mock('electron-log', () => ({
  default: { error: vi.fn() },
}))

import { decryptUrl, encryptUrl, isEncryptedUrl } from './url-crypto'

afterAll(() => rmSync(testState.userData, { recursive: true, force: true }))

describe('URL encryption', () => {
  it('round-trips authenticated values with a random nonce', () => {
    const url = 'https://pan.quark.cn/s/example'
    const first = encryptUrl(url)
    const second = encryptUrl(url)
    expect(first).not.toBe(second)
    expect(decryptUrl(first)).toBe(url)
    expect(isEncryptedUrl(first)).toBe(true)
  })

  it('rejects modified ciphertext', () => {
    const encrypted = encryptUrl('https://pan.baidu.com/s/example')
    const parts = encrypted.split('.')
    const tag = Buffer.from(parts[2], 'base64url')
    tag[0] ^= 0xff
    parts[2] = tag.toString('base64url')
    const tampered = parts.join('.')
    expect(() => decryptUrl(tampered)).toThrow()
  })

  it('can still decrypt legacy CBC values', () => {
    const url = 'https://drive.uc.cn/s/example'
    const cipher = createCipheriv(
      'aes-256-cbc',
      Buffer.from('ABCD0000000000000000000000000000'),
      Buffer.from('1234567890123456'),
    )
    const legacy = cipher.update(url, 'utf8', 'base64') + cipher.final('base64')
    expect(decryptUrl(legacy)).toBe(url)
    expect(isEncryptedUrl(legacy)).toBe(true)
  })
})
