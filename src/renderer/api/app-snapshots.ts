import type { AppSnapshotsApi } from '@shared/app-snapshots'
import { plainIpcData } from './plain-ipc-data'

declare global { interface Window { appSnapshotsAPI: AppSnapshotsApi } }

export const appSnapshotsApi: AppSnapshotsApi = {
  listSnapshots: () => window.appSnapshotsAPI.listSnapshots(),
  requestSnapshot: input => window.appSnapshotsAPI.requestSnapshot(plainIpcData(input)),
  inspectSnapshot: input => window.appSnapshotsAPI.inspectSnapshot(plainIpcData(input)),
  requestRestore: input => window.appSnapshotsAPI.requestRestore(plainIpcData(input)),
  getPendingOperation: () => window.appSnapshotsAPI.getPendingOperation(),
  cancelPendingOperation: () => window.appSnapshotsAPI.cancelPendingOperation(),
}
