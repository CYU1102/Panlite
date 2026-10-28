import { beforeEach, describe, expect, it, vi } from 'vitest'

const crypto = vi.hoisted(() => ({ encryptCredential: vi.fn(), decryptCredential: vi.fn() }))
vi.mock('./crypto', () => crypto)
import { archiveTaskPassword, protectArchiveTaskOptions } from './archive-task-password'

beforeEach(() => {
  vi.resetAllMocks()
  crypto.encryptCredential.mockImplementation((value: string) => `protected:${Buffer.from(value).toString('base64')}`)
  crypto.decryptCredential.mockImplementation((value: string) => Buffer.from(value.slice('protected:'.length), 'base64').toString())
})

describe('archive task password persistence', () => {
  it('stores protected bytes and recovers the exact password without serializing plaintext', () => {
    const options = protectArchiveTaskOptions({ targetDir: 'target', files: ['a.txt'], password: ' 中 密码 ' })
    expect(JSON.stringify(options)).not.toContain(' 中 密码 ')
    expect(options).not.toHaveProperty('password')
    expect(archiveTaskPassword(options)).toBe(' 中 密码 ')
    expect(options.files).toEqual(['a.txt'])
  })

  it('does not require encryption for an unprotected archive', () => {
    expect(protectArchiveTaskOptions({ targetDir: 'target' })).toEqual({ targetDir: 'target', files: undefined })
    expect(crypto.encryptCredential).not.toHaveBeenCalled()
  })

  it('fails closed when system encryption is unavailable', () => {
    crypto.encryptCredential.mockImplementation(() => { throw new Error('unavailable') })
    expect(() => protectArchiveTaskOptions({ targetDir: 'target', password: 'secret' })).toThrow('系统安全存储不可用')
  })

  it('keeps legacy pending tasks usable and rejects invalid or undecryptable protected data', () => {
    expect(archiveTaskPassword({ targetDir: 'target', password: 'legacy' })).toBe('legacy')
    expect(() => archiveTaskPassword({ targetDir: 'target', password: 'legacy', encryptedPassword: 'protected' })).toThrow(/格式无效/)
    crypto.decryptCredential.mockImplementation(() => { throw new Error('secret must not be exposed') })
    expect(() => archiveTaskPassword({ targetDir: 'target', encryptedPassword: 'invalid' })).toThrow('无法解密解压任务密码，请重新创建任务')
  })
})
