import { app } from 'electron'
import { getSupportedDatabaseMigrations } from './db'
import { AppSnapshotService, processPendingAppSnapshotOperation, type AppSnapshotOptions } from './app-snapshot-service'

let service: AppSnapshotService | undefined
export function appSnapshotOptions(): AppSnapshotOptions {
  return {
    profilePath: app.getPath('userData'), appVersion: app.getVersion(),
    supportedMigrationIds: getSupportedDatabaseMigrations(),
    supportedSchemaVersions: { catalog_schema: 1, transfer_plan_schema: 1, file_backup_schema: 1, subscription_schema: 1 },
  }
}
export function getAppSnapshotService(): AppSnapshotService { return service ??= new AppSnapshotService(appSnapshotOptions()) }
/** Must run with the single-instance lock, before opening the live database. */
export async function processPendingAppSnapshots(): Promise<void> {
  const { profilePath, ...compatibility } = appSnapshotOptions()
  await processPendingAppSnapshotOperation(profilePath, compatibility)
}
