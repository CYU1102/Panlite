import { describe, expect, it, vi } from 'vitest'
import type { DriveAccount } from '../shared/types'
import type { ShareSubscription, SubscriptionEntry } from '../shared/subscription-types'
import type { DriveAdapter } from '../adapters/base'
import { scanSubscription, subscriptionContentChanged, planSubscription } from './subscription-recursive'

const config = { id: 's', scope: 'recursive', platform: 'quark', initialMode: 'save_existing', includeKeywords: [], excludeKeywords: [], extensions: [], preserveStructure: true } as unknown as ShareSubscription
const account = { id: 'a', platform: 'quark' } as DriveAccount
const options = () => ({ signal: new AbortController().signal, request: async <T>(_id: string, execute: () => Promise<T>) => execute(), assertCurrent: vi.fn() })
const entry = (patch: Partial<SubscriptionEntry> = {}): SubscriptionEntry => ({ fileId: 'f', name: 'f', parentId: '0', relativePath: 'f', isDir: false, size: 10, ...patch })

describe('subscription scan bounds and evidence', () => {
  it('rejects a directory cycle before accepting a baseline', async () => {
    const adapter = { listSharedDirectory: async () => ({ complete: true, entries: [{ fileId: 'a', name: 'a', isDir: true }] }) } as unknown as DriveAdapter
    await expect(scanSubscription(config, account, adapter, options())).rejects.toThrow(/循环|重复/)
  })
  it('rejects exceeded depth and entry limits rather than truncating the tree', async () => {
    const adapter = { listSharedDirectory: async (_a: unknown, _i: unknown, value: { parentId: string }) => ({ complete: true,
      entries: [{ fileId: `${value.parentId}-next`, name: 'next', isDir: true }] }) } as unknown as DriveAdapter
    await expect(scanSubscription(config, account, adapter, { ...options(), maxDepth: 1 })).rejects.toThrow(/上限/)
    await expect(scanSubscription(config, account, adapter, { ...options(), maxEntries: 1 })).rejects.toThrow(/上限/)
  })
  it('rejects incomplete listings and unsafe or colliding target paths', async () => {
    let response: unknown = { complete: false, entries: [] }
    const adapter = { listSharedDirectory: async () => response } as unknown as DriveAdapter
    await expect(scanSubscription(config, account, adapter, options())).rejects.toThrow(/未完成/)
    response = { complete: true, entries: [entry({ name: '../outside' })] }
    await expect(scanSubscription(config, account, adapter, options())).rejects.toThrow(/无效名称/)
    response = { complete: true, entries: [entry({ name: 'A.txt' }), entry({ fileId: 'other', name: 'a.txt' })] }
    await expect(scanSubscription(config, account, adapter, options())).rejects.toThrow(/同名路径/)
  })
  it('does not turn metadata changes into content changes without verifiable evidence', () => {
    expect(subscriptionContentChanged(entry(), entry({ name: 'new' }))).toBe(false)
    expect(subscriptionContentChanged(entry(), entry({ size: undefined }))).toBe(false)
    expect(subscriptionContentChanged(entry({ contentHash: { algorithm: 'sha1', value: 'a'.repeat(40) } }), entry({ contentHash: { algorithm: 'sha1', value: 'b'.repeat(40) } }))).toBe(true)
    expect(subscriptionContentChanged(entry({ contentHash: { algorithm: 'sha1', value: 'a' } }), entry({ contentHash: { algorithm: 'sha1', value: 'b' } }))).toBe(false)
  })
  it('creates only empty directories and never duplicates whole folders plus their leaves', () => {
    const snapshot = [entry({ fileId: 'dir', name: 'dir', isDir: true, relativePath: 'dir' }), entry({ parentId: 'dir', relativePath: 'dir/f' }), entry({ fileId: 'empty', name: 'empty', isDir: true, relativePath: 'empty' })]
    const work = planSubscription(config, snapshot, [])
    expect(work.map(item => [item.kind, item.targetRelativePath])).toEqual([['save', 'dir'], ['directory', 'empty']])
  })
})
