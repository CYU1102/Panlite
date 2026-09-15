/** Controls automatic model use during file ingestion and retrieval, not explicit chat requests. */
export interface AiProcessingPolicy {
  allowModelFallback: boolean
  useSemanticIndex: boolean
}

export const DEFAULT_AI_PROCESSING_POLICY: Readonly<AiProcessingPolicy> = Object.freeze({
  allowModelFallback: false,
  useSemanticIndex: false,
})

export interface AiProcessingPolicyResult {
  success: boolean
  policy?: AiProcessingPolicy
  error?: string
}
