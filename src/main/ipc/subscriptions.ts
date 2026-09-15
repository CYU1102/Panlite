import { IPC_CHANNELS } from '../../shared/constants'
import type { ShareSubscriptionInput } from '../../shared/subscription-types'
import { getShareSubscriptionScheduler, initShareSubscriptionScheduler } from '../share-subscriptions'
import type { IpcRegistrar } from './types'

export type ShareSubscriptionAddInput = ShareSubscriptionInput
const scheduler = () => getShareSubscriptionScheduler() ?? initShareSubscriptionScheduler({ onSynced: () => undefined, onFailed: () => undefined })
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Existing channels also accept versioned edits; the main process validates capabilities. */
export function registerSubscriptionIpcHandlers(ipcMain: IpcRegistrar): void {
  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_LIST, async () => {
    try { return { success: true, subscriptions: scheduler().list() } }
    catch (error) { return { success: false, error: message(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_ADD, async (_event, input: ShareSubscriptionInput) => {
    try { const subscription = await scheduler().save(input); return { success: true, id: subscription.id, subscription } }
    catch (error) { return { success: false, error: message(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_REMOVE, async (_event, id: string) => {
    try { scheduler().remove(String(id || '')); return { success: true } }
    catch (error) { return { success: false, error: message(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_TOGGLE, async (_event, input: { id: string; active: boolean }) => {
    try {
      if (!input || typeof input.id !== 'string' || typeof input.active !== 'boolean') throw new Error('订阅状态参数不正确')
      scheduler().toggle(input.id, input.active); return { success: true }
    } catch (error) { return { success: false, error: message(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_RUN_NOW, async (_event, id: string) => {
    try { const ok = await scheduler().runNow(String(id || '')); return ok ? { success: true } : { success: false, error: '订阅不存在' } }
    catch (error) { return { success: false, error: message(error) } }
  })
}
