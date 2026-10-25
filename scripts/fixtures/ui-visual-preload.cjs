const { contextBridge } = require('electron')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const now = 1790985600000
const accounts = [
  { id: 'ui-fixture-quark', platform: 'quark', nickname: '设计验收 · 云端资料', status: 'active', createdAt: now, updatedAt: now },
  { id: 'ui-fixture-baidu', platform: 'baidu', nickname: '工作文档与项目归档', status: 'active', createdAt: now, updatedAt: now },
  { id: 'ui-fixture-aliyun', platform: 'aliyun', nickname: '待重新授权的示例账号', status: 'expired', createdAt: now, updatedAt: now },
]
const names = ['项目资料', '照片与视频', '2026 年项目计划及里程碑安排.xlsx', '产品设计规范与交互说明（含详细验收要求）.pdf', '架构示意图.png', '会议记录.md', '项目介绍.mp4', '访谈录音.mp3', '数据导出.csv', '参考资料.zip', '需求变更记录与版本对照说明.txt', '会议字幕.srt']
const files = names.map((name, index) => ({ id: `ui-file-${index}`, name, isDir: index < 2, size: index < 2 ? 0 : (index + 1) * 154834, createdAt: now - index * 86400000, updatedAt: now, accountId: accounts[0].id, platform: 'quark', parentId: '0' }))
const documents = ['项目验收说明.md', '产品设计规范.pdf', '季度数据汇总.xlsx', '会议纪要与行动项.docx', '扫描归档资料.pdf', '录音字幕.srt'].map((name, index) => ({ id: `ui-document-${index}`, name, extension: name.split('.').pop(), sourceType: index % 2 ? 'cloud' : 'local', mimeType: 'text/plain', size: (index + 1) * 21942, sha256: `synthetic-${index}`, status: index === 4 ? 'failed' : index === 3 ? 'processing' : 'ready', parseMessage: index === 4 ? undefined : index === 3 ? '正在提取文档内容' : '原生提取完成；本地索引已建立', errorMessage: index === 4 ? '扫描文档尚未识别，请安装本地 OCR 工具后重试' : undefined, contentPreview: '项目验收关注功能正确性、可读性和操作效率。\n所有示例资料均为合成数据。', createdAt: now - index * 86400000, updatedAt: now }))
const citation = { documentId: documents[0].id, documentName: documents[0].name, section: '验收流程', quote: '验收需要覆盖账号、文件管理、预览、传输和文档问答，并记录实际问题。' }
const conversations = [
  { id: 'ui-conversation-0', title: '项目验收重点与行动计划', documentIds: [documents[0].id], createdAt: now, updatedAt: now, messageCount: 2 },
  { id: 'ui-conversation-1', title: '设计规范的关键改进', documentIds: [documents[1].id], createdAt: now, updatedAt: now - 86400000, messageCount: 2 },
  { id: 'ui-conversation-2', title: '季度数据说明', documentIds: [], createdAt: now, updatedAt: now - 172800000, messageCount: 2 },
]
const messages = [
  { id: 'ui-message-user', conversationId: conversations[0].id, role: 'user', content: '根据项目资料，整理本轮验收的重点与下一步行动。', createdAt: now },
  { id: 'ui-message-assistant', conversationId: conversations[0].id, role: 'assistant', content: '## 本轮验收重点\n\n优先检查核心功能，再核对界面在不同窗口尺寸下的表现。\n\n| 检查项 | 验收方式 |\n| --- | --- |\n| 文件管理 | 浏览、选择与预览 |\n| 文档问答 | 核对回答和引用原文 |\n\n1. 完成账号与文件操作回归。\n2. 检查窗口缩放与异常状态。\n3. 记录问题并重新验证。\n\n**这份回答使用合成资料，仅用于界面验收。**', citations: [citation], createdAt: now },
]
const tasks = ['running', 'failed', 'success', 'pending'].map((status, index) => ({ id: `ui-task-${index}`, taskType: 'parse', title: ['建立项目资料索引', '解析扫描归档资料', '导入会议字幕', '提取 Office 文档'][index], status, progress: [64, 0, 100, 0][index], message: '本地处理', errorMessage: status === 'failed' ? '缺少本地 OCR 工具' : undefined, createdAt: now, updatedAt: now }))
const config = { id: 'ui-provider', name: '示例模型配置', type: 'openai-compatible', baseUrl: 'http://127.0.0.1/fixture-no-network', model: 'synthetic-model', transcriptionModel: '', embeddingModel: '', hasApiKey: true, keyCount: 1, keyPreviews: ['示例配置，无真实密钥'] }
const settings = { theme: 'light', page_size: '100', request_interval: '300', max_concurrent_tasks: '3', max_download_concurrency: '3' }
const defaultResult = () => ({ success: true, files: [], tasks: [], records: [], links: [], results: [], history: [], sources: [], channels: [], settings, enabled: false })
const api = {}
for (const method of JSON.parse(readFileSync(join(process.env.PANLITE_UI_OUTPUT, 'bridge-methods.json'), 'utf8'))) api[method] = method.startsWith('on') ? () => () => undefined : async () => defaultResult()
Object.assign(api, {
  listAccounts: async () => ({ success: true, accounts }),
  listFiles: async () => ({ success: true, files, parentId: '0', hasMore: false }),
  listTasks: async () => ({ success: true, tasks: ['running', 'failed', 'success', 'paused', 'pending', 'partial_success'].map((status, index) => ({ id: `ui-transfer-${index}`, accountId: accounts[0].id, platform: 'quark', taskType: index % 2 ? 'share' : 'download', title: ['下载产品设计规范与参考资料', '分享项目验收文档', '下载季度数据汇总', '创建项目参考资料分享', '下载会议记录', '分享部分归档文件'][index], payload: { totalBytes: 40960000 }, status, progress: [48, 0, 100, 35, 0, 75][index], retryCount: index === 1 ? 2 : 0, errorMessage: ['failed', 'partial_success'].includes(status) ? '示例错误：授权状态需要重新核验，请重新登录后重试。' : undefined, createdAt: now - index * 3600000, updatedAt: now })) }),
  shareList: async () => ({ success: true, links: ['active', 'expired', 'cancelled'].map((status, index) => ({ id: `ui-share-${index}`, title: ['项目验收说明及参考资料', '季度数据汇总', '会议记录与行动项'][index], platform: 'quark', account_id: accounts[0].id, share_url: `https://example.invalid/visual-fixture-${index}`, password: index ? '' : 'uiqa', status, created_at: now - index * 86400000 })) }),
  searchFiles: async () => ({ success: true, files: files.filter(file => !file.isDir), hasMore: false }),
  getSearchHistory: async () => ({ success: true, history: [] }),
  getSetting: async key => ({ success: true, value: settings[key] || null }),
  setSetting: async (key, value) => { settings[key] = value; return { success: true } },
  getAllSettings: async () => ({ success: true, settings }),
  getAppLockStatus: async () => ({ success: true, enabled: false, locked: false }),
  getAccountMembership: async () => ({ success: true, membership: { known: true, isVip: false, status: 'none', label: '普通用户', fetchedAt: now } }),
  getAppUpdateState: async () => ({ phase: 'disabled', revision: 1, message: '隔离界面验收' }),
  aiDocumentList: async () => ({ success: true, documents }),
  aiTaskList: async () => ({ success: true, tasks }),
  aiProviderGet: async () => ({ success: true, config }),
  aiProviderList: async () => ({ success: true, profiles: [config] }),
  aiProviderUsage: async () => ({ success: true, usage: [] }),
  aiConversationList: async () => ({ success: true, conversations }),
  aiConversationMessages: async () => ({ success: true, messages }),
  aiLocalToolsGet: async () => ({ success: true, config: {}, tools: [{ key: 'tesseract', name: 'Tesseract', available: true, ready: true, message: '合成本地工具状态' }, { key: 'ffmpeg', name: 'FFmpeg', available: true, ready: true, subtitleAvailable: true, message: '合成本地工具状态' }] }),
  aiProcessingPolicyGet: async () => ({ success: true, policy: { allowModelFallback: false, useSemanticIndex: false } }),
  aiCitationPreview: async () => ({ success: true, citation, preview: { sessionId: 'ui-citation', kind: 'text', fileName: documents[0].name, content: citation.quote, mimeType: 'text/plain', size: 200, expiresAt: now + 60000 } }),
  aiCitationPreviewCleanup: async () => ({ success: true }),
  prepareFilePreview: async (_account, _id, fileName) => ({ success: true, preview: { sessionId: 'e620b81a-f8ce-4d1c-bdf8-a9c7865c1490', kind: 'image', fileName, assetUrl: 'panlite-preview://session/e620b81a-f8ce-4d1c-bdf8-a9c7865c1490', mimeType: 'image/svg+xml', size: 800, expiresAt: now + 60000 } }),
  cleanupFilePreview: async () => ({ success: true }),
  openExternal: async () => ({ success: false, error: 'External navigation is disabled in synthetic visual QA' }),
})
contextBridge.exposeInMainWorld('electronAPI', api)
contextBridge.exposeInMainWorld('aiWorkflowAPI', { list: async () => ({ success: true, workflows: [] }), templates: async () => ({ success: true, templates: [] }) })
contextBridge.exposeInMainWorld('catalogAPI', { listScopes: async () => ({ success: true, scopes: [] }), listTags: async () => ({ success: true, tags: [] }), listCollections: async () => ({ success: true, collections: [] }), search: async () => ({ success: true, entries: [], total: 0 }) })
