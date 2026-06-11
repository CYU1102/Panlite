import { BrowserWindow } from 'electron'
import { join } from 'path'
import log from 'electron-log'

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'PanLite',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  })

  // In dev, load from Vite dev server; in prod, load from built files
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
    win.webContents.openDevTools()
  } else {
    const htmlPath = join(__dirname, '../../renderer/index.html')
    log.info('__dirname:', __dirname)
    log.info('Loading renderer from:', htmlPath)
    win.loadFile(htmlPath)
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
