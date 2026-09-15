import { AUTOMATION_RULE_CHANNELS, type AutomationRulesApi } from './automation-rules'

export function createAutomationRulesClient(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): AutomationRulesApi {
  return {
    listActions: () => invoke(AUTOMATION_RULE_CHANNELS.listActions) as ReturnType<AutomationRulesApi['listActions']>,
    listRules: () => invoke(AUTOMATION_RULE_CHANNELS.listRules) as ReturnType<AutomationRulesApi['listRules']>,
    saveRule: input => invoke(AUTOMATION_RULE_CHANNELS.saveRule, input) as ReturnType<AutomationRulesApi['saveRule']>,
    setEnabled: input => invoke(AUTOMATION_RULE_CHANNELS.setEnabled, input) as ReturnType<AutomationRulesApi['setEnabled']>,
    removeRule: input => invoke(AUTOMATION_RULE_CHANNELS.removeRule, input) as ReturnType<AutomationRulesApi['removeRule']>,
    dryRun: input => invoke(AUTOMATION_RULE_CHANNELS.dryRun, input) as ReturnType<AutomationRulesApi['dryRun']>,
    runNow: input => invoke(AUTOMATION_RULE_CHANNELS.runNow, input) as ReturnType<AutomationRulesApi['runNow']>,
    listRuns: input => invoke(AUTOMATION_RULE_CHANNELS.listRuns, input) as ReturnType<AutomationRulesApi['listRuns']>,
  }
}
