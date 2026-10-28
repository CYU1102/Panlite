import type Database from 'better-sqlite3'
import { timingSafeEqual } from 'node:crypto'
import { createVaultKey, openCredential, sealCredential, type CredentialEnvelope } from './credential-vault'

export const PROTECTED_CREDENTIAL_PREFIX = 'panlite-credential-v1:'
const CONTEXT = 'panlite:local-credential:v1'

export interface CredentialKeyProtection {
  protect: (key: Buffer) => string
  unprotect: (value: string) => Buffer
}

/** One protected key lives inside the same SQLite snapshots as its ciphertexts. */
export class ProtectedCredentialStore {
  private key: Buffer | null = null
  private protectedKey: string | null = null
  constructor(private readonly db: Database.Database, private readonly protection: CredentialKeyProtection) {}

  private getKey(create: boolean): Buffer {
    const select = () => this.db.prepare('SELECT protected_key FROM credential_key_protection WHERE id = 1').get() as { protected_key: string } | undefined
    let row = select()
    if (this.key && row?.protected_key === this.protectedKey) return this.key
    this.dispose()
    if (!row && create) {
      // Never replace a missing key if any credential already depends on it.
      const pattern = `${PROTECTED_CREDENTIAL_PREFIX}%`
      const existing = this.db.prepare('SELECT 1 FROM accounts WHERE encrypted_credential LIKE ? LIMIT 1').get(pattern)
        || this.db.prepare('SELECT 1 FROM settings WHERE encrypted = 1 AND value LIKE ? LIMIT 1').get(pattern)
      if (existing) throw new Error('凭据保护密钥缺失，请从完整快照恢复')
      const candidate = createVaultKey()
      try {
        const wrapped = this.protection.protect(candidate)
        const verified = this.protection.unprotect(wrapped)
        try {
          if (verified.length !== candidate.length || !timingSafeEqual(verified, candidate)) throw new Error('凭据保护密钥校验失败')
        } finally { verified.fill(0) }
        const inserted = this.db.prepare('INSERT OR IGNORE INTO credential_key_protection (id, protected_key) VALUES (1, ?)').run(wrapped)
        if (inserted.changes === 1) {
          this.key = Buffer.from(candidate)
          this.protectedKey = wrapped
          return this.key
        }
      } finally { candidate.fill(0) }
      row = select()
    }
    if (!row) throw new Error('凭据保护密钥缺失，请从完整快照恢复')
    const key = this.protection.unprotect(row.protected_key)
    if (key.length !== 32) { key.fill(0); throw new Error('凭据保护密钥损坏') }
    this.key = key
    this.protectedKey = row.protected_key
    return key
  }

  encrypt(value: string): string {
    const envelope = sealCredential(value, this.getKey(true), { keyId: 'local-v1', context: CONTEXT })
    return PROTECTED_CREDENTIAL_PREFIX + JSON.stringify(envelope)
  }

  decrypt(value: string): string {
    if (!value.startsWith(PROTECTED_CREDENTIAL_PREFIX) || value.length > 24 * 1024 * 1024) throw new Error('凭据格式无效')
    let envelope: CredentialEnvelope
    try { envelope = JSON.parse(value.slice(PROTECTED_CREDENTIAL_PREFIX.length)) as CredentialEnvelope }
    catch { throw new Error('凭据格式无效') }
    const result = openCredential(envelope, this.getKey(false), CONTEXT)
    if (typeof result !== 'string') throw new Error('凭据格式无效')
    return result
  }

  dispose(): void { this.key?.fill(0); this.key = null; this.protectedKey = null }
}
