import { CATALOG_CHANNELS, type CatalogApi } from '../../shared/catalog'
import type { IpcRegistrar } from './types'

/** The registrar supplied by ipc.ts applies the canonical renderer origin check. */
export function registerCatalogIpcHandlers(ipcMain: IpcRegistrar, api: CatalogApi): void {
  for (const method of Object.keys(CATALOG_CHANNELS) as Array<keyof CatalogApi>) {
    ipcMain.handle(CATALOG_CHANNELS[method], async (_event, ...args: unknown[]) => {
      try {
        const call = api[method].bind(api) as (...input: unknown[]) => Promise<unknown>
        return await call(...args)
      } catch {
        // Adapter exceptions can contain signed URLs or credentials. Keep raw
        // implementation errors out of the renderer and out of diagnostic logs.
        return { success: false, error: '文件目录操作未完成，请检查账号状态或重试' }
      }
    })
  }
}
