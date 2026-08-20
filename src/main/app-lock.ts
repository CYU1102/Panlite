import { createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto'

export type AppLockStatus = 'disabled' | 'locked' | 'unlocked' | 'cooldown'
export type AppLockReason = 'manual' | 'startup' | 'idle' | 'password-changed' | null

export interface AppLockRecordV1 {
  version: 1
  kdf: {
    name: 'scrypt'
    salt: string
    cost: number
    blockSize: number
    parallelization: number
    keyLength: number
  }
  verifier: string
  autoLockMs: number
}
export type AppLockRecord = AppLockRecordV1

export interface AppLockSnapshot {
  enabled: boolean
  status: AppLockStatus
  reason: AppLockReason
  autoLockMs: number
  failedAttempts: number
  retryAfterMs: number
  lastActivityAt: number | null
}

export interface UnlockResult {
  success: boolean
  retryAfterMs: number
}

export interface AppLockOptions {
  record?: AppLockRecord | null
  now?: () => number
  minimumPasswordLength?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
}

const DEFAULT_SCRYPT = {
  name: 'scrypt' as const,
  cost: 1 << 15,
  blockSize: 8,
  parallelization: 1,
  keyLength: 32,
}
const DEFAULT_MINIMUM_PASSWORD_LENGTH = 8
const DEFAULT_BACKOFF_BASE_MS = 500
const DEFAULT_BACKOFF_MAX_MS = 30_000
const MAX_AUTO_LOCK_MS = 30 * 24 * 60 * 60 * 1000
const VERIFIER_CONTEXT = 'PanLite app lock verifier v1'

function deriveKey(password: string, record: AppLockRecordV1): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      Buffer.from(record.kdf.salt, 'base64url'),
      record.kdf.keyLength,
      {
        N: record.kdf.cost,
        r: record.kdf.blockSize,
        p: record.kdf.parallelization,
        maxmem: 64 * 1024 * 1024,
      },
      (error, key) => {
        if (error) reject(error)
        else resolve(key as Buffer)
      },
    )
  })
}

function createVerifier(key: Buffer): Buffer {
  return createHmac('sha256', key).update(VERIFIER_CONTEXT).digest()
}

function validateAutoLockMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_AUTO_LOCK_MS) {
    throw new Error(`自动锁定时间必须是 0 到 ${MAX_AUTO_LOCK_MS} 毫秒之间的整数`)
  }
  return value
}

function validateRecord(record: AppLockRecord): AppLockRecordV1 {
  if (
    record.version !== 1 ||
    record.kdf.name !== 'scrypt' ||
    record.kdf.cost !== DEFAULT_SCRYPT.cost ||
    record.kdf.blockSize !== DEFAULT_SCRYPT.blockSize ||
    record.kdf.parallelization !== DEFAULT_SCRYPT.parallelization ||
    record.kdf.keyLength !== DEFAULT_SCRYPT.keyLength
  ) {
    throw new Error('不支持或不安全的应用锁配置')
  }
  const salt = Buffer.from(record.kdf.salt, 'base64url')
  const verifier = Buffer.from(record.verifier, 'base64url')
  if (salt.length !== 16 || verifier.length !== 32) throw new Error('应用锁配置已损坏')
  validateAutoLockMs(record.autoLockMs)
  return structuredClone(record)
}

function validatePassword(password: string, minimumLength: number): void {
  if (typeof password !== 'string' || password.length < minimumLength) {
    throw new Error(`密码至少需要 ${minimumLength} 个字符`)
  }
  if (Buffer.byteLength(password, 'utf8') > 1024) throw new Error('密码过长')
}

async function createRecord(password: string, autoLockMs: number, minimumLength: number): Promise<AppLockRecordV1> {
  validatePassword(password, minimumLength)
  const record: AppLockRecordV1 = {
    version: 1,
    kdf: {
      ...DEFAULT_SCRYPT,
      salt: randomBytes(16).toString('base64url'),
    },
    verifier: '',
    autoLockMs: validateAutoLockMs(autoLockMs),
  }
  const key = await deriveKey(password, record)
  try {
    record.verifier = createVerifier(key).toString('base64url')
    return record
  } finally {
    key.fill(0)
  }
}

export class AppLock {
  private record: AppLockRecordV1 | null
  private status: AppLockStatus
  private reason: AppLockReason
  private failedAttempts = 0
  private retryAt = 0
  private lastActivityAt: number | null = null
  private readonly now: () => number
  private readonly minimumPasswordLength: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number

  constructor(options: AppLockOptions = {}) {
    this.record = options.record ? validateRecord(options.record) : null
    this.status = this.record ? 'locked' : 'disabled'
    this.reason = this.record ? 'startup' : null
    this.now = options.now ?? Date.now
    this.minimumPasswordLength = options.minimumPasswordLength ?? DEFAULT_MINIMUM_PASSWORD_LENGTH
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
    if (this.minimumPasswordLength < 1) throw new Error('minimumPasswordLength 必须大于 0')
    if (this.backoffBaseMs < 0 || this.backoffMaxMs < this.backoffBaseMs) throw new Error('失败退避配置无效')
  }

  async configure(password: string, autoLockMs = 5 * 60 * 1000): Promise<AppLockRecord> {
    if (this.record) throw new Error('应用锁已经启用，请使用 changePassword')
    this.record = await createRecord(password, autoLockMs, this.minimumPasswordLength)
    this.status = 'unlocked'
    this.reason = null
    this.failedAttempts = 0
    this.retryAt = 0
    this.lastActivityAt = this.now()
    return this.exportRecord() as AppLockRecord
  }

  async unlock(password: string): Promise<UnlockResult> {
    this.refreshState()
    if (!this.record) return { success: true, retryAfterMs: 0 }
    const currentTime = this.now()
    if (this.status === 'cooldown') return { success: false, retryAfterMs: Math.max(0, this.retryAt - currentTime) }

    const matches = await this.verifyPassword(password)
    if (matches) {
      this.status = 'unlocked'
      this.reason = null
      this.failedAttempts = 0
      this.retryAt = 0
      this.lastActivityAt = this.now()
      return { success: true, retryAfterMs: 0 }
    }

    this.failedAttempts += 1
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(this.failedAttempts - 1, 20))
    this.retryAt = this.now() + delay
    this.status = delay > 0 ? 'cooldown' : 'locked'
    this.reason = 'manual'
    this.lastActivityAt = null
    return { success: false, retryAfterMs: delay }
  }

  lock(reason: Exclude<AppLockReason, null> = 'manual'): AppLockSnapshot {
    if (!this.record) return this.snapshot()
    this.status = 'locked'
    this.reason = reason
    this.retryAt = 0
    this.lastActivityAt = null
    return this.snapshot()
  }

  noteActivity(): AppLockSnapshot {
    this.refreshState()
    if (this.status === 'unlocked') this.lastActivityAt = this.now()
    return this.snapshot()
  }

  tick(): AppLockSnapshot {
    this.refreshState()
    return this.snapshot()
  }

  setAutoLockMs(autoLockMs: number): AppLockRecord {
    if (!this.record) throw new Error('应用锁尚未启用')
    this.record.autoLockMs = validateAutoLockMs(autoLockMs)
    if (this.status === 'unlocked') this.lastActivityAt = this.now()
    return this.exportRecord() as AppLockRecord
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<AppLockRecord> {
    if (!this.record) throw new Error('应用锁尚未启用')
    this.refreshState()
    if (this.status === 'cooldown') throw new Error(`请在 ${Math.ceil((this.retryAt - this.now()) / 1000)} 秒后重试`)
    if (!(await this.verifyPassword(currentPassword))) {
      await this.registerAdministrativeFailure()
      throw new Error('当前密码不正确')
    }
    this.record = await createRecord(newPassword, this.record.autoLockMs, this.minimumPasswordLength)
    this.status = 'locked'
    this.reason = 'password-changed'
    this.failedAttempts = 0
    this.retryAt = 0
    this.lastActivityAt = null
    return this.exportRecord() as AppLockRecord
  }

  async disable(password: string): Promise<void> {
    if (!this.record) return
    this.refreshState()
    if (this.status === 'cooldown') throw new Error(`请在 ${Math.ceil((this.retryAt - this.now()) / 1000)} 秒后重试`)
    if (!(await this.verifyPassword(password))) {
      await this.registerAdministrativeFailure()
      throw new Error('当前密码不正确')
    }
    this.record = null
    this.status = 'disabled'
    this.reason = null
    this.failedAttempts = 0
    this.retryAt = 0
    this.lastActivityAt = null
  }

  snapshot(): AppLockSnapshot {
    this.refreshState()
    return {
      enabled: this.record !== null,
      status: this.status,
      reason: this.reason,
      autoLockMs: this.record?.autoLockMs ?? 0,
      failedAttempts: this.failedAttempts,
      retryAfterMs: this.status === 'cooldown' ? Math.max(0, this.retryAt - this.now()) : 0,
      lastActivityAt: this.lastActivityAt,
    }
  }

  exportRecord(): AppLockRecord | null {
    return this.record ? structuredClone(this.record) : null
  }

  private refreshState(): void {
    if (!this.record) return
    const currentTime = this.now()
    if (this.status === 'cooldown' && currentTime >= this.retryAt) {
      this.status = 'locked'
      this.retryAt = 0
    }
    if (
      this.status === 'unlocked' &&
      this.record.autoLockMs > 0 &&
      this.lastActivityAt !== null &&
      currentTime - this.lastActivityAt >= this.record.autoLockMs
    ) {
      this.status = 'locked'
      this.reason = 'idle'
      this.lastActivityAt = null
    }
  }

  private async verifyPassword(password: string): Promise<boolean> {
    if (!this.record || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 1024) return false
    let key: Buffer | null = null
    let candidate: Buffer | null = null
    const expected = Buffer.from(this.record.verifier, 'base64url')
    try {
      key = await deriveKey(password, this.record)
      candidate = createVerifier(key)
      return candidate.length === expected.length && timingSafeEqual(candidate, expected)
    } catch {
      return false
    } finally {
      key?.fill(0)
      candidate?.fill(0)
      expected.fill(0)
    }
  }

  private async registerAdministrativeFailure(): Promise<void> {
    this.failedAttempts += 1
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(this.failedAttempts - 1, 20))
    this.retryAt = this.now() + delay
    this.status = delay > 0 ? 'cooldown' : 'locked'
    this.reason = 'manual'
    this.lastActivityAt = null
  }
}
