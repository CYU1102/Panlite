import { AsyncLocalStorage } from 'node:async_hooks'

interface Origin { ruleId: string; runId: string; taskType: string; active: boolean; attached: boolean; assertAllowed?: () => void }
const origins = new AsyncLocalStorage<Origin>()

export async function withAutomationOrigin<T>(origin: Pick<Origin, 'ruleId' | 'runId' | 'taskType' | 'assertAllowed'>, execute: () => Promise<T>): Promise<T> {
  const context: Origin = { ...origin, active: true, attached: false }
  try { return await origins.run(context, execute) }
  finally { context.active = false }
}

/** Reserved task provenance cannot be supplied in a renderer payload. */
export function taskPayloadWithAutomationOrigin(taskType: string, payload: Record<string, unknown>): Record<string, unknown> {
  const result = { ...payload }
  delete result._automation
  const origin = origins.getStore()
  if (origin && origin.taskType === taskType) {
    if (!origin.active) throw new Error('RULE_DISABLED')
    origin.assertAllowed?.()
  }
  if (origin?.active && !origin.attached && origin.taskType === taskType) {
    result._automation = { ruleId: origin.ruleId, runId: origin.runId }
    origin.attached = true
  }
  return result
}
