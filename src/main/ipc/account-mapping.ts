import type { DriveAccount } from '../../shared/types'
import { decryptCredential } from '../crypto'
import type { DbAccount } from '../db'
import log from 'electron-log'

export function dbAccountToDriveAccount(row: DbAccount): DriveAccount {
  let credential: DriveAccount['credential'] = {}
  try {
    const decrypted = decryptCredential(row.encrypted_credential)
    credential = JSON.parse(decrypted)
  } catch {
    log.warn('Failed to decrypt credential for account:', row.id)
  }

  return {
    id: row.id,
    platform: row.platform as DriveAccount['platform'],
    nickname: row.nickname || '',
    loginType: row.login_type as DriveAccount['loginType'],
    credential,
    userAgent: row.user_agent || undefined,
    status: row.status as DriveAccount['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckAt: row.last_check_at || undefined,
  }
}
export function sanitizeAccount(account: DriveAccount): Omit<DriveAccount, 'credential'> & { credential: undefined } {
  return { ...account, credential: undefined as any }
}
