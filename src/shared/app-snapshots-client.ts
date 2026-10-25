import { APP_SNAPSHOT_CHANNELS, type AppSnapshotsApi } from './app-snapshots'

export function createAppSnapshotsClient(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): AppSnapshotsApi {
  return {
    listSnapshots: () => invoke(APP_SNAPSHOT_CHANNELS.listSnapshots) as ReturnType<AppSnapshotsApi['listSnapshots']>,
    requestSnapshot: input => invoke(APP_SNAPSHOT_CHANNELS.requestSnapshot, input) as ReturnType<AppSnapshotsApi['requestSnapshot']>,
    inspectSnapshot: input => invoke(APP_SNAPSHOT_CHANNELS.inspectSnapshot, input) as ReturnType<AppSnapshotsApi['inspectSnapshot']>,
    requestRestore: input => invoke(APP_SNAPSHOT_CHANNELS.requestRestore, input) as ReturnType<AppSnapshotsApi['requestRestore']>,
    getPendingOperation: () => invoke(APP_SNAPSHOT_CHANNELS.getPendingOperation) as ReturnType<AppSnapshotsApi['getPendingOperation']>,
    cancelPendingOperation: () => invoke(APP_SNAPSHOT_CHANNELS.cancelPendingOperation) as ReturnType<AppSnapshotsApi['cancelPendingOperation']>,
  }
}
