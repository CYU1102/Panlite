import { STORAGE_ANALYSIS_CHANNELS, type StorageAnalysisApi } from '../../shared/storage-analysis'
import type { IpcRegistrar } from './types'

export function registerStorageAnalysisIpcHandlers(ipcMain: IpcRegistrar, api: StorageAnalysisApi): void {
  for (const method of Object.keys(STORAGE_ANALYSIS_CHANNELS) as Array<keyof StorageAnalysisApi>) {
    ipcMain.handle(STORAGE_ANALYSIS_CHANNELS[method], async (_event, ...args: unknown[]) => {
      try { return await (api[method].bind(api) as (...input: unknown[]) => Promise<unknown>)(...args) }
      catch { return { success: false, error: '空间分析操作未完成，请重试' } }
    })
  }
}
