import { describe, expect, it, vi } from 'vitest'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount } from '../shared/types'
import { AccountRequestBudget, budgetDriveAdapter } from './account-request-budget'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise<void>(resolveTick => setImmediate(resolveTick))

describe('shared account request budgets', () => {
  it('shares permits between scans and transfers while independent accounts continue', async () => {
    const budget = new AccountRequestBudget(2)
    const gates = [deferred(), deferred()]
    const started: string[] = []
    const first = budget.run('a', 'background', async () => { started.push('scan'); await gates[0].promise })
    const second = budget.run('a', 'interactive', async () => { started.push('transfer'); await gates[1].promise })
    const third = budget.run('a', 'background', async () => { started.push('waiting') })
    await budget.run('b', 'interactive', async () => { started.push('other') })
    expect(started).toEqual(['scan', 'transfer', 'other'])
    gates[0].resolve(); await first; await third
    expect(started).toContain('waiting')
    gates[1].resolve(); await second
  })

  it('does not spend an additional permit for nested source requests', async () => {
    const budget = new AccountRequestBudget(1)
    expect(await budget.run('a', 'interactive', () => budget.run('a', 'interactive', async () => 42))).toBe(42)
    await expect(budget.run('a', 'interactive', async () => { throw new Error('request failed') })).rejects.toThrow('request failed')
    expect(await budget.run('a', 'background', async () => 'released')).toBe('released')
  })

  it('cancels queued requests without calling the provider or blocking successors', async () => {
    const budget = new AccountRequestBudget(1)
    const gate = deferred()
    const holding = budget.run('a', 'interactive', () => gate.promise)
    const controller = new AbortController()
    let called = false
    const cancelled = budget.run('a', 'background', async () => { called = true }, controller.signal)
    const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejection
    gate.resolve(); await holding
    await budget.run('a', 'background', async () => {})
    expect(called).toBe(false)
  })

  it('gives interactive work preference without starving a background scan', async () => {
    const budget = new AccountRequestBudget(1)
    const gate = deferred()
    const holding = budget.run('a', 'interactive', () => gate.promise)
    await tick()
    const order: string[] = []
    const scan = budget.run('a', 'background', async () => { order.push('scan') })
    const transfers = Array.from({ length: 8 }, (_, i) => budget.run('a', 'interactive', async () => { order.push(`t${i}`) }))
    gate.resolve(); await Promise.all([holding, scan, ...transfers])
    expect(order[0]).toBe('t0')
    expect(order.indexOf('scan')).toBeLessThanOrEqual(4)
    expect(order).toHaveLength(9)
  })

  it.each(['saveSharedFiles', 'listSharedDirectory'] as const)('cancels a queued %s request before calling the provider', async method => {
    const gate = deferred(), save = vi.fn(async () => ({ success: true }))
    const adapter = budgetDriveAdapter({ listFiles: () => gate.promise, [method]: save } as unknown as DriveAdapter)
    const account = { id: `share-budget-${method}` } as DriveAccount
    const holding = [adapter.listFiles(account, 'root'), adapter.listFiles(account, 'root')]
    await tick()
    const controller = new AbortController()
    const waiting = method === 'saveSharedFiles'
      ? adapter.saveSharedFiles!(account, { url: 'https://example.invalid/share' }, 'target', { signal: controller.signal })
      : adapter.listSharedDirectory!(account, { url: 'https://example.invalid/share' }, { signal: controller.signal })
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    try {
      controller.abort()
      await rejected
      expect(save).not.toHaveBeenCalled()
    } finally { gate.resolve(); await Promise.allSettled([...holding, waiting]) }
  })

  it('preserves the provider receiver, arguments, result and rejection for newly budgeted methods', async () => {
    const account = { id: 'share-budget-receiver' } as DriveAccount
    const input = { url: 'https://example.invalid/share' }, result = { files: [] }, error = new Error('provider failure')
    const raw = {
      getShareDetail: vi.fn(async function (this: unknown, actualAccount: DriveAccount, actualInput: unknown) {
        expect(this).toBe(raw); expect(actualAccount).toBe(account); expect(actualInput).toBe(input)
        return result
      }),
      cancelShare: vi.fn(async function (this: unknown) { expect(this).toBe(raw); throw error }),
    }
    const adapter = budgetDriveAdapter(raw as unknown as DriveAdapter)
    expect(await adapter.getShareDetail!(account, input)).toBe(result)
    await expect(adapter.cancelShare!(account, 'share-id')).rejects.toBe(error)
    expect(await adapter.getShareDetail!(account, input)).toBe(result)
  })

  it.each(['searchFiles', 'getShareDetail', 'listSharedDirectory', 'cancelShare'] as const)('budgets the actual %s adapter method', async method => {
    const gate = deferred(), operation = vi.fn(async () => undefined)
    const adapter = budgetDriveAdapter({ listFiles: () => gate.promise, [method]: operation } as unknown as DriveAdapter)
    const account = { id: `actual-method-${method}` } as DriveAccount
    const holding = [adapter.listFiles(account, 'root'), adapter.listFiles(account, 'root')]
    await tick()
    const waiting = (adapter[method] as unknown as (account: DriveAccount, argument: unknown) => Promise<unknown>)(account, 'fixture')
    try {
      await tick()
      expect(operation).not.toHaveBeenCalled()
    } finally { gate.resolve(); await Promise.allSettled([...holding, waiting]) }
    expect(operation).toHaveBeenCalledTimes(1)
  })
})
