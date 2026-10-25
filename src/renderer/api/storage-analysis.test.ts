// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { isProxy, reactive } from 'vue'
import { STORAGE_ANALYSIS_CHANNELS, type StorageAnalysisApi } from '@shared/storage-analysis'
import { createStorageAnalysisClient } from '@shared/storage-analysis-client'
import { storageAnalysisApi } from './storage-analysis'

afterEach(() => { vi.unstubAllGlobals() })
it('sends fixed IPC channels and strips nested Vue proxies for every structured operation', async () => {
  const invoke = vi.fn(async () => ({ success: true }))
  window.storageAnalysisAPI = createStorageAnalysisClient(invoke)
  const query = reactive({ accountIds: ['a'], scopeIds: ['scope'], fileTypes: ['document'], group: { name: '计划.pdf', size: 100 }, refs: [{ accountId: 'a', fileId: 'same' }], keep: { accountId: 'a', fileId: 'same' }, remove: [{ accountId: 'b', fileId: 'same' }], format: 'csv' })
  const inspect = (value: unknown) => { expect(isProxy(value)).toBe(false); if (value && typeof value === 'object') for (const child of Object.values(value)) inspect(child) }
  for (const method of Object.keys(STORAGE_ANALYSIS_CHANNELS) as Array<keyof StorageAnalysisApi>) {
    await (storageAnalysisApi[method] as (input: unknown) => Promise<unknown>)(query)
    expect(invoke).toHaveBeenLastCalledWith(STORAGE_ANALYSIS_CHANNELS[method], expect.any(Object))
    const payload = invoke.mock.calls[invoke.mock.calls.length - 1] as unknown as [string, unknown]
    inspect(payload[1]); expect(payload[1]).toEqual(query)
  }
})
