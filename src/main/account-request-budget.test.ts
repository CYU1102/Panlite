import { describe, expect, it } from 'vitest'
import { AccountRequestBudget } from './account-request-budget'

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
})
