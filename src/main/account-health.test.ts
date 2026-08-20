import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountHealthScheduler } from './account-health'

interface TestAccount {
  id: string
  status: 'active' | 'expired' | 'error'
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AccountHealthScheduler', () => {
  it('limits concurrency and only reports actual status changes', async () => {
    const accounts: TestAccount[] = Array.from({ length: 6 }, (_, index) => ({
      id: String(index),
      status: 'active',
    }))
    let activeChecks = 0
    let peakChecks = 0
    const changes: string[] = []
    const checked: string[] = []
    const scheduler = new AccountHealthScheduler({
      getAccounts: () => accounts,
      concurrency: 2,
      checkAccount: async (account) => {
        activeChecks += 1
        peakChecks = Math.max(peakChecks, activeChecks)
        await new Promise((resolve) => setTimeout(resolve, 5))
        activeChecks -= 1
        return account.id === '0' ? false : true
      },
      onAccountChecked: (event) => {
        checked.push(`${event.account.id}:${event.status}`)
      },
      onStatusChange: (change) => {
        changes.push(`${change.account.id}:${change.previousStatus}->${change.status}`)
      },
    })

    const first = await scheduler.runNow()
    const second = await scheduler.runNow()

    expect(peakChecks).toBe(2)
    expect(first).toMatchObject({ total: 6, checked: 6, changes: 1, aborted: false })
    expect(first.statuses).toEqual({ active: 5, expired: 1, error: 0 })
    expect(second.changes).toBe(0)
    expect(checked).toHaveLength(12)
    expect(changes).toEqual(['0:active->expired'])
  })

  it('reports expiration once and reports recovery as a new change', async () => {
    const account: TestAccount = { id: 'account-1', status: 'active' }
    const results = [false, false, true]
    const changes: string[] = []
    const scheduler = new AccountHealthScheduler({
      getAccounts: () => [account],
      checkAccount: () => results.shift() ?? true,
      onStatusChange: ({ previousStatus, status }) => {
        changes.push(`${previousStatus}->${status}`)
      },
    })

    await scheduler.runNow()
    await scheduler.runNow()
    await scheduler.runNow()

    expect(changes).toEqual(['active->expired', 'expired->active'])
    expect(scheduler.getKnownStatus(account.id)).toBe('active')
  })

  it('maps check failures to error without stopping other accounts', async () => {
    const errors: string[] = []
    const scheduler = new AccountHealthScheduler<TestAccount>({
      getAccounts: () => [
        { id: 'bad', status: 'active' },
        { id: 'good', status: 'active' },
      ],
      checkAccount: (account) => {
        if (account.id === 'bad') throw new Error('network unavailable')
        return true
      },
      onStatusChange: ({ account, status, error }) => {
        errors.push(`${account.id}:${status}:${error instanceof Error ? error.message : ''}`)
      },
    })

    const result = await scheduler.runNow()

    expect(result).toMatchObject({ checked: 2, changes: 1 })
    expect(result.statuses).toEqual({ active: 1, expired: 0, error: 1 })
    expect(errors).toEqual(['bad:error:network unavailable'])
  })

  it('starts on schedule and releases its timer when stopped', async () => {
    vi.useFakeTimers()
    let checks = 0
    const scheduler = new AccountHealthScheduler<TestAccount>({
      getAccounts: () => [{ id: 'account-1', status: 'active' }],
      checkAccount: () => {
        checks += 1
        return true
      },
      intervalMs: 100,
      runImmediately: false,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(99)
    expect(checks).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(checks).toBe(1)

    scheduler.stop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(checks).toBe(1)
    expect(scheduler.isRunning()).toBe(false)
  })

  it('aborts in-flight checks and suppresses stale callbacks after stop', async () => {
    let receivedSignal: AbortSignal | undefined
    let releaseCheck: (() => void) | undefined
    const changes = vi.fn()
    const scheduler = new AccountHealthScheduler<TestAccount>({
      getAccounts: () => [{ id: 'account-1', status: 'active' }],
      checkAccount: (_account, signal) => new Promise<boolean>((resolve) => {
        receivedSignal = signal
        releaseCheck = () => resolve(false)
      }),
      onStatusChange: changes,
    })

    scheduler.start()
    await vi.waitFor(() => expect(receivedSignal).toBeDefined())
    scheduler.stop()
    releaseCheck?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(receivedSignal?.aborted).toBe(true)
    expect(changes).not.toHaveBeenCalled()
  })
})
