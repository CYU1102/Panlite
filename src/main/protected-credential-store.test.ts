import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ProtectedCredentialStore, PROTECTED_CREDENTIAL_PREFIX } from './protected-credential-store'

function database(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE credential_key_protection(id INTEGER PRIMARY KEY, protected_key TEXT NOT NULL); CREATE TABLE accounts(encrypted_credential TEXT); CREATE TABLE settings(value TEXT, encrypted INTEGER)')
  return db
}
const protection = {
  protect: (key: Buffer) => `fixture:${key.toString('base64')}`,
  unprotect: (value: string) => Buffer.from(value.slice('fixture:'.length), 'base64'),
}

describe('database-backed protected credential key', () => {
  it('preserves exact data with a cached key and a newly constructed store', () => {
    const db = database()
    try {
      const store = new ProtectedCredentialStore(db, protection)
      const password = ' 密码 & \n \u0000 '
      const first = store.encrypt(password)
      const second = store.encrypt(password)
      expect(first.startsWith(PROTECTED_CREDENTIAL_PREFIX)).toBe(true)
      expect(first).not.toContain(password)
      expect(first).not.toBe(second)
      expect(store.decrypt(first)).toBe(password)
      store.dispose()
      expect(new ProtectedCredentialStore(db, protection).decrypt(first)).toBe(password)
      expect(db.prepare('SELECT count(*) AS n FROM credential_key_protection').get()).toEqual({ n: 1 })
    } finally { db.close() }
  })

  it('rejects a missing or replaced key without silently overwriting protected data', () => {
    const db = database()
    try {
      const store = new ProtectedCredentialStore(db, protection)
      const encrypted = store.encrypt('secret')
      db.prepare('INSERT INTO accounts(encrypted_credential) VALUES (?)').run(encrypted)
      db.exec('DELETE FROM credential_key_protection')
      expect(() => store.decrypt(encrypted)).toThrow(/密钥缺失/)
      expect(() => store.encrypt('another')).toThrow(/密钥缺失/)
      expect(db.prepare('SELECT count(*) AS n FROM credential_key_protection').get()).toEqual({ n: 0 })
    } finally { db.close() }
  })

  it('fails closed if system key protection fails or ciphertext is tampered with', () => {
    const db = database()
    try {
      const failed = new ProtectedCredentialStore(db, { ...protection, protect: () => { throw new Error('unavailable') } })
      expect(() => failed.encrypt('secret')).toThrow('unavailable')
      expect(db.prepare('SELECT count(*) AS n FROM credential_key_protection').get()).toEqual({ n: 0 })
      const corrupted = new ProtectedCredentialStore(db, { ...protection, unprotect: () => Buffer.alloc(32) })
      expect(() => corrupted.encrypt('secret')).toThrow(/密钥校验失败/)
      expect(db.prepare('SELECT count(*) AS n FROM credential_key_protection').get()).toEqual({ n: 0 })
      const store = new ProtectedCredentialStore(db, protection)
      const encrypted = store.encrypt('secret')
      const envelope = JSON.parse(encrypted.slice(PROTECTED_CREDENTIAL_PREFIX.length))
      envelope.context = 'another-context'
      expect(() => store.decrypt(PROTECTED_CREDENTIAL_PREFIX + JSON.stringify(envelope))).toThrow()
    } finally { db.close() }
  })
})
