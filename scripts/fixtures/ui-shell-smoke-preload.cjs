const { contextBridge } = require('electron')

const now = Date.now()
const accounts = [
  { id: 'fixture-quark', platform: 'quark', nickname: '项目资料账号', loginType: 'cookie', status: 'active', createdAt: now, updatedAt: now, lastCheckAt: now },
  { id: 'fixture-baidu', platform: 'baidu', nickname: '个人归档账号', loginType: 'cookie', status: 'expired', createdAt: now, updatedAt: now, lastCheckAt: now - 86400000 },
]
const files = [
  { id: 'folder-1', name: '设计与产品文档', isDir: true, size: 0 },
  { id: 'folder-2', name: '项目归档', isDir: true, size: 0 },
  { id: 'file-1', name: 'PanLite 产品路线图 2026.pdf', isDir: false, size: 3823710 },
  { id: 'file-2', name: '发布演示视频.mp4', isDir: false, size: 183293761 },
  { id: 'file-3', name: '季度数据汇总.xlsx', isDir: false, size: 936143 },
  { id: 'file-4', name: '界面交互说明.md', isDir: false, size: 18274 },
].map((file, index) => ({ ...file, parentId: '0', platform: 'quark', accountId: 'fixture-quark', createdAt: now - (index + 10) * 86400000, updatedAt: now - index * 86400000 }))

contextBridge.exposeInMainWorld('electronAPI', {
  getSetting: async () => ({ success: true, value: 'light' }),
  setSetting: async () => ({ success: true }),
  getAppLockStatus: async () => ({ success: true, enabled: false, locked: false }),
  onAppLockChanged: () => () => {},
  listAccounts: async () => ({ success: true, accounts }),
  getAccountMembership: async () => ({ success: true }),
  getSearchHistory: async () => ({ success: true, history: [] }),
  listFiles: async () => ({ success: true, files, parentId: '0', hasMore: false }),
  onAppNavigate: () => () => {},
  onClipboardShareDetected: () => () => {},
})
