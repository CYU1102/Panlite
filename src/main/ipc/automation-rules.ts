import { AUTOMATION_RULE_CHANNELS, type AutomationRulesApi } from '../../shared/automation-rules'
import type { IpcRegistrar } from './types'

export function registerAutomationRulesIpcHandlers(ipc: IpcRegistrar, api: AutomationRulesApi): void {
  for (const method of Object.keys(AUTOMATION_RULE_CHANNELS) as Array<keyof AutomationRulesApi>) {
    ipc.handle(AUTOMATION_RULE_CHANNELS[method], async (_event, ...args: unknown[]) => {
      try { return await (api[method].bind(api) as (...input: unknown[]) => Promise<unknown>)(...args) }
      catch { return { success: false, error: '规则操作未完成，请检查计划后重试' } }
    })
  }
}
