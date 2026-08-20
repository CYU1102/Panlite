import { describe, expect, it } from 'vitest'
import { AppLock } from './app-lock'

describe('AppLock', () => {
  it('creates a scrypt verifier without retaining the password', async () => {
    const lock = new AppLock({ minimumPasswordLength: 4 })
    const first = await lock.configure('correct horse', 60_000)

    expect(first.version).toBe(1)
    expect(first.kdf.name).toBe('scrypt')
    expect(JSON.stringify(first)).not.toContain('correct horse')
    expect(lock.snapshot()).toMatchObject({ status: 'unlocked', autoLockMs: 60_000 })

    const secondLock = new AppLock({ minimumPasswordLength: 4 })
    const second = await secondLock.configure('correct horse', 60_000)
    expect(second.kdf.salt).not.toBe(first.kdf.salt)
    expect(second.verifier).not.toBe(first.verifier)
  })

  it('uses cooldown backoff and resets failures after a valid unlock', async () => {
    let now = 1_000
    const configured = new AppLock({ now: () => now, minimumPasswordLength: 4 })
    const record = await configured.configure('open-sesame')
    const lock = new AppLock({ record, now: () => now, minimumPasswordLength: 4, backoffBaseMs: 100 })

    expect(await lock.unlock('wrong')).toEqual({ success: false, retryAfterMs: 100 })
    expect(lock.snapshot().status).toBe('cooldown')
    expect(await lock.unlock('open-sesame')).toEqual({ success: false, retryAfterMs: 100 })

    now += 100
    expect(await lock.unlock('wrong-again')).toEqual({ success: false, retryAfterMs: 200 })
    now += 200
    expect(await lock.unlock('open-sesame')).toEqual({ success: true, retryAfterMs: 0 })
    expect(lock.snapshot()).toMatchObject({ status: 'unlocked', failedAttempts: 0 })
  })

  it('auto-locks after inactivity and activity restarts the timer', async () => {
    let now = 0
    const lock = new AppLock({ now: () => now, minimumPasswordLength: 4 })
    await lock.configure('safe-password', 1_000)

    now = 900
    lock.noteActivity()
    now = 1_800
    expect(lock.tick().status).toBe('unlocked')
    now = 1_900
    expect(lock.tick()).toMatchObject({ status: 'locked', reason: 'idle' })
  })

  it('requires the current password to change or disable the lock', async () => {
    let now = 0
    const lock = new AppLock({ now: () => now, minimumPasswordLength: 4, backoffBaseMs: 1 })
    await lock.configure('old-password')

    await expect(lock.changePassword('wrong', 'new-password')).rejects.toThrow('当前密码不正确')
    now += 1
    await lock.changePassword('old-password', 'new-password')
    expect(lock.snapshot()).toMatchObject({ status: 'locked', reason: 'password-changed' })
    expect((await lock.unlock('new-password')).success).toBe(true)
    await lock.disable('new-password')
    expect(lock.snapshot()).toMatchObject({ enabled: false, status: 'disabled' })
  })

  it('rejects modified or downgraded records', async () => {
    const lock = new AppLock({ minimumPasswordLength: 4 })
    const record = await lock.configure('safe-password')
    const modified = structuredClone(record)
    modified.kdf.cost = 2
    expect(() => new AppLock({ record: modified })).toThrow('不支持或不安全')
  })
})
