import { FILE_BACKUP_CHANNELS, type FileBackupsApi } from '../../shared/file-backup'
import type { IpcRegistrar } from './types'

export function registerFileBackupsIpcHandlers(ipc: IpcRegistrar, api: FileBackupsApi): void {
  for (const method of Object.keys(FILE_BACKUP_CHANNELS) as Array<keyof FileBackupsApi>) {
    ipc.handle(FILE_BACKUP_CHANNELS[method], async (_event, ...args: unknown[]) => {
      try { return await (api[method].bind(api) as (...input: unknown[]) => Promise<unknown>)(...args) }
      catch { return { success: false, error: '文件备份操作未完成，请检查目录和账号后重试' } }
    })
  }
}
