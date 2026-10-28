import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ db: null as unknown as Database.Database }))
vi.mock('./db', () => ({ getDb: () => mocks.db }))
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`legacy:${value}`),
  decryptString: (value: Buffer) => value.toString('utf8').slice('legacy:'.length),
} }))
import { decryptCredential, encryptCredential } from './crypto'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function setup(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE credential_key_protection(id INTEGER PRIMARY KEY, protected_key TEXT NOT NULL); CREATE TABLE accounts(encrypted_credential TEXT); CREATE TABLE settings(value TEXT, encrypted INTEGER)')
  databases.push(db)
  mocks.db = db
  return db
}

describe.skipIf(process.platform !== 'win32')('durable Windows account credential integration', () => {
  it('writes protected data to SQLite and can still read legacy safeStorage ciphertext', () => {
    const db = setup()
    const secret = '{"cookie":"synthetic-cookie"}'
    const encrypted = encryptCredential(secret)
    db.prepare('INSERT INTO accounts(encrypted_credential) VALUES (?)').run(encrypted)
    expect(encrypted).not.toContain(secret)
    expect(decryptCredential(encrypted)).toBe(secret)
    expect(decryptCredential(Buffer.from('legacy:old-credential').toString('base64'))).toBe('old-credential')
    expect(db.prepare('SELECT count(*) AS n FROM credential_key_protection').get()).toEqual({ n: 1 })
  }, 15000)
})
