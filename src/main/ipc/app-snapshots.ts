import { APP_SNAPSHOT_CHANNELS, type AppSnapshotsApi } from '../../shared/app-snapshots'
import type { IpcRegistrar } from './types'

export function registerAppSnapshotsIpcHandlers(ipc: IpcRegistrar, api: AppSnapshotsApi, restart: () => void): void {
  for (const method of Object.keys(APP_SNAPSHOT_CHANNELS) as Array<keyof AppSnapshotsApi>) {
    ipc.handle(APP_SNAPSHOT_CHANNELS[method], async (_event, ...args: unknown[]) => {
      try {
        const result = await (api[method].bind(api) as (...input: unknown[]) => Promise<{ success: boolean }>)(...args)
        // The UI explicitly confirms restart before either request. Let the IPC
        // response reach it before the app exits; startup performs the operation.
        if (result.success && (method === 'requestSnapshot' || method === 'requestRestore')) setTimeout(restart, 350)
        return result
      } catch { return { success: false, error: '应用快照操作未完成，请检查快照状态后重试' } }
    })
  }
}
