import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'path'
import log from 'electron-log'
import { getExternalHttpUrl, getRendererIndexPath, isTrustedRendererUrl } from './ipc-security'

export function createMainWindow(): BrowserWindow {
  const pendingWebviewOrigins: string[] = []
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  const rendererIndexPath = getRendererIndexPath()
  const resourcePreloadPath = process.env.VITE_DEV_SERVER_URL
    ? join(process.cwd(), 'src/renderer/preload-extract.js')
    : join(__dirname, '../../renderer/preload-extract.js')
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'PanLite',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0b' : '#f6f8fc',
    icon: join(app.getAppPath(), 'build/icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !process.argv.includes('--benchmark-startup'),
      webviewTag: true,
    },
  })
  // The app provides its own navigation and actions; hide Electron's default
  // English application menu while keeping the native window controls.
  if (process.platform === 'win32') win.removeMenu()

  const guardMainNavigation = (event: Electron.Event, url: string) => {
    if (!isTrustedRendererUrl(url, devServerUrl, rendererIndexPath)) {
      event.preventDefault()
      const externalUrl = getExternalHttpUrl(url)
      if (externalUrl) void shell.openExternal(externalUrl)
    }
  }
  win.webContents.on('will-navigate', guardMainNavigation)
  win.webContents.on('will-redirect', guardMainNavigation)
  win.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getExternalHttpUrl(url)
    if (externalUrl) void shell.openExternal(externalUrl)
    return { action: 'deny' }
  })

  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    try {
      const target = new URL(params.src)
      if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('Unsupported protocol')
      pendingWebviewOrigins.push(target.origin)
    } catch {
      event.preventDefault()
      return
    }

    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.preload = resourcePreloadPath
  })

  win.webContents.on('did-attach-webview', (_event, guest) => {
    const allowedOrigin = pendingWebviewOrigins.shift()
    guest.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url)
        if (target.protocol === 'https:' || target.protocol === 'http:') void shell.openExternal(target.toString())
      } catch { /* deny malformed URL */ }
      return { action: 'deny' }
    })
    const guardGuestNavigation = (event: Electron.Event, url: string) => {
      try {
        const target = new URL(url)
        if (
          (target.protocol !== 'https:' && target.protocol !== 'http:')
          || !allowedOrigin
          || target.origin !== allowedOrigin
        ) {
          event.preventDefault()
          if (target.protocol === 'https:' || target.protocol === 'http:') {
            void shell.openExternal(target.toString())
          }
        }
      } catch {
        event.preventDefault()
      }
    }
    guest.on('will-navigate', guardGuestNavigation)
    guest.on('will-redirect', guardGuestNavigation)
    guest.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  })

  // In dev, load from Vite dev server; in prod, load from built files
  if (devServerUrl) {
    win.loadURL(devServerUrl)
    win.webContents.openDevTools()
  } else {
    log.info('__dirname:', __dirname)
    log.info('Loading renderer from:', rendererIndexPath)
    win.loadFile(rendererIndexPath)
  }

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log.error('Renderer failed to load:', errorCode, errorDescription, validatedURL)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    log.error('Renderer process gone:', details.reason, details.exitCode)
  })

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levels = ['verbose', 'info', 'warning', 'error']
    log.info(`[renderer ${levels[level] || level}] ${message} (${sourceId}:${line})`)
  })

  return win
}
