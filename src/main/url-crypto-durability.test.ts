import { createCipheriv } from 'node:crypto'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.directory }, safeStorage: {
  isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8'),
} }))
vi.mock('electron-log', () => ({ default: { error: vi.fn() } }))
vi.mock('./windows-dpapi', () => ({
  isWindowsTaskPassword: (value: string) => value.startsWith('win-dpapi-v1:'),
  protectWindowsKey: (value: Buffer) => `win-dpapi-v1:${value.toString('base64')}`,
  unprotectWindowsKey: (value: string) => Buffer.from(value.slice('win-dpapi-v1:'.length), 'base64'),
}))

beforeEach(() => { state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-url-durable-test-')); vi.resetModules() })
afterEach(() => { vi.doUnmock('node:fs'); fs.rmSync(state.directory, { recursive: true, force: true }) })

function protectedUrl(key: Buffer, value: string): string {
  const nonce = Buffer.alloc(12, 1)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `pl2.${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`
}

describe('durable URL key creation', () => {
  it('does not create a replacement when decrypting an existing URL with a missing key', async () => {
    const { decryptUrl } = await import('./url-crypto')
    expect(() => decryptUrl(protectedUrl(Buffer.alloc(32, 3), 'https://example.test'))).toThrow(/密钥缺失/)
    expect(fs.existsSync(path.join(state.directory, 'url-crypto.key'))).toBe(false)
  })

  it('reads a legacy protected key without rewriting it', async () => {
    const key = Buffer.alloc(32, 4)
    const oldValue = Buffer.from(key.toString('base64')).toString('base64')
    const filename = path.join(state.directory, 'url-crypto.key')
    fs.writeFileSync(filename, oldValue)
    const { decryptUrl } = await import('./url-crypto')
    expect(decryptUrl(protectedUrl(key, 'https://example.test'))).toBe('https://example.test')
    expect(fs.readFileSync(filename, 'utf8')).toBe(oldValue)
  })

  it('does not replace an unreadable existing key', async () => {
    const filename = path.join(state.directory, 'url-crypto.key')
    fs.writeFileSync(filename, 'invalid key')
    const { encryptUrl } = await import('./url-crypto')
    expect(() => encryptUrl('https://example.test')).toThrow()
    expect(fs.readFileSync(filename, 'utf8')).toBe('invalid key')
  })

  it('cleans up the owned temporary file and does not publish a key after a failed flush', async () => {
    vi.doMock('node:fs', async importOriginal => ({ ...await importOriginal<typeof fs>(), fsyncSync: () => { throw new Error('fixture flush failed') } }))
    const { encryptUrl } = await import('./url-crypto')
    expect(() => encryptUrl('https://example.test')).toThrow('fixture flush failed')
    expect(fs.readdirSync(state.directory)).toEqual([])
  })

  it.skipIf(process.platform !== 'win32')('uses the already published key if another process wins creation', async () => {
    const winningKey = Buffer.alloc(32, 7)
    vi.doMock('node:fs', async importOriginal => ({ ...await importOriginal<typeof fs>(), linkSync: (_source: string, dest: string) => {
      fs.writeFileSync(dest, `win-dpapi-v1:${winningKey.toString('base64')}`, { flag: 'wx' })
      throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    } }))
    const { encryptUrl } = await import('./url-crypto')
    const encrypted = encryptUrl('https://example.test')
    const [, nonce, tag, ciphertext] = encrypted.split('.')
    const { createDecipheriv } = await import('node:crypto')
    const decipher = createDecipheriv('aes-256-gcm', winningKey, Buffer.from(nonce, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    expect(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString()).toBe('https://example.test')
    expect(fs.readdirSync(state.directory)).toEqual(['url-crypto.key'])
  })

  it('refuses to encrypt more data if a cached key file disappears', async () => {
    const { encryptUrl } = await import('./url-crypto')
    encryptUrl('https://example.test')
    fs.unlinkSync(path.join(state.directory, 'url-crypto.key'))
    expect(() => encryptUrl('https://example.test/next')).toThrow(/密钥缺失/)
    expect(fs.readdirSync(state.directory)).toEqual([])
  })
})
