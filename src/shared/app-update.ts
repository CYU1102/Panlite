export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'
export interface AppUpdateState {
  phase: UpdatePhase
  revision: number
  version?: string
  percent?: number
  message?: string
}
export interface AppUpdateResult {
  success: boolean
  state: AppUpdateState
  error?: string
}

export function updatesEnabled(packaged: boolean, platform: string, policy: unknown): boolean {
  if (!packaged || platform !== 'win32' || !policy || typeof policy !== 'object') return false
  const value = policy as Record<string, unknown>
  return value.enabled === true && value.provider === 'github' && value.owner === 'CYU1102'
    && value.repo === 'Panlite' && typeof value.publisher === 'string' && value.publisher.trim().length > 0
}

export function validUpdateFeed(feed: unknown, publisher: string): boolean {
  if (!feed || typeof feed !== 'object') return false
  const value = feed as Record<string, unknown>
  const names = Array.isArray(value.publisherName) ? value.publisherName : [value.publisherName]
  return value.provider === 'github' && value.owner === 'CYU1102' && value.repo === 'Panlite'
    && names.length === 1 && names[0] === publisher
}
