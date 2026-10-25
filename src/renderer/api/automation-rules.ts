import type { AutomationRulesApi } from '@shared/automation-rules'
import { plainIpcData } from './plain-ipc-data'

declare global { interface Window { automationRulesAPI: AutomationRulesApi } }
export const automationRulesApi: AutomationRulesApi = {
  listActions: () => window.automationRulesAPI.listActions(),
  listRules: () => window.automationRulesAPI.listRules(),
  saveRule: input => window.automationRulesAPI.saveRule(plainIpcData(input)),
  setEnabled: input => window.automationRulesAPI.setEnabled(plainIpcData(input)),
  removeRule: input => window.automationRulesAPI.removeRule(input),
  dryRun: input => window.automationRulesAPI.dryRun(input),
  runNow: input => window.automationRulesAPI.runNow(plainIpcData(input)),
  listRuns: input => window.automationRulesAPI.listRuns(plainIpcData(input)),
}
