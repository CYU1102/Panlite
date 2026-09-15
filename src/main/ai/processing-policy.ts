import { getSetting, setSetting } from '../db'
import { DEFAULT_AI_PROCESSING_POLICY, type AiProcessingPolicy } from '../../shared/ai-processing-policy'

const SETTINGS_KEY = 'aiProcessingPolicyV1'

/** Missing or corrupt settings must never silently enable automatic model requests. */
export function getAiProcessingPolicy(): AiProcessingPolicy {
  try {
    const raw = getSetting(SETTINGS_KEY)?.value
    const stored = raw ? JSON.parse(raw) : null
    return {
      allowModelFallback: stored?.allowModelFallback === true,
      useSemanticIndex: stored?.useSemanticIndex === true,
    }
  } catch {
    return { ...DEFAULT_AI_PROCESSING_POLICY }
  }
}

export function saveAiProcessingPolicy(input: unknown): AiProcessingPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('文件处理方式无效')
  const value = input as Record<string, unknown>
  if (typeof value.allowModelFallback !== 'boolean' || typeof value.useSemanticIndex !== 'boolean') {
    throw new Error('模型补充识别与语义索引开关必须为布尔值')
  }
  const policy: AiProcessingPolicy = { allowModelFallback: value.allowModelFallback, useSemanticIndex: value.useSemanticIndex }
  setSetting(SETTINGS_KEY, JSON.stringify(policy))
  return policy
}
