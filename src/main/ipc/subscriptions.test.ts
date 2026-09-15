import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../shared/constants'
import type { IpcRegistrar } from './types'
import type { IpcMainInvokeEvent } from 'electron'

const service = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn(), toggle: vi.fn(), runNow: vi.fn() }))
vi.mock('../share-subscriptions', () => ({ getShareSubscriptionScheduler: () => service, initShareSubscriptionScheduler: () => service }))
import { registerSubscriptionIpcHandlers } from './subscriptions'
const handlers = new Map<string, (...args: unknown[]) => unknown>()
beforeEach(() => {
  vi.clearAllMocks(); handlers.clear()
  registerSubscriptionIpcHandlers({ handle: (name, callback) => handlers.set(name, (...args: unknown[]) => callback(args[0] as IpcMainInvokeEvent, ...args.slice(1))) } as IpcRegistrar)
})
describe('subscription IPC', () => {
  it('forwards versioned edits through the existing channel and reports validation failures', async () => {
    service.save.mockResolvedValue({ id: 's', configVersion: 2 })
    const input = { id: 's', expectedVersion: 1, scope: 'recursive' }
    expect(await handlers.get(IPC_CHANNELS.SUBSCRIPTION_ADD)!(null, input)).toMatchObject({ success: true, id: 's' })
    expect(service.save).toHaveBeenCalledWith(input)
    service.save.mockRejectedValue(new Error('stale configuration'))
    expect(await handlers.get(IPC_CHANNELS.SUBSCRIPTION_ADD)!(null, input)).toEqual({ success: false, error: 'stale configuration' })
  })
  it('rejects malformed pause input without changing service state', async () => {
    expect(await handlers.get(IPC_CHANNELS.SUBSCRIPTION_TOGGLE)!(null, { id: 's', active: 'false' })).toMatchObject({ success: false })
    expect(service.toggle).not.toHaveBeenCalled()
    expect(await handlers.get(IPC_CHANNELS.SUBSCRIPTION_TOGGLE)!(null, { id: 's', active: false })).toEqual({ success: true })
    expect(service.toggle).toHaveBeenCalledWith('s', false)
  })
  it('returns a missing subscription result for manual checks', async () => {
    service.runNow.mockResolvedValue(false)
    expect(await handlers.get(IPC_CHANNELS.SUBSCRIPTION_RUN_NOW)!(null, 'deleted')).toEqual({ success: false, error: '订阅不存在' })
  })
})
