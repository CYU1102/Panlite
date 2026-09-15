export interface AppSnapshotEntry { path: string; size: number; sha256: string }
export interface AppSnapshotInfo {
  id: string; name: string; createdAt: number; appVersion: string; formatVersion: 1
  state: 'ready' | 'invalid'; fileCount: number; totalBytes: number
  /** DPAPI-protected bytes stay protected; this is a same-profile, same-machine feature. */
  sameMachineOnly: true
  managedRoots: string[]
  externalAiSources: number
  error?: string
}
export interface AppSnapshotInspection { snapshot: AppSnapshotInfo; files: AppSnapshotEntry[]; migrationIds: string[]; schemaVersions: Record<string, number>; verified: boolean }
export interface PendingAppSnapshotOperation {
  id: string; kind: 'snapshot' | 'restore'; status: 'requested' | 'running' | 'failed'
  snapshotId: string; name?: string; requestedAt: number; error?: string
  /** Derived from the active restore journal; never used as cancellation authority. */
  canCancel?: boolean
}
export type AppSnapshotResult<T extends object = Record<never, never>> = ({ success: true } & T) | { success: false; error: string; code?: string }
export interface AppSnapshotsApi {
  listSnapshots(): Promise<AppSnapshotResult<{ snapshots: AppSnapshotInfo[] }>>
  requestSnapshot(name: string): Promise<AppSnapshotResult<{ pending: PendingAppSnapshotOperation; restartRequired: true }>>
  inspectSnapshot(id: string): Promise<AppSnapshotResult<AppSnapshotInspection>>
  requestRestore(id: string): Promise<AppSnapshotResult<{ pending: PendingAppSnapshotOperation; restartRequired: true }>>
  getPendingOperation(): Promise<AppSnapshotResult<{ pending: PendingAppSnapshotOperation | null }>>
  /** Only requests that have not begun modifying the profile can be cancelled. */
  cancelPendingOperation(): Promise<AppSnapshotResult>
}
export const APP_SNAPSHOT_CHANNELS = {
  listSnapshots: 'app-snapshots:list', requestSnapshot: 'app-snapshots:request-create', inspectSnapshot: 'app-snapshots:inspect',
  requestRestore: 'app-snapshots:request-restore', getPendingOperation: 'app-snapshots:pending', cancelPendingOperation: 'app-snapshots:cancel-pending',
} as const satisfies Record<keyof AppSnapshotsApi, string>
