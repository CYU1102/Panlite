import type { IpcRegistrar } from './types'
import { inlineLoginManager } from '../inline-login'
import { IPC_CHANNELS } from '../../shared/constants'

export function registerInlineLoginIpcHandlers(registrar: IpcRegistrar): void {
  registrar.handle(IPC_CHANNELS.LOGIN_INLINE_START, (event, platform: unknown) => inlineLoginManager.start(event.sender, platform))
  registrar.handle(IPC_CHANNELS.LOGIN_INLINE_STATUS, (event, id: unknown) => inlineLoginManager.status(event.sender, id))
  registrar.handle(IPC_CHANNELS.LOGIN_INLINE_CANCEL, (event, id: unknown) => inlineLoginManager.cancel(event.sender, id))
}
