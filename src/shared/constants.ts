export const IPC_CHANNELS = {
  // Account
  ACCOUNT_ADD: 'account:add',
  ACCOUNT_LIST: 'account:list',
  ACCOUNT_DELETE: 'account:delete',
  ACCOUNT_CHECK: 'account:check',
  ACCOUNT_QUOTA: 'account:quota',
  ACCOUNT_MEMBERSHIP: 'account:membership',
  ACCOUNT_GET_CREDENTIAL: 'account:get-credential',

  // File
  FILE_LIST: 'file:list',
  FILE_SEARCH: 'file:search',
  FILE_MKDIR: 'file:mkdir',
  FILE_RENAME: 'file:rename',
  FILE_MOVE: 'file:move',
  FILE_DELETE: 'file:delete',
  FILE_COPY: 'file:copy',
  FILE_GET_LINK: 'file:get-link',
  FILE_PREVIEW_PREPARE: 'file-preview:create',
  FILE_PREVIEW_CLEANUP: 'file-preview:cleanup',

  // Global search
  GLOBAL_SEARCH: 'global-search:execute',
  GLOBAL_SEARCH_HISTORY: 'global-search:history',
  SAVED_SEARCH_LIST: 'saved-search:list',
  SAVED_SEARCH_SAVE: 'saved-search:save',
  SAVED_SEARCH_DELETE: 'saved-search:delete',

  // Batch operations (task-based)
  BATCH_RENAME: 'batch:rename',
  BATCH_MOVE: 'batch:move',
  BATCH_DELETE: 'batch:delete',
  CLOUD_TRANSFER_CREATE: 'cloud-transfer:create',

  // Share
  SHARE_BATCH_CREATE: 'share:batch-create',
  SHARE_LIST: 'share:list',
  SHARE_DELETE: 'share:delete',
  SHARE_EXPORT_CSV: 'share:export-csv',

  // Transfer
  TRANSFER_BATCH_CREATE: 'transfer:batch-create',
  TRANSFER_LIST: 'transfer:list',
  TRANSFER_DELETE: 'transfer:delete',
  TRANSFER_EXPORT_CSV: 'transfer:export-csv',

  // Download
  DOWNLOAD_FILES: 'download:files',
  DOWNLOAD_SELECT_DIR: 'download:select-dir',

  // Upload
  UPLOAD_SELECT_FILES: 'upload:select-files',
  UPLOAD_SELECT_FOLDER: 'upload:select-folder',
  UPLOAD_HANDLE_DROP: 'upload:handle-drop',
  UPLOAD_FILES: 'upload:files',

  // Archive
  ARCHIVE_LIST: 'archive:list',
  ARCHIVE_EXTRACT: 'archive:extract',
  ARCHIVE_COMPRESS: 'archive:compress',

  // Search History
  SEARCH_HISTORY: 'search:history',
  SEARCH_CLEAR_HISTORY: 'search:clear-history',

  // Link verification
  LINK_VERIFY: 'link:verify',
  LINK_VERIFY_SINGLE: 'link:verify-single',
  LINK_VERIFY_BATCH: 'link:verify-batch',

  // Resource search
  SEARCH_SOURCES_LIST: 'search:sources-list',
  SEARCH_SOURCES_SAVE: 'search:sources-save',
  SEARCH_SOURCES_DELETE: 'search:sources-delete',
  SEARCH_EXECUTE: 'search:execute',

  // TG Channels
  TG_CHANNELS_LIST: 'tg:channels-list',
  TG_CHANNELS_SAVE: 'tg:channels-save',
  TG_CHANNELS_DELETE: 'tg:channels-delete',

  // Crawler Sources
  CRAWLER_SOURCES_LIST: 'crawler:sources-list',
  CRAWLER_SOURCES_SAVE: 'crawler:sources-save',
  CRAWLER_SOURCES_DELETE: 'crawler:sources-delete',

  // KK Sources
  KK_SOURCES_LIST: 'kk:sources-list',
  KK_SOURCES_SAVE: 'kk:sources-save',
  KK_SOURCES_DELETE: 'kk:sources-delete',

  // Stream Search (SSE-like)
  SEARCH_STREAM_START: 'search:stream-start',
  SEARCH_STREAM_EVENT: 'search:stream-event',
  SEARCH_STREAM_STOP: 'search:stream-stop',

  // URL Crypto
  URL_ENCRYPT: 'url:encrypt',
  URL_DECRYPT: 'url:decrypt',

  // Task
  TASK_LIST: 'task:list',
  TASK_RETRY: 'task:retry',
  TASK_CANCEL: 'task:cancel',
  TASK_PAUSE: 'task:pause',
  TASK_RESUME: 'task:resume',
  TASK_DELETE: 'task:delete',
  TASK_LOGS: 'task:logs',
  TASK_UPDATED: 'task:updated',

  // Backup and security
  BACKUP_CREATE: 'backup:create',
  BACKUP_INSPECT: 'backup:inspect',
  BACKUP_RESTORE: 'backup:restore',
  CONFIG_BACKUP_EXPORT: 'config-backup:export',
  CONFIG_BACKUP_PREVIEW: 'config-backup:preview',
  CONFIG_BACKUP_IMPORT: 'config-backup:import',
  APP_LOCK_STATUS: 'app-lock:status',
  APP_LOCK_CONFIGURE: 'app-lock:configure',
  APP_LOCK_UNLOCK: 'app-lock:unlock',
  APP_LOCK_NOW: 'app-lock:now',
  APP_LOCK_TOUCH: 'app-lock:touch',
  APP_LOCK_CHANGE_PASSWORD: 'app-lock:change-password',
  APP_LOCK_DISABLE: 'app-lock:disable',
  APP_LOCK_SET_AUTO_LOCK: 'app-lock:set-auto-lock',
  APP_LOCK_CHANGED: 'app-lock:changed',
  APP_NAVIGATE: 'app:navigate',

  // Export
  EXPORT_CSV: 'export:csv',

  // Login
  LOGIN_QUARK: 'login:quark',
  LOGIN_BAIDU: 'login:baidu',
  LOGIN_BAIDU_COOKIE: 'login:baidu-cookie',
  BAIDU_GET_AUTH_URL: 'baidu:get-auth-url',
  LOGIN_UC: 'login:uc',
  LOGIN_XUNLEI: 'login:xunlei',
  LOGIN_XUNLEI_AUTO: 'login:xunlei-auto',
  LOGIN_WINDOW_RESULT: 'login:window-result',

  // System
  DIALOG_SAVE: 'dialog:save',
  DIALOG_OPEN: 'dialog:open',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_GET_ALL: 'settings:get-all',

  // AI workspace (independent from share/transfer/cloud-transfer)
  AI_SELECT_FILES: 'ai:select-files',
  AI_IMPORT_FILES: 'ai:import-files',
  AI_DOCUMENT_LIST: 'ai:document-list',
  AI_DOCUMENT_DELETE: 'ai:document-delete',
  AI_DOCUMENT_REINDEX: 'ai:document-reindex',
  AI_TASK_LIST: 'ai:task-list',
  AI_TASK_UPDATED: 'ai:task-updated',
  AI_PROVIDER_GET: 'ai:provider-get',
  AI_PROVIDER_SAVE: 'ai:provider-save',
  AI_PROVIDER_TEST: 'ai:provider-test',
  AI_PROVIDER_LIST: 'ai:provider-list',
  AI_PROVIDER_ACTIVATE: 'ai:provider-activate',
  AI_PROVIDER_DELETE: 'ai:provider-delete',
  AI_PROVIDER_USAGE: 'ai:provider-usage',
  AI_LOCAL_TOOLS_GET: 'ai:local-tools-get',
  AI_LOCAL_TOOLS_SAVE: 'ai:local-tools-save',
  AI_LOCAL_TOOLS_SELECT: 'ai:local-tools-select',
  AI_ASK: 'ai:ask',
  AI_ASK_STREAM_START: 'ai:ask-stream-start',
  AI_ASK_STREAM_CANCEL: 'ai:ask-stream-cancel',
  AI_ASK_STREAM_EVENT: 'ai:ask-stream-event',
  AI_CONVERSATION_LIST: 'ai:conversation-list',
  AI_CONVERSATION_CREATE: 'ai:conversation-create',
  AI_CONVERSATION_RENAME: 'ai:conversation-rename',
  AI_CONVERSATION_DELETE: 'ai:conversation-delete',
  AI_CONVERSATION_SET_DOCUMENTS: 'ai:conversation-set-documents',
  AI_CONVERSATION_MESSAGES: 'ai:conversation-messages',
  AI_CONVERSATION_SEARCH: 'ai:conversation-search',
  AI_CONVERSATION_EXPORT: 'ai:conversation-export',
  AI_CONVERSATION_TRUNCATE: 'ai:conversation-truncate',
  AI_KNOWLEDGE_EXPORT: 'ai:knowledge-export',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

export const PLATFORM_LABELS: Record<string, string> = {
  quark: '夸克网盘',
  baidu: '百度网盘',
  uc: 'UC网盘',
  xunlei: '迅雷网盘',
}

export const PAN_PATTERNS: Record<string, RegExp> = {
  quark: /https?:\/\/pan\.quark\.cn\/s\/[a-zA-Z0-9]+/,
  baidu: /https?:\/\/pan\.baidu\.com\/s\/[a-zA-Z0-9_-]+(\?pwd=[a-zA-Z0-9]+)?/,
  uc: /https?:\/\/drive\.uc\.cn\/s\/[a-zA-Z0-9]+/,
  xunlei: /https?:\/\/pan\.xunlei\.com\/s\/[a-zA-Z0-9_-]+(\?pwd=[a-zA-Z0-9]+)?/,
}

export const TASK_TYPE_LABELS: Record<string, string> = {
  rename: '批量重命名',
  move: '批量移动',
  delete: '批量删除',
  mkdir: '新建文件夹',
  share: '分享',
  batch_share: '批量分享',
  transfer: '转存',
  batch_transfer: '批量转存',
  cloud_transfer: '跨网盘迁移',
  upload: '上传文件',
  download: '下载文件',
  archive_extract: '解压文件',
  archive_compress: '创建压缩包',
}

export const TASK_STATUS_LABELS: Record<string, string> = {
  pending: '等待中',
  running: '执行中',
  success: '已完成',
  partial_success: '部分完成',
  failed: '失败',
  paused: '已暂停',
  cancelled: '已取消',
}

export const MAX_RETRY_COUNT = 3

export const CONCURRENCY: Record<string, number> = {
  quark: 1,
  baidu: 2,
  uc: 1,
  xunlei: 1,
}

/** 每次转存操作之间的延迟（毫秒），避免请求过于频繁 */
export const TRANSFER_DELAY_MS = 300

/** 百度分享链接数量限制 */
export const BAIDU_SAVE_LIMIT = 1000

/** 设置 key 常量 */
export const SETTINGS_KEYS = {
  BANNED_KEYWORDS: 'bannedKeywords',
  AD_FILTER_ENABLED: 'adFilterEnabled',
} as const

/** 默认广告关键词列表（参考 xinyue-search） */
export const DEFAULT_BANNED_KEYWORDS = '公众号,微信,关注,点赞,加群,免费领取,扫码,淘宝,拼多多,京东,抖音,快手,广告,推广,优惠,福利,赚钱,兼职,网赚,代理,加盟,招商,贷款,理财,保险,炒股,基金,彩票,赌博,色情,约炮,裸聊,诈骗,刷单,传销,邪教,维权,上访,翻墙,VPN,梯子'
