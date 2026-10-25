import { TRANSFER_PLAN_CHANNELS, type TransferPlansApi } from '../../shared/transfer-plan'
import type { IpcRegistrar } from './types'

export function registerTransferPlansIpcHandlers(ipc: IpcRegistrar, api: TransferPlansApi): void {
  for (const method of Object.keys(TRANSFER_PLAN_CHANNELS) as Array<keyof TransferPlansApi>) {
    ipc.handle(TRANSFER_PLAN_CHANNELS[method], async (_event, ...args: unknown[]) => {
      try {
        return await (api[method].bind(api) as (...input: unknown[]) => Promise<unknown>)(...args)
      } catch {
        return { success: false, error: '迁移计划操作未完成，请检查账号状态后重试' }
      }
    })
  }
}
