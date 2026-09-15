import { FILE_BACKUP_CHANNELS, type FileBackupsApi } from './file-backup'

export function createFileBackupsClient(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): FileBackupsApi {
  return {
    listPlans: () => invoke(FILE_BACKUP_CHANNELS.listPlans) as ReturnType<FileBackupsApi['listPlans']>,
    savePlan: input => invoke(FILE_BACKUP_CHANNELS.savePlan, input) as ReturnType<FileBackupsApi['savePlan']>,
    removePlan: input => invoke(FILE_BACKUP_CHANNELS.removePlan, input) as ReturnType<FileBackupsApi['removePlan']>,
    previewBackup: input => invoke(FILE_BACKUP_CHANNELS.previewBackup, input) as ReturnType<FileBackupsApi['previewBackup']>,
    getBackupPreview: input => invoke(FILE_BACKUP_CHANNELS.getBackupPreview, input) as ReturnType<FileBackupsApi['getBackupPreview']>,
    executeBackup: input => invoke(FILE_BACKUP_CHANNELS.executeBackup, input) as ReturnType<FileBackupsApi['executeBackup']>,
    listSnapshots: input => invoke(FILE_BACKUP_CHANNELS.listSnapshots, input) as ReturnType<FileBackupsApi['listSnapshots']>,
    getSnapshot: input => invoke(FILE_BACKUP_CHANNELS.getSnapshot, input) as ReturnType<FileBackupsApi['getSnapshot']>,
    previewRestore: input => invoke(FILE_BACKUP_CHANNELS.previewRestore, input) as ReturnType<FileBackupsApi['previewRestore']>,
    getRestorePreview: input => invoke(FILE_BACKUP_CHANNELS.getRestorePreview, input) as ReturnType<FileBackupsApi['getRestorePreview']>,
    executeRestore: input => invoke(FILE_BACKUP_CHANNELS.executeRestore, input) as ReturnType<FileBackupsApi['executeRestore']>,
    retentionPreview: input => invoke(FILE_BACKUP_CHANNELS.retentionPreview, input) as ReturnType<FileBackupsApi['retentionPreview']>,
    getRetentionPreview: input => invoke(FILE_BACKUP_CHANNELS.getRetentionPreview, input) as ReturnType<FileBackupsApi['getRetentionPreview']>,
    prune: input => invoke(FILE_BACKUP_CHANNELS.prune, input) as ReturnType<FileBackupsApi['prune']>,
    listJobs: input => invoke(FILE_BACKUP_CHANNELS.listJobs, input) as ReturnType<FileBackupsApi['listJobs']>,
    getJob: input => invoke(FILE_BACKUP_CHANNELS.getJob, input) as ReturnType<FileBackupsApi['getJob']>,
  }
}
