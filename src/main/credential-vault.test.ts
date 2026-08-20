import { describe, expect, it } from 'vitest'
import {
  createVaultKey,
  openCredential,
  parseEnvelope,
  rotateCredential,
  sealCredential,
  serializeEnvelope,
} from './credential-vault'

describe('credential vault', () => {
  it('round-trips nested credentials in a versioned authenticated envelope', () => {
    const key = createVaultKey()
    const secret = { cookie: 'BDUSS=secret', oauth: { accessToken: 'access', refreshToken: 'refresh' } }
    const envelope = sealCredential(secret, key, { keyId: 'account-key', context: 'account:123' })

    expect(envelope).toMatchObject({ version: 1, algorithm: 'aes-256-gcm', keyId: 'account-key', context: 'account:123' })
    expect(JSON.stringify(envelope)).not.toContain('BDUSS')
    expect(openCredential(envelope, key, 'account:123')).toEqual(secret)
    expect(parseEnvelope(serializeEnvelope(envelope))).toEqual(envelope)
  })

  it('uses a fresh nonce for each encryption', () => {
    const key = createVaultKey()
    const first = sealCredential('same-secret', key)
    const second = sealCredential('same-secret', key)
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })

  it('rejects a wrong key, context, and tampered authenticated metadata', () => {
    const key = createVaultKey()
    const envelope = sealCredential('secret', key, { context: 'account:a' })
    expect(() => openCredential(envelope, createVaultKey())).toThrow('密钥错误或数据已被篡改')
    expect(() => openCredential(envelope, key, 'account:b')).toThrow('凭据用途不匹配')

    const tampered = { ...envelope, keyId: 'attacker-key' }
    expect(() => openCredential(tampered, key)).toThrow('密钥错误或数据已被篡改')
  })

  it('rotates credentials to a new key without exposing plaintext in the envelope', () => {
    const oldKey = createVaultKey()
    const newKey = createVaultKey()
    const original = sealCredential({ password: 'never-log-me' }, oldKey, { context: 'login' })
    const rotated = rotateCredential(original, oldKey, newKey, { keyId: 'v2-key' })

    expect(() => openCredential(rotated, oldKey)).toThrow()
    expect(openCredential(rotated, newKey)).toEqual({ password: 'never-log-me' })
    expect(JSON.stringify(rotated)).not.toContain('never-log-me')
  })

  it('validates key length and envelope versions', () => {
    expect(() => sealCredential('secret', Buffer.alloc(16))).toThrow('32 字节')
    expect(() => parseEnvelope('{"version":2}')).toThrow('不支持')
  })
})
