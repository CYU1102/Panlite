export type Platform =
  | 'quark' | 'baidu' | 'uc' | 'xunlei'

export type AccountStatus = 'active' | 'expired' | 'error'

export type LoginType = 'cookie' | 'oauth' | 'token' | 'password' | 'sms' | 'authorization' | 'api_key'

export type TaskType = 'rename' | 'move' | 'delete' | 'mkdir' | 'share' | 'batch_share' | 'transfer' | 'batch_transfer' | 'upload' | 'download' | 'decompress'

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'paused'

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

export interface DriveCredential {
  cookies?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  userAgent?: string
  clientId?: string
  clientSecret?: string
  username?: string
  password?: string
  userId?: string
  raw?: Record<string, unknown>
}

export interface DriveAccount {
  id: string
  platform: Platform
  nickname: string
  loginType: LoginType
  credential: DriveCredential
  userAgent?: string
  status: AccountStatus
  createdAt: number
  updatedAt: number
  lastCheckAt?: number
}

export interface FileItem {
  id: string
  path?: string
  parentId: string
  name: string
  isDir: boolean
  size: number
  createdAt: number
  updatedAt: number
  platform: Platform
  accountId: string
  raw?: Record<string, unknown>
}

export interface Task {
  id: string
  accountId: string
  platform: Platform
  taskType: TaskType
  title: string
  payload: Record<string, unknown>
  status: TaskStatus
  progress: number
  retryCount: number
  errorMessage?: string
  createdAt: number
  updatedAt: number
  finishedAt?: number
}

export interface LogEntry {
  id: string
  level: LogLevel
  module?: string
  message: string
  detail?: string
  createdAt: number
}

export interface FileListResult {
  files: FileItem[]
  parentId: string
  hasMore: boolean
}

export interface SearchResult {
  files: FileItem[]
  keyword: string
  hasMore: boolean
}

export interface AddAccountParams {
  platform: Platform
  nickname: string
  loginType: LoginType
  credential: DriveCredential
  userAgent?: string
}

// ---- Share types ----

export interface ShareOptions {
  expireDays?: number
  password?: string
  title?: string
}

export interface ShareInfo {
  id: string
  platform: Platform
  accountId: string
  fileIds: string[]
  title?: string
  shareUrl: string
  password?: string
  expiredAt?: number
  createdAt: number
  raw?: unknown
}

export interface ShareTaskPayload {
  accountId: string
  platform: Platform
  items: Array<{ fileId: string; name?: string; path?: string; isDir?: boolean; raw?: Record<string, unknown> }>
  options: ShareOptions
}

export interface ShareDetail {
  platform: Platform
  shareId?: string
  title?: string
  files: Array<{ fileId: string; name: string; isDir: boolean; size?: number; raw?: unknown }>
  raw?: unknown
}

export interface ParsedShareLink {
  shareId: string
  password?: string
  raw?: unknown
}

// ---- Transfer types ----

export interface TransferLinkInput {
  url: string
  password?: string
}

export interface TransferTaskPayload {
  accountId: string
  platform: Platform
  links: TransferLinkInput[]
  targetDirId?: string
  targetPath?: string
  createFolder?: boolean
  /** 转存后自动分享 */
  autoShare?: boolean
  /** 自动分享选项 */
  shareOptions?: ShareOptions
}

export interface TransferResult {
  platform: Platform
  accountId: string
  sourceUrl: string
  success: boolean
  savedCount?: number
  targetDirId?: string
  targetPath?: string
  error?: string
  raw?: unknown
  /** 转存后的文件 ID 列表，用于后续自动分享（夸克: fid, 百度: fs_id） */
  savedFileIds?: string[]
  /** 转存后的文件名列表，用于广告过滤 */
  savedFileNames?: string[]
  /** 转存后的文件路径列表，用于广告过滤后的删除操作（百度专用） */
  savedFilePaths?: string[]
}

// ---- Resource Search types ----

export interface SearchSource {
  id: string
  name: string
  type: 'api' | 'html'
  platform: Platform
  url: string
  method?: string
  params?: Record<string, string>
  headers?: Record<string, string>
  fieldMap?: { listPath: string; fields: Record<string, string> }
  htmlSelectors?: { item: string; title: string; url: string; url2?: string; detailType?: number }
  maxCount?: number
  weight?: number
  status?: number
  createdAt?: number
  updatedAt?: number
}

export interface SearchResultItem {
  title: string
  url: string
  password?: string
  platform: string
  sourceName: string
  crawledAt?: number  // 爬取时间戳
  sourceWeight?: number  // 来源权重
  date?: string  // 资源日期
}

// ---- Upload types ----

export interface UploadOptions {
  /** 文件名（默认使用本地文件名） */
  fileName?: string
  /** 是否覆盖同名文件 */
  overwrite?: boolean
  /** 分片大小（字节） */
  chunkSize?: number
  /** 上传进度回调 */
  onProgress?: (progress: UploadProgress) => void
}

export interface UploadProgress {
  loaded: number      // 已上传字节数
  total: number       // 总字节数
  percent: number     // 0-100
  speed: number       // 上传速度（字节/秒）
}

export interface UploadResult {
  success: boolean
  fileId?: string
  fileName?: string
  fileSize?: number
  error?: string
}

export interface UploadFileInfo {
  localPath: string
  fileName: string
  fileSize: number
}

export interface UploadTaskPayload {
  accountId: string
  platform: Platform
  files: UploadFileInfo[]
  targetDirId: string
  targetPath?: string
  overwrite?: boolean
}

export interface UploadParams {
  accountId: string
  files: UploadFileInfo[]
  targetDirId: string
  overwrite?: boolean
}

// ---- Download types ----

export interface DownloadOptions {
  /** 保存的文件名（默认使用原文件名） */
  fileName?: string
  /** 下载进度回调 */
  onProgress?: (progress: DownloadProgress) => void
}

export interface DownloadProgress {
  loaded: number      // 已下载字节数
  total: number       // 总字节数
  percent: number     // 0-100
  speed: number       // 下载速度（字节/秒）
}

export interface DownloadResult {
  success: boolean
  localPath?: string  // 下载后的本地路径
  fileName?: string
  fileSize?: number
  error?: string
}

export interface DownloadFileInfo {
  fileId: string
  fileName: string
  fileSize: number
  isDir: boolean
}

export interface DownloadTaskPayload {
  accountId: string
  platform: Platform
  files: DownloadFileInfo[]
  targetDirPath: string  // 本地目录
}

export interface DownloadParams {
  accountId: string
  files: DownloadFileInfo[]
  targetDirPath: string
}

// ---- Quota types ----

export interface QuotaInfo {
  used: number       // 已用字节数
  total: number      // 总容量字节数（0 表示无限/未知）
}

// ---- Archive types ----

export interface ArchiveFileInfo {
  name: string
  path: string
  size: number
  isDir: boolean
  compressedSize?: number
  modifiedAt?: number
}

export interface ArchiveMeta {
  fileCount: number
  totalSize: number
  isEncrypted: boolean
  format: string
  files: ArchiveFileInfo[]
}

export interface ArchiveExtractOptions {
  password?: string
  targetDir: string  // 本地目标目录路径
  files?: string[]  // 指定解压的文件，空则全部解压
}
