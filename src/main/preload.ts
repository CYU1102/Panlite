import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import { webUtils } from 'electron'

const electronAPI = {
  // ---- System ----
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // ---- Independent AI workspace ----
  aiSelectFiles: () => ipcRenderer.invoke(IPC_CHANNELS.AI_SELECT_FILES),
  aiImportFiles: (inputs: Array<{ localPath: string; fileName?: string }>) =>
    ipcRenderer.invoke(IPC_CHANNELS.AI_IMPORT_FILES, inputs),
  aiDocumentList: () => ipcRenderer.invoke(IPC_CHANNELS.AI_DOCUMENT_LIST),
  aiDocumentDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_DOCUMENT_DELETE, id),
  aiDocumentReindex: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_DOCUMENT_REINDEX, id),
  aiTaskList: () => ipcRenderer.invoke(IPC_CHANNELS.AI_TASK_LIST),
  aiProviderGet: () => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_GET),
  aiProviderSave: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_SAVE, input),
  aiProviderTest: () => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_TEST),
  aiProviderList: () => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_LIST),
  aiProviderActivate: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_ACTIVATE, id),
  aiProviderDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_DELETE, id),
  aiProviderUsage: () => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_USAGE),
  aiLocalToolsGet: () => ipcRenderer.invoke(IPC_CHANNELS.AI_LOCAL_TOOLS_GET),
  aiLocalToolsSave: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AI_LOCAL_TOOLS_SAVE, input),
  aiLocalToolsSelect: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_LOCAL_TOOLS_SELECT, key),
  aiAsk: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AI_ASK, input),
  aiAskStreamStart: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AI_ASK_STREAM_START, input),
  aiAskStreamCancel: (requestId: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_ASK_STREAM_CANCEL, requestId),
  onAiAskStreamEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.AI_ASK_STREAM_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AI_ASK_STREAM_EVENT, handler)
  },
  aiConversationList: () => ipcRenderer.invoke(IPC_CHANNELS.AI_CONVERSATION_LIST),
  aiConversationCreate: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AI_CONVERSATION_CREATE, input),
  aiConversationRename: (id: string, title: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_CONVERSATION_RENAME, id, title),
  aiConversationDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_CONVERSATION_DELETE, id),
  aiConversationSetDocuments: (id: string, documentIds: string[]) => ipcRenderer.invoke(IPC_CHANNELS.AI_CONVERSATION_SET_DOCUMENTS, id, documentIds),
  aiConversationMessages: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_CONVERSATION_MESSAGES, id),
  aiConversationSearch: (query: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_CONVERSATION_SEARCH, query),
  aiConversationExport: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_CONVERSATION_EXPORT, id),
  aiConversationTruncate: (conversationId: string, messageId: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_CONVERSATION_TRUNCATE, conversationId, messageId),
  aiKnowledgeExport: () => ipcRenderer.invoke(IPC_CHANNELS.AI_KNOWLEDGE_EXPORT),
  onAiTaskUpdated: (callback: (task: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(args[0])
    ipcRenderer.on(IPC_CHANNELS.AI_TASK_UPDATED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AI_TASK_UPDATED, handler)
  },

  // ---- Login ----
  openQuarkLogin: () => ipcRenderer.invoke(IPC_CHANNELS.LOGIN_QUARK),
  getBaiduAuthUrl: () => ipcRenderer.invoke(IPC_CHANNELS.BAIDU_GET_AUTH_URL),
  loginBaidu: (code: string) => ipcRenderer.invoke(IPC_CHANNELS.LOGIN_BAIDU, code),
  loginBaiduCookie: () => ipcRenderer.invoke(IPC_CHANNELS.LOGIN_BAIDU_COOKIE),
  loginUc: () => ipcRenderer.invoke(IPC_CHANNELS.LOGIN_UC),
  loginXunlei: (refreshToken: string) => ipcRenderer.invoke(IPC_CHANNELS.LOGIN_XUNLEI, refreshToken),
  openXunleiLogin: () => ipcRenderer.invoke(IPC_CHANNELS.LOGIN_XUNLEI_AUTO),

  // ---- Account ----
  addAccount: (params: unknown) => ipcRenderer.invoke(IPC_CHANNELS.ACCOUNT_ADD, params),
  listAccounts: () => ipcRenderer.invoke(IPC_CHANNELS.ACCOUNT_LIST),
  deleteAccount: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ACCOUNT_DELETE, id),
  checkAccount: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ACCOUNT_CHECK, id),
  getAccountQuota: () => ipcRenderer.invoke(IPC_CHANNELS.ACCOUNT_QUOTA),
  getAccountMembership: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ACCOUNT_MEMBERSHIP, id),

  // ---- File ----
  listFiles: (accountId: string, parentId: string, useCache?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST, accountId, parentId, useCache),
  searchFiles: (accountId: string, keyword: string, options?: {
    maxSize?: number
    minSize?: number
    fileTypes?: string[]
    dateFrom?: number
    dateTo?: number
    useCache?: boolean
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_SEARCH, accountId, keyword, options),
  getSearchHistory: (accountId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_HISTORY, accountId),
  clearSearchHistory: (accountId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_CLEAR_HISTORY, accountId),
  mkdir: (accountId: string, parentId: string, name: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_MKDIR, accountId, parentId, name),
  renameFile: (accountId: string, fileId: string, newName: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_RENAME, accountId, fileId, newName),
  moveFiles: (accountId: string, fileIds: string[], targetDirId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_MOVE, accountId, fileIds, targetDirId),
  deleteFiles: (accountId: string, fileIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_DELETE, accountId, fileIds),
  copyFiles: (accountId: string, fileIds: string[], targetDirId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_COPY, accountId, fileIds, targetDirId),
  getFileLink: (accountId: string, fileId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_GET_LINK, accountId, fileId),
  prepareFilePreview: (accountId: string, fileId: string, fileName: string, fileSize?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_PREVIEW_PREPARE, { accountId, fileId, fileName, fileSize }),
  cleanupFilePreview: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_PREVIEW_CLEANUP, sessionId),
  globalSearch: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.GLOBAL_SEARCH, input),
  getGlobalSearchHistory: () => ipcRenderer.invoke(IPC_CHANNELS.GLOBAL_SEARCH_HISTORY),
  listSavedSearches: () => ipcRenderer.invoke(IPC_CHANNELS.SAVED_SEARCH_LIST),
  saveSearch: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SAVED_SEARCH_SAVE, input),
  deleteSavedSearch: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SAVED_SEARCH_DELETE, id),

  // ---- Batch operations (task-based) ----
  batchRename: (accountId: string, items: { fileId: string; path?: string; newName: string }[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.BATCH_RENAME, accountId, items),
  batchMove: (accountId: string, items: { fileId: string; path?: string }[], targetDirId: string, targetPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.BATCH_MOVE, accountId, items, targetDirId, targetPath),
  batchDelete: (accountId: string, items: { fileId: string; path?: string }[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.BATCH_DELETE, accountId, items),
  cloudTransfer: (params: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLOUD_TRANSFER_CREATE, params),

  // ---- Share ----
  batchShare: (accountId: string, items: { fileId: string; name?: string; isDir?: boolean; raw?: Record<string, unknown> }[], options?: { expireDays?: number; password?: string; title?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHARE_BATCH_CREATE, accountId, items, options),
  shareList: (filters?: { accountId?: string; platform?: string; status?: string; keyword?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHARE_LIST, filters),
  shareDelete: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHARE_DELETE, id),
  shareExportCsv: (filters?: { accountId?: string; platform?: string; status?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHARE_EXPORT_CSV, filters),

  // ---- Transfer ----
  batchTransfer: (accountId: string, links: { url: string; password?: string }[], targetDirId?: string, targetPath?: string, options?: { autoShare?: boolean; shareOptions?: { expireDays?: number; password?: string } }) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSFER_BATCH_CREATE, accountId, links, targetDirId, targetPath, options),
  transferList: (filters?: { accountId?: string; platform?: string; status?: string; keyword?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSFER_LIST, filters),
  transferDelete: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSFER_DELETE, id),
  transferExportCsv: (filters?: { accountId?: string; platform?: string; status?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSFER_EXPORT_CSV, filters),

  // ---- Download ----
  selectDownloadDir: () => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_SELECT_DIR),
  downloadFiles: (params: { accountId: string; files: Array<{ fileId: string; fileName: string; fileSize: number; isDir: boolean }>; targetDirPath: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_FILES, params),

  // ---- Upload ----
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  selectUploadFiles: () => ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_SELECT_FILES),
  selectUploadFolder: () => ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_SELECT_FOLDER),
  handleDragUpload: (filePaths: string[]) => ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_HANDLE_DROP, filePaths),
  uploadFiles: (params: { accountId: string; files: Array<{ localPath: string; fileName: string; fileSize: number }>; targetDirId: string; overwrite?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_FILES, params),

  // ---- Archive ----
  archiveList: (accountId: string, fileId: string, fileName: string, password?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ARCHIVE_LIST, accountId, fileId, fileName, password),
  archiveExtract: (accountId: string, fileId: string, fileName: string, options: { password?: string; targetDir: string; files?: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.ARCHIVE_EXTRACT, accountId, fileId, fileName, options),
  archiveCompress: (accountId: string, fileIds: string[], options: { format?: string; targetDir: string; archiveName: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.ARCHIVE_COMPRESS, accountId, fileIds, options),

  // ---- Aggregate Search ----
  aggregateSearch: (keyword: string) => ipcRenderer.invoke('search:aggregate', keyword),

  // ---- Link verification ----
  linkVerify: (accountId: string, links: { url: string; password?: string }[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.LINK_VERIFY, accountId, links),

  // ---- Task ----
  listTasks: () => ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST),
  retryTask: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_RETRY, taskId),
  cancelTask: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CANCEL, taskId),
  pauseTask: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_PAUSE, taskId),
  resumeTask: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_RESUME, taskId),
  deleteTask: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_DELETE, taskId),
  getTaskLogs: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_LOGS, taskId),
  onTaskUpdated: (callback: (task: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(args[0])
    ipcRenderer.on(IPC_CHANNELS.TASK_UPDATED, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TASK_UPDATED, handler)
    }
  },

  // ---- Resource Search ----
  searchSourcesList: () => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_SOURCES_LIST),
  searchSourcesSave: (source: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_SOURCES_SAVE, source),
  searchSourcesDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_SOURCES_DELETE, id),
  searchExecute: (keyword: string, platform?: string) => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_EXECUTE, keyword, platform),
  testSearchSource: (source: Record<string, unknown>) => ipcRenderer.invoke('search:test-source', source),

  // ---- Stream Search (SSE-like) ----
  searchStreamStart: (keyword: string, platform?: string, options?: { verifyLinks?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_STREAM_START, keyword, platform, options),
  searchStreamStop: () => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_STREAM_STOP),
  onSearchStreamEvent: (callback: (event: { event: string; data: any }) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SEARCH_STREAM_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SEARCH_STREAM_EVENT, handler)
  },

  // ---- Link Verification ----
  linkVerifySingle: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.LINK_VERIFY_SINGLE, url),
  linkVerifyBatch: (urls: string[]) => ipcRenderer.invoke(IPC_CHANNELS.LINK_VERIFY_BATCH, urls),

  // ---- TG Channels ----
  tgChannelsList: () => ipcRenderer.invoke(IPC_CHANNELS.TG_CHANNELS_LIST),
  tgChannelsSave: (channel: unknown) => ipcRenderer.invoke(IPC_CHANNELS.TG_CHANNELS_SAVE, channel),
  tgChannelsDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TG_CHANNELS_DELETE, id),

  // ---- Crawler Sources ----
  crawlerSourcesList: () => ipcRenderer.invoke(IPC_CHANNELS.CRAWLER_SOURCES_LIST),
  crawlerSourcesSave: (source: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CRAWLER_SOURCES_SAVE, source),
  crawlerSourcesDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CRAWLER_SOURCES_DELETE, id),

  // ---- KK Sources ----
  kkSourcesList: () => ipcRenderer.invoke(IPC_CHANNELS.KK_SOURCES_LIST),
  kkSourcesSave: (source: unknown) => ipcRenderer.invoke(IPC_CHANNELS.KK_SOURCES_SAVE, source),
  kkSourcesDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KK_SOURCES_DELETE, id),

  // ---- URL Crypto ----
  urlEncrypt: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.URL_ENCRYPT, url),
  urlDecrypt: (encryptedUrl: string) => ipcRenderer.invoke(IPC_CHANNELS.URL_DECRYPT, encryptedUrl),

  // ---- Export ----
  exportCsv: (accountId: string, parentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_CSV, accountId, parentId),

  // ---- System ----
  showSaveDialog: (options: unknown) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SAVE, options),
  showOpenDialog: (options: unknown) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN, options),

  // ---- Backup and security ----
  createBackup: (filePath: string, options?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.BACKUP_CREATE, filePath, options),
  inspectBackup: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.BACKUP_INSPECT, filePath),
  restoreBackup: (filePath: string, options?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.BACKUP_RESTORE, filePath, options),
  exportConfigBackup: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_BACKUP_EXPORT),
  previewConfigBackup: (input: string, options?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_BACKUP_PREVIEW, input, options),
  importConfigBackup: (input: string, options?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_BACKUP_IMPORT, input, options),
  getAppLockStatus: () => ipcRenderer.invoke(IPC_CHANNELS.APP_LOCK_STATUS),
  configureAppLock: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.APP_LOCK_CONFIGURE, input),
  unlockApp: (password: string) => ipcRenderer.invoke(IPC_CHANNELS.APP_LOCK_UNLOCK, password),
  lockApp: () => ipcRenderer.invoke(IPC_CHANNELS.APP_LOCK_NOW),
  touchAppLock: () => ipcRenderer.invoke(IPC_CHANNELS.APP_LOCK_TOUCH),
  appLockGetState: () => ipcRenderer.invoke(IPC_CHANNELS.APP_LOCK_STATUS),
  appLockConfigure: (password: string, autoLockMs: number) => ipcRenderer.invoke(IPC_CHANNELS.APP_LOCK_CONFIGURE, { password, autoLockMs }),
  appLockChangePassword: (currentPassword: string, newPassword: string) => ipcRenderer.invoke(IPC_CHANNELS.APP_LOCK_CHANGE_PASSWORD, { currentPassword, newPassword }),
  appLockDisable: (password: string) => ipcRenderer.invoke(IPC_CHANNELS.APP_LOCK_DISABLE, password),
  appLockSetAutoLock: (autoLockMs: number) => ipcRenderer.invoke(IPC_CHANNELS.APP_LOCK_SET_AUTO_LOCK, autoLockMs),
  appLockLock: () => ipcRenderer.invoke(IPC_CHANNELS.APP_LOCK_NOW),
  onAppLockChanged: (callback: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on(IPC_CHANNELS.APP_LOCK_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_LOCK_CHANGED, handler)
  },
  onAppNavigate: (callback: (path: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, path: string) => callback(path)
    ipcRenderer.on(IPC_CHANNELS.APP_NAVIGATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_NAVIGATE, handler)
  },

  // ---- Settings ----
  getSetting: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, key, value),
  getAllSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_ALL),
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
