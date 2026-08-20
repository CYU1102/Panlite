export type XunleiTaskState = 'complete' | 'failed' | 'pending' | 'unknown'

export interface XunleiTaskStatus {
  state: XunleiTaskState
  phase: string
  message?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

export function extractXunleiSharePassword(url: string, explicitPassword?: string): string {
  if (explicitPassword?.trim()) return explicitPassword.trim()
  try {
    return new URL(url).searchParams.get('pwd')?.trim() || ''
  } catch {
    return url.match(/[?&]pwd=([a-zA-Z0-9]+)/i)?.[1] || ''
  }
}

export function buildXunleiSharePageUrl(shareId: string, sourceUrl: string, explicitPassword?: string): string {
  const url = new URL(`https://pan.xunlei.com/s/${encodeURIComponent(shareId)}`)
  const password = extractXunleiSharePassword(sourceUrl, explicitPassword)
  if (password) url.searchParams.set('pwd', password)
  return url.toString()
}

export function getXunleiRestoreTaskId(payload: unknown): string {
  const root = asRecord(payload)
  const data = asRecord(root?.data)
  return firstString(
    root?.restore_task_id,
    root?.task_id,
    root?.id,
    data?.restore_task_id,
    data?.task_id,
    data?.id,
  )
}

export function isXunleiRestoreComplete(payload: unknown): boolean {
  const root = asRecord(payload)
  const data = asRecord(root?.data)
  const status = firstString(root?.restore_status, root?.status, data?.restore_status, data?.status).toUpperCase()
  const fileId = firstString(root?.file_id, data?.file_id)
  return [
    'RESTORE_SUCCESS',
    'RESTORE_COMPLETE',
    'PHASE_TYPE_COMPLETE',
    'COMPLETE',
    'COMPLETED',
    'SUCCESS',
    'SUCCEEDED',
  ].includes(status) || (!!fileId && status !== 'RESTORE_START')
}

export function classifyXunleiTask(payload: unknown): XunleiTaskStatus {
  const root = asRecord(payload)
  const task = asRecord(root?.task)
  const data = asRecord(root?.data)
  const phase = firstString(
    root?.phase,
    root?.status,
    task?.phase,
    task?.status,
    data?.phase,
    data?.status,
  ).toUpperCase()
  const message = firstString(
    root?.message,
    root?.error_description,
    task?.message,
    data?.message,
    data?.error_description,
  ) || undefined

  if ([
    'PHASE_TYPE_COMPLETE',
    'COMPLETE',
    'COMPLETED',
    'SUCCESS',
    'SUCCEEDED',
  ].includes(phase)) {
    return { state: 'complete', phase, message }
  }
  if ([
    'PHASE_TYPE_FAILED',
    'PHASE_TYPE_ERROR',
    'FAILED',
    'FAILURE',
    'ERROR',
    'CANCELLED',
    'CANCELED',
  ].includes(phase)) {
    return { state: 'failed', phase, message }
  }
  if ([
    'PHASE_TYPE_PENDING',
    'PHASE_TYPE_RUNNING',
    'PENDING',
    'RUNNING',
    'PROCESSING',
    'START',
    'STARTED',
    'RESTORE_START',
  ].includes(phase)) {
    return { state: 'pending', phase, message }
  }
  return { state: 'unknown', phase, message }
}
