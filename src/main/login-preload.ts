import { contextBridge, ipcRenderer } from 'electron'

/**
 * 登录窗口专用的 preload 脚本
 * 只暴露一个 confirmLogin 方法，用于通知主进程用户已完成登录
 */
contextBridge.exposeInMainWorld('electronAPI', {
  confirmLogin: () => ipcRenderer.send('__login_confirm'),
})
