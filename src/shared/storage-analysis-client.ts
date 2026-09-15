import { STORAGE_ANALYSIS_CHANNELS, type StorageAnalysisApi } from './storage-analysis'

export function createStorageAnalysisClient(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): StorageAnalysisApi {
  return Object.fromEntries(Object.entries(STORAGE_ANALYSIS_CHANNELS).map(([method, channel]) => [method, (input: unknown) => invoke(channel, input)])) as unknown as StorageAnalysisApi
}
