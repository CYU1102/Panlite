import type { TrustedIpcHandler } from '../ipc-security'

/**
 * Minimal registrar contract shared by IPC domain modules.
 *
 * The concrete registrar lives in `../ipc.ts`, where handlers are wrapped with
 * the renderer-origin security check before they reach a domain module.
 */
export interface IpcRegistrar {
  handle(channel: string, listener: TrustedIpcHandler): void
}
