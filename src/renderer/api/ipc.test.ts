// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.resetModules(); delete (window as any).electronAPI })

it('exposes the preload bridge unchanged, including event cleanup and rejection', async () => {
  const cleanup = vi.fn()
  const bridge = { listTasks: vi.fn(async () => ({ success: true, tasks: [{ id: 'task' }] })),
    uploadFiles: vi.fn(async () => { throw new Error('IPC disconnected') }),
    onTaskUpdated: vi.fn(() => cleanup) }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: bridge })
  const { electronApi } = await import('./ipc')
  expect(await electronApi.listTasks()).toEqual({ success: true, tasks: [{ id: 'task' }] })
  const unsubscribe = electronApi.onTaskUpdated(() => {})
  unsubscribe()
  expect(cleanup).toHaveBeenCalledOnce()
  await expect(electronApi.uploadFiles({ accountId: 'account', files: [], targetDirId: 'root' })).rejects.toThrow('IPC disconnected')
})
