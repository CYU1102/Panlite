import { afterEach, expect, it, vi } from 'vitest'
import { APP_SNAPSHOT_CHANNELS, type AppSnapshotsApi } from '../../shared/app-snapshots'
import { registerAppSnapshotsIpcHandlers } from './app-snapshots'

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers()
  const api = {
    listSnapshots: vi.fn(async () => ({ success: true, snapshots: [] })),
    inspectSnapshot: vi.fn(async () => ({ success: true })),
    getPendingOperation: vi.fn(async () => ({ success: true, pending: null })),
    cancelPendingOperation: vi.fn(async () => ({ success: true })),
    requestSnapshot: vi.fn(async () => ({ success: true, restartRequired: true })),
    requestRestore: vi.fn(async () => ({ success: true, restartRequired: true })),
  }
  const handlers = new Map<string, (...args: unknown[]) => unknown>(), restart = vi.fn()
  registerAppSnapshotsIpcHandlers({ handle(channel, listener) { handlers.set(channel, listener as (...args: unknown[]) => unknown) } }, api as unknown as AppSnapshotsApi, restart)
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  return { api, handlers, invoke, restart }
}
it('does not restart for read-only inspection or cancellation', async () => {
  const { handlers, invoke, restart } = fixture()
  expect([...handlers.keys()]).toEqual(Object.values(APP_SNAPSHOT_CHANNELS))
  for (const method of ['listSnapshots', 'inspectSnapshot', 'getPendingOperation', 'cancelPendingOperation'] as const) await invoke(APP_SNAPSHOT_CHANNELS[method], 'id')
  await vi.runAllTimersAsync(); expect(restart).not.toHaveBeenCalled()
})
it('returns the confirmed request before scheduling a single restart', async () => {
  const { api, invoke, restart } = fixture()
  expect(await invoke(APP_SNAPSHOT_CHANNELS.requestSnapshot, '升级前')).toMatchObject({ success: true })
  expect(api.requestSnapshot).toHaveBeenCalledWith('升级前'); expect(restart).not.toHaveBeenCalled()
  await vi.runAllTimersAsync(); expect(restart).toHaveBeenCalledTimes(1)
})
it('keeps the app running when a restore request fails and sanitizes unexpected failures', async () => {
  const { api, invoke, restart } = fixture()
  api.requestRestore.mockRejectedValueOnce(new Error('private credential should not cross IPC'))
  expect(await invoke(APP_SNAPSHOT_CHANNELS.requestRestore, 'id')).toEqual({ success: false, error: '应用快照操作未完成，请检查快照状态后重试' })
  await vi.runAllTimersAsync(); expect(restart).not.toHaveBeenCalled()
})
