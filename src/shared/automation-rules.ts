export type AutomationAction = { kind: 'migration' | 'backup'; planId: string; planVersion: number }
export type AutomationTrigger =
  | { kind: 'manual' }
  | { kind: 'interval'; everyMinutes: number; missed: 'skip' | 'run_once' }
  | { kind: 'daily'; time: string; missed: 'skip' | 'run_once' }
  | { kind: 'task_success'; sourceRuleId: string }
export interface AutomationRuleInput { id?: string; expectedVersion?: number; name: string; enabled: boolean; trigger: AutomationTrigger; action: AutomationAction }
export interface AutomationRule extends Omit<AutomationRuleInput, 'id' | 'expectedVersion'> {
  id: string; version: number; createdAt: number; updatedAt: number
  nextRunAt?: number; lastSuccessAt?: number; lastRunId?: string; error?: string
  triggerSince: number
}
export interface AutomationActionOption extends AutomationAction { name: string }
export interface AutomationRun {
  id: string; ruleId: string; ruleVersion: number; eventKey: string
  status: 'preparing' | 'dispatching' | 'running' | 'success' | 'failed' | 'attention'
  createdAt: number; updatedAt: number; finishedAt?: number; taskId?: string; summary?: string
  previewId?: string; action: AutomationAction
}
export interface AutomationPreview { executable: boolean; summary: string; previewId?: string; itemCount: number; writeCount: number; transferBytes: number }
export type AutomationResult<T extends object = Record<never, never>> = ({ success: true } & T) | { success: false; error: string; code?: string }
export interface AutomationRulesApi {
  listActions(): Promise<AutomationResult<{ actions: AutomationActionOption[] }>>
  listRules(): Promise<AutomationResult<{ rules: AutomationRule[] }>>
  saveRule(input: AutomationRuleInput): Promise<AutomationResult<{ rule: AutomationRule }>>
  setEnabled(input: { id: string; enabled: boolean; expectedVersion: number }): Promise<AutomationResult<{ rule: AutomationRule }>>
  removeRule(id: string): Promise<AutomationResult>
  dryRun(id: string): Promise<AutomationResult<{ preview: AutomationPreview }>>
  runNow(input: string | { id: string; expectedVersion: number }): Promise<AutomationResult<{ run: AutomationRun }>>
  listRuns(input: { ruleId: string; page?: number; pageSize?: number }): Promise<AutomationResult<{ runs: AutomationRun[]; total: number; page: number; pageSize: number }>>
}
export const AUTOMATION_RULE_CHANNELS = {
  listActions: 'automation-rules:actions', listRules: 'automation-rules:list', saveRule: 'automation-rules:save', setEnabled: 'automation-rules:enabled',
  removeRule: 'automation-rules:remove', dryRun: 'automation-rules:dry-run', runNow: 'automation-rules:run', listRuns: 'automation-rules:runs',
} as const satisfies Record<keyof AutomationRulesApi, string>
