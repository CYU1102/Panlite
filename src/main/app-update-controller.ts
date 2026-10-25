import type { AppUpdateState, AppUpdateResult } from '../shared/app-update'

export interface UpdateEngine {
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
}

export class AppUpdateController {
  private state: AppUpdateState
  private busy = false
  constructor(private engine: UpdateEngine | null, private notify: (state: AppUpdateState) => void,
    private hasRunningTasks: () => boolean, private confirmInstall: () => Promise<boolean>,
    private logError: (error: unknown) => void = () => {}) {
    this.state = { phase: engine ? 'idle' : 'disabled', revision: 0 }
    engine?.on('update-available', (info: { version: string }) => {
      if (this.state.phase === 'checking') this.set({ phase: 'available', version: info.version })
    })
    engine?.on('update-not-available', () => {
      if (this.state.phase === 'checking') this.set({ phase: 'current' })
    })
    engine?.on('download-progress', (progress: { percent: number }) => {
      if (this.state.phase === 'downloading' && Number.isFinite(progress.percent)) {
        this.set({ ...this.state, percent: Math.round(Math.max(0, Math.min(100, progress.percent))) })
      }
    })
    engine?.on('update-downloaded', () => {
      if (this.state.phase === 'downloading') this.set({ phase: 'downloaded', version: this.state.version, percent: 100 })
    })
    engine?.on('error', error => {
      this.logError(error)
      if (['checking', 'downloading', 'installing'].includes(this.state.phase)) this.fail()
    })
  }
  getState(): AppUpdateState { return { ...this.state } }
  private set(next: Omit<AppUpdateState, 'revision'>): void {
    this.state = { ...next, revision: this.state.revision + 1 }
    this.notify(this.getState())
  }
  private result(error?: string): AppUpdateResult {
    return { success: !error, state: this.getState(), ...(error ? { error } : {}) }
  }
  private fail(): void {
    this.set({ phase: 'error', message: '更新失败，请检查网络后重试；安装包校验失败时不会安装。' })
  }
  async check(): Promise<AppUpdateResult> {
    if (!this.engine) return this.result('当前构建未启用应用内更新')
    if (this.busy || ['downloading', 'downloaded', 'installing'].includes(this.state.phase)) return this.result('请先完成当前更新操作')
    this.busy = true
    this.set({ phase: 'checking' })
    try {
      const result = await this.engine.checkForUpdates()
      if (!result && this.state.phase === 'checking') this.fail()
    } catch (error) { this.logError(error); this.fail() }
    finally { this.busy = false }
    return this.result(this.getState().phase === 'error' ? this.state.message : undefined)
  }
  async download(): Promise<AppUpdateResult> {
    if (!this.engine || this.busy || this.state.phase !== 'available') return this.result('请先检查可用更新')
    this.busy = true
    this.set({ phase: 'downloading', version: this.state.version, percent: 0 })
    try { await this.engine.downloadUpdate() }
    catch (error) { this.logError(error); this.fail() }
    finally { this.busy = false }
    return this.result(this.getState().phase === 'error' ? this.state.message : undefined)
  }
  async install(): Promise<AppUpdateResult> {
    if (!this.engine || this.busy || this.state.phase !== 'downloaded') return this.result('请先下载并校验更新')
    this.busy = true
    try {
      if (this.hasRunningTasks()) return this.result('任务仍在运行，请先暂停任务再安装更新')
      if (!await this.confirmInstall()) return this.result()
      if (this.state.phase !== 'downloaded' || this.hasRunningTasks()) return this.result('任务状态已变化，请暂停任务后重试')
      this.set({ phase: 'installing', version: this.state.version })
      this.engine.quitAndInstall(false, true)
      return this.result(this.getState().phase === 'error' ? this.state.message : undefined)
    } catch (error) { this.logError(error); this.fail(); return this.result(this.state.message) }
    finally { this.busy = false }
  }
}
