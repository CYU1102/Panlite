import type { AddAccountParams, DriveAccount, UploadFileInfo, UploadParams, DownloadFileInfo, DownloadParams, ArchiveMeta, ArchiveExtractOptions } from '@shared/types'

import type { CloudTransferParams } from '@shared/types'
import type { MembershipInfo } from '@shared/membership'
import type { AiAskInput, AiAskResult, AiAskStreamEvent, AiConversation, AiConversationCreateInput, AiConversationMessage, AiConversationSearchHit, AiDocument, AiImportFileInput, AiLocalToolStatus, AiLocalToolsConfig, AiProviderConfig, AiProviderSaveInput, AiProviderUsage, AiTask } from '@shared/ai-types'

export interface LoginResult {
  success: boolean
  cookies?: string
  userAgent?: string
  nickname?: string
  error?: string
}

export interface BaiduLoginResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  nickname?: string
  error?: string
}

export interface AccountListResult {
  success: boolean
  accounts: Omit<DriveAccount, 'credential'>[]
  error?: string
}

export interface AccountAddResult {
  success: boolean
  accountId?: string
  error?: string
}

export interface AccountCheckResult {
  success: boolean
  status?: string
  error?: string
}

export interface FileListResult {
  success: boolean
  files: any[]
  parentId: string
  hasMore: boolean
  cached?: boolean
  cacheTime?: number | null
  offlineReason?: string
  error?: string
}

export interface SearchResult {
  success: boolean
  files: any[]
  keyword: string
  hasMore: boolean
  fromCache?: boolean
  error?: string
}

export interface SimpleResult {
  success: boolean
  error?: string
  [key: string]: any
}

export interface XunleiLoginResult {
  success: boolean
  refreshToken?: string
  accessToken?: string
  userId?: string
  nickname?: string
  error?: string
}

declare global {
  interface Window {
    electronAPI: {
      openQuarkLogin: () => Promise<LoginResult>
      getBaiduAuthUrl: () => Promise<SimpleResult>
      loginBaidu: (code: string) => Promise<BaiduLoginResult>
      loginBaiduCookie: () => Promise<LoginResult>
      loginUc: () => Promise<LoginResult>
      loginXunlei: (refreshToken: string) => Promise<SimpleResult & { refreshToken?: string; nickname?: string }>
      openXunleiLogin: () => Promise<XunleiLoginResult>
      addAccount: (params: AddAccountParams) => Promise<AccountAddResult>
      listAccounts: () => Promise<AccountListResult>
      deleteAccount: (id: string) => Promise<SimpleResult>
      checkAccount: (id: string) => Promise<AccountCheckResult>
      getAccountMembership: (id: string) => Promise<SimpleResult & { membership?: MembershipInfo }>
      getAccountQuota: () => Promise<SimpleResult & { quotas?: Array<{ accountId: string; platform: string; nickname: string; quota: { used: number; total: number } | null; error?: string }> }>
      listFiles: (accountId: string, parentId: string, useCache?: boolean) => Promise<FileListResult>
      searchFiles: (accountId: string, keyword: string, options?: {
        maxSize?: number
        minSize?: number
        fileTypes?: string[]
        dateFrom?: number
        dateTo?: number
        useCache?: boolean
      }) => Promise<SearchResult>
      getSearchHistory: (accountId: string) => Promise<SimpleResult & { history?: Array<{ keyword: string; result_count: number; created_at: number }> }>
      clearSearchHistory: (accountId: string) => Promise<SimpleResult>
      mkdir: (accountId: string, parentId: string, name: string) => Promise<SimpleResult>
      renameFile: (accountId: string, fileId: string, newName: string) => Promise<SimpleResult>
      moveFiles: (accountId: string, fileIds: string[], targetDirId: string) => Promise<SimpleResult>
      deleteFiles: (accountId: string, fileIds: string[]) => Promise<SimpleResult>
      copyFiles: (accountId: string, fileIds: string[], targetDirId: string) => Promise<SimpleResult>
      getFileLink: (accountId: string, fileId: string) => Promise<SimpleResult & { url?: string }>
      prepareFilePreview: (accountId: string, fileId: string, fileName: string, fileSize?: number) => Promise<SimpleResult>
      cleanupFilePreview: (sessionId: string) => Promise<SimpleResult>
      globalSearch: (input: unknown) => Promise<SimpleResult>
      getGlobalSearchHistory: () => Promise<SimpleResult>
      listSavedSearches: () => Promise<SimpleResult>
      saveSearch: (input: unknown) => Promise<SimpleResult>
      deleteSavedSearch: (id: string) => Promise<SimpleResult>
      batchRename: (accountId: string, items: { fileId: string; path?: string; newName: string }[]) => Promise<SimpleResult>
      batchMove: (accountId: string, items: { fileId: string; path?: string }[], targetDirId: string, targetPath?: string) => Promise<SimpleResult>
      batchDelete: (accountId: string, items: { fileId: string; path?: string }[]) => Promise<SimpleResult>
      cloudTransfer: (params: CloudTransferParams) => Promise<SimpleResult & { taskId?: string }>
      batchShare: (accountId: string, items: { fileId: string; name?: string; isDir?: boolean; raw?: Record<string, unknown> }[], options?: { expireDays?: number; password?: string; title?: string }) => Promise<SimpleResult>
      shareList: (filters?: { accountId?: string; platform?: string; status?: string; keyword?: string }) => Promise<SimpleResult & { links?: unknown[] }>
      shareDelete: (id: string) => Promise<SimpleResult>
      shareExportCsv: (filters?: { accountId?: string; platform?: string; status?: string }) => Promise<SimpleResult & { csv?: string }>
      batchTransfer: (accountId: string, links: { url: string; password?: string }[], targetDirId?: string, targetPath?: string, options?: { autoShare?: boolean; shareOptions?: { expireDays?: number; password?: string } }) => Promise<SimpleResult>
      transferList: (filters?: { accountId?: string; platform?: string; status?: string; keyword?: string }) => Promise<SimpleResult & { records?: unknown[] }>
      transferDelete: (id: string) => Promise<SimpleResult>
      transferExportCsv: (filters?: { accountId?: string; platform?: string; status?: string }) => Promise<SimpleResult & { csv?: string }>
      selectDownloadDir: () => Promise<SimpleResult & { dirPath?: string }>
      downloadFiles: (params: DownloadParams) => Promise<SimpleResult>
      getPathForFile: (file: File) => string
      selectUploadFiles: () => Promise<SimpleResult & { files?: UploadFileInfo[] }>
      selectUploadFolder: () => Promise<SimpleResult & { files?: UploadFileInfo[]; folderName?: string }>
      handleDragUpload: (filePaths: string[]) => Promise<SimpleResult & { files?: UploadFileInfo[] }>
      uploadFiles: (params: UploadParams) => Promise<SimpleResult & { taskId?: string }>
      archiveList: (accountId: string, fileId: string, fileName: string, password?: string) => Promise<SimpleResult & { meta?: ArchiveMeta }>
      archiveExtract: (accountId: string, fileId: string, fileName: string, options: ArchiveExtractOptions) => Promise<SimpleResult & { taskId?: string }>
      archiveCompress: (accountId: string, fileIds: string[], options: { format?: 'zip' | 'tar'; targetDir: string; archiveName: string }) => Promise<SimpleResult & { taskId?: string }>
      aggregateSearch: (keyword: string) => Promise<SimpleResult & { results?: Array<{ title: string; url: string; password?: string; platform: string; source: string }> }>
      linkVerify: (accountId: string, links: { url: string; password?: string }[]) => Promise<SimpleResult & { results?: Array<{ url: string; valid: boolean; title?: string; fileCount?: number; error?: string }> }>
      searchSourcesList: () => Promise<SimpleResult & { sources?: unknown[] }>
      searchSourcesSave: (source: unknown) => Promise<SimpleResult>
      searchSourcesDelete: (id: string) => Promise<SimpleResult>
      searchExecute: (keyword: string, platform?: string) => Promise<SimpleResult & { results?: Array<{ title: string; url: string; password?: string; platform: string; sourceName: string }> }>
      testSearchSource: (source: Record<string, unknown>) => Promise<SimpleResult & { resultCount?: number; results?: unknown[] }>
      searchStreamStart: (keyword: string, platform?: string, options?: { verifyLinks?: boolean }) => Promise<SimpleResult>
      searchStreamStop: () => Promise<SimpleResult>
      onSearchStreamEvent: (callback: (event: { event: string; data: any }) => void) => () => void
      linkVerifySingle: (url: string) => Promise<SimpleResult & { valid?: boolean; title?: string; fileCount?: number; error?: string }>
      linkVerifyBatch: (urls: string[]) => Promise<SimpleResult & { results?: Array<{ url: string; valid: boolean; title?: string; error?: string }> }>
      tgChannelsList: () => Promise<SimpleResult & { channels?: unknown[] }>
      tgChannelsSave: (channel: unknown) => Promise<SimpleResult>
      tgChannelsDelete: (id: string) => Promise<SimpleResult>
      crawlerSourcesList: () => Promise<SimpleResult & { sources?: unknown[] }>
      crawlerSourcesSave: (source: unknown) => Promise<SimpleResult>
      crawlerSourcesDelete: (id: string) => Promise<SimpleResult>
      kkSourcesList: () => Promise<SimpleResult & { sources?: unknown[] }>
      kkSourcesSave: (source: unknown) => Promise<SimpleResult>
      kkSourcesDelete: (id: string) => Promise<SimpleResult>
      urlEncrypt: (url: string) => Promise<SimpleResult & { encrypted?: string }>
      urlDecrypt: (encryptedUrl: string) => Promise<SimpleResult & { decrypted?: string }>
      listTasks: () => Promise<SimpleResult>
      retryTask: (taskId: string) => Promise<SimpleResult>
      cancelTask: (taskId: string) => Promise<SimpleResult>
      pauseTask: (taskId: string) => Promise<SimpleResult>
      resumeTask: (taskId: string) => Promise<SimpleResult>
      deleteTask: (taskId: string) => Promise<SimpleResult>
      getTaskLogs: (taskId: string) => Promise<SimpleResult>
      onTaskUpdated: (callback: (task: unknown) => void) => () => void
      exportCsv: (accountId: string, parentId: string) => Promise<SimpleResult>
      showSaveDialog: (options: unknown) => Promise<{ canceled: boolean; filePath?: string }>
      showOpenDialog: (options: unknown) => Promise<{ canceled: boolean; filePaths?: string[] }>
      createBackup: (filePath: string, options?: unknown) => Promise<SimpleResult>
      inspectBackup: (filePath: string) => Promise<SimpleResult>
      restoreBackup: (filePath: string, options?: unknown) => Promise<SimpleResult>
      exportConfigBackup: () => Promise<SimpleResult & { backup?: string }>
      previewConfigBackup: (input: string, options?: unknown) => Promise<SimpleResult>
      importConfigBackup: (input: string, options?: unknown) => Promise<SimpleResult>
      getAppLockStatus: () => Promise<SimpleResult>
      configureAppLock: (input: unknown) => Promise<SimpleResult>
      unlockApp: (password: string) => Promise<SimpleResult>
      lockApp: () => Promise<SimpleResult>
      touchAppLock: () => Promise<SimpleResult>
      onAppLockChanged: (callback: (state: unknown) => void) => () => void
      onAppNavigate: (callback: (path: string) => void) => () => void
      openExternal: (url: string) => Promise<SimpleResult>
      aiSelectFiles: () => Promise<SimpleResult & { files?: Array<{ localPath: string; fileName: string; fileSize: number }> }>
      aiImportFiles: (inputs: AiImportFileInput[]) => Promise<SimpleResult & { documents?: AiDocument[]; taskIds?: string[] }>
      aiDocumentList: () => Promise<SimpleResult & { documents?: AiDocument[] }>
      aiDocumentDelete: (id: string) => Promise<SimpleResult>
      aiDocumentReindex: (id: string) => Promise<SimpleResult & { document?: AiDocument; taskId?: string }>
      aiTaskList: () => Promise<SimpleResult & { tasks?: AiTask[] }>
      aiProviderGet: () => Promise<SimpleResult & { config?: AiProviderConfig }>
      aiProviderSave: (input: AiProviderSaveInput) => Promise<SimpleResult & { config?: AiProviderConfig }>
      aiProviderTest: () => Promise<SimpleResult & { message?: string }>
      aiProviderList: () => Promise<SimpleResult & { profiles?: AiProviderConfig[]; active?: AiProviderConfig }>
      aiProviderActivate: (id: string) => Promise<SimpleResult & { config?: AiProviderConfig }>
      aiProviderDelete: (id: string) => Promise<SimpleResult>
      aiProviderUsage: () => Promise<SimpleResult & { usage?: AiProviderUsage[] }>
      aiLocalToolsGet: () => Promise<SimpleResult & { config?: AiLocalToolsConfig; tools?: AiLocalToolStatus[] }>
      aiLocalToolsSave: (input: Partial<AiLocalToolsConfig>) => Promise<SimpleResult & { config?: AiLocalToolsConfig; tools?: AiLocalToolStatus[] }>
      aiLocalToolsSelect: (key: string) => Promise<SimpleResult & { filePath?: string }>
      aiAsk: (input: AiAskInput) => Promise<AiAskResult>
      aiAskStreamStart: (input: AiAskInput) => Promise<SimpleResult & { requestId?: string }>
      aiAskStreamCancel: (requestId: string) => Promise<SimpleResult>
      onAiAskStreamEvent: (callback: (event: AiAskStreamEvent) => void) => () => void
      aiConversationList: () => Promise<SimpleResult & { conversations?: AiConversation[] }>
      aiConversationCreate: (input: AiConversationCreateInput) => Promise<SimpleResult & { conversation?: AiConversation }>
      aiConversationRename: (id: string, title: string) => Promise<SimpleResult & { conversation?: AiConversation }>
      aiConversationDelete: (id: string) => Promise<SimpleResult>
      aiConversationSetDocuments: (id: string, documentIds: string[]) => Promise<SimpleResult & { conversation?: AiConversation }>
      aiConversationMessages: (id: string) => Promise<SimpleResult & { messages?: AiConversationMessage[] }>
      aiConversationSearch: (query: string) => Promise<SimpleResult & { hits?: AiConversationSearchHit[] }>
      aiConversationExport: (id: string) => Promise<SimpleResult & { canceled?: boolean; filePath?: string }>
      aiConversationTruncate: (conversationId: string, messageId: string) => Promise<SimpleResult>
      aiKnowledgeExport: () => Promise<SimpleResult & { canceled?: boolean; filePath?: string }>
      onAiTaskUpdated: (callback: (task: AiTask) => void) => () => void
      getSetting: (key: string) => Promise<SimpleResult & { value?: string | null }>
      setSetting: (key: string, value: string) => Promise<SimpleResult>
      getAllSettings: () => Promise<SimpleResult & { settings?: Record<string, string> }>
    }
  }
}

export const electronApi = window.electronAPI
