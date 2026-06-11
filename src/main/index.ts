import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import log from 'electron-log'
import { createMainWindow } from './window'
import { initDatabase } from './db'
import { registerIpcHandlers } from './ipc'
import { resumePendingTasks } from './task-runner'

// Configure electron-log
log.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'logs', 'main.log')
log.transports.console.level = 'info'
log.transports.file.level = 'info'

let mainWindow: BrowserWindow | null = null

app.whenReady().then(() => {
  log.info('PanLite starting...')

  // Initialize SQLite database
  initDatabase()
  log.info('Database initialized')

  // Register IPC handlers
  registerIpcHandlers()
  log.info('IPC handlers registered')

  // Resume any pending tasks from previous session
  resumePendingTasks()

  // Create main window
  mainWindow = createMainWindow()
  log.info('Main window created')

  mainWindow.on('closed', () => {
    mainWindow = null
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    mainWindow = createMainWindow()
  }
})
