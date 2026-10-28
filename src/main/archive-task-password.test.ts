import { beforeEach, describe, expect, it, vi } from 'vitest'

const crypto = vi.hoisted(() => ({ encryptCredential: vi.fn(), decryptCredential: vi.fn() }))
const dpapi = vi.hoisted(() => ({ protectWindowsTaskPassword: vi.fn(), unprotectWindowsTaskPassword: vi.fn(), isWindowsTaskPassword: (value: string) => value.startsWith('win-dpapi-v1:') }))
vi.mock('./crypto', () => crypto)
vi.mock('./windows-dpapi', () => dpapi)
import { archiveTaskPassword, protectArchiveTaskOptions } from './archive-task-password'

beforeEach(() => {
  vi.resetAllMocks()
  crypto.encryptCredential.mockImplementation((value: string) => `protected:${Buffer.from(value).toString('base64')}`)
  crypto.decryptCredential.mockImplementation((value: string) => Buffer.from(value.slice('protected:'.length), 'base64').toString())
  dpapi.protectWindowsTaskPassword.mockImplementation(async (value: string) => `win-dpapi-v1:${Buffer.from(value).toString('base64')}`)
  dpapi.unprotectWindowsTaskPassword.mockImplementation(async (value: string) => Buffer.from(value.slice('win-dpapi-v1:'.length), 'base64').toString())
})

describe('archive task password persistence', () => {
  it('stores protected bytes and recovers the exact password without serializing plaintext', async () => {
    const options = await protectArchiveTaskOptions({ targetDir: 'target', files: ['a.txt'], password: ' 中 密码 ' })
    expect(JSON.stringify(options)).not.toContain(' 中 密码 ')
    expect(options).not.toHaveProperty('password')
    expect(await archiveTaskPassword(options)).toBe(' 中 密码 ')
    expect(options.files).toEqual(['a.txt'])
  })

  it('does not require encryption for an unprotected archive', async () => {
    expect(await protectArchiveTaskOptions({ targetDir: 'target' })).toEqual({ targetDir: 'target', files: undefined })
    expect(crypto.encryptCredential).not.toHaveBeenCalled()
  })

  it('fails closed when system encryption is unavailable', async () => {
    crypto.encryptCredential.mockImplementation(() => { throw new Error('unavailable') })
    dpapi.protectWindowsTaskPassword.mockRejectedValue(new Error('unavailable'))
    await expect(protectArchiveTaskOptions({ targetDir: 'target', password: 'secret' })).rejects.toThrow('系统安全存储不可用')
  })

  it('keeps legacy pending tasks usable and rejects invalid or undecryptable protected data', async () => {
    expect(await archiveTaskPassword({ targetDir: 'target', password: 'legacy' })).toBe('legacy')
    expect(await archiveTaskPassword({ targetDir: 'target', encryptedPassword: `protected:${Buffer.from('old ciphertext').toString('base64')}` })).toBe('old ciphertext')
    await expect(archiveTaskPassword({ targetDir: 'target', password: 'legacy', encryptedPassword: 'protected' })).rejects.toThrow(/格式无效/)
    crypto.decryptCredential.mockImplementation(() => { throw new Error('secret must not be exposed') })
    await expect(archiveTaskPassword({ targetDir: 'target', encryptedPassword: 'invalid' })).rejects.toThrow('无法解密解压任务密码，请重新创建任务')
  })
})
