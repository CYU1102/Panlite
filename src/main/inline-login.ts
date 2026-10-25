import { randomUUID } from 'crypto'
import { session, type Session, type WebContents } from 'electron'
import { INLINE_LOGIN_PREFIX, INLINE_LOGIN_URLS, isInlineLoginUrl, type InlineLoginResult, type InlineLoginSession } from '../shared/inline-login'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const LIFETIME_MS = 10 * 60_000
interface Entry { descriptor: InlineLoginSession; owner: WebContents; session: Session; guest?: WebContents; expiresAt: number; pending?: Promise<InlineLoginResult>; abort: AbortController; disposeOwner: () => void }

export class InlineLoginManager {
  private entries = new Map<string, Entry>()
  private ownerVersions = new WeakMap<WebContents, number>()
  private loginSessions = new WeakSet<Session>()
  private cancellations = new Map<string, { owner: WebContents; entry: Entry; promise: Promise<void>; failed: boolean }>()
  constructor(private readonly createSession = (partition: string) => session.fromPartition(partition), private readonly clock = Date.now) {}

  async start(owner: WebContents, platform: unknown): Promise<InlineLoginResult> {
    if (platform !== 'quark' && platform !== 'uc') return { success: false, error: '该平台暂不支持页内登录，请使用现有授权方式' }
    const version = (this.ownerVersions.get(owner) || 0) + 1
    this.ownerVersions.set(owner, version)
    for (const [id, entry] of this.entries) if (entry.owner === owner || entry.expiresAt <= this.clock()) await this.cancelEntry(id)
    if (owner.isDestroyed() || this.ownerVersions.get(owner) !== version) return { success: false, error: '登录页面已关闭' }
    const id = randomUUID()
    const descriptor: InlineLoginSession = { id, platform, url: INLINE_LOGIN_URLS[platform], partition: `${INLINE_LOGIN_PREFIX}${id}` }
    const ses = this.createSession(descriptor.partition)
    this.loginSessions.add(ses)
    ses.setUserAgent(USER_AGENT)
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', event => event.preventDefault())
    const cancel = () => { void this.cancelEntry(id) }
    const navigate = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => { if (isMainFrame) cancel() }
    owner.once('destroyed', cancel)
    owner.once('render-process-gone', cancel)
    owner.on('did-start-navigation', navigate)
    this.entries.set(id, { descriptor, owner, session: ses, expiresAt: this.clock() + LIFETIME_MS, abort: new AbortController(), disposeOwner: () => {
      owner.removeListener('destroyed', cancel); owner.removeListener('render-process-gone', cancel); owner.removeListener('did-start-navigation', navigate)
    } })
    return { success: true, state: 'waiting', session: descriptor }
  }

  allowsAttachment(owner: WebContents, partition: string, url: string): boolean {
    const entry = [...this.entries.values()].find(item => item.descriptor.partition === partition)
    return !!entry && entry.owner === owner && !entry.guest && !owner.isDestroyed() && entry.expiresAt > this.clock()
      && isInlineLoginUrl(entry.descriptor.platform, url) && url === entry.descriptor.url
  }

  isLoginSession(ses: Session): boolean { return this.loginSessions.has(ses) }

  attach(owner: WebContents, guest: WebContents): boolean {
    const entry = [...this.entries.values()].find(item => item.owner === owner && item.session === guest.session && !item.guest)
    if (!entry || entry.expiresAt <= this.clock()) return false
    entry.guest = guest
    const allowed = (url: string) => isInlineLoginUrl(entry.descriptor.platform, url)
    guest.setWindowOpenHandler(({ url }) => {
      if (allowed(url) && !guest.isDestroyed()) void guest.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    const navigate = (event: Electron.Event, url: string) => { if (!allowed(url)) event.preventDefault() }
    guest.on('will-navigate', navigate)
    guest.on('will-redirect', navigate)
    guest.once('destroyed', () => { void this.cancelEntry(entry.descriptor.id) })
    return true
  }

  async status(owner: WebContents, id: unknown): Promise<InlineLoginResult> {
    const entry = typeof id === 'string' ? this.entries.get(id) : undefined
    if (!entry || entry.owner !== owner || owner.isDestroyed()) return { success: false, error: '登录会话已关闭' }
    if (entry.expiresAt <= this.clock()) { await this.cancelEntry(entry.descriptor.id); return { success: false, state: 'expired', error: '登录会话已过期，请刷新二维码' } }
    if (!entry.guest || entry.guest.isDestroyed()) return { success: true, state: 'waiting' }
    if (!entry.pending) {
      entry.pending = this.verify(entry).catch(() => ({ success: true, state: 'waiting' as const, error: '暂时无法验证登录，请重试或刷新页面' })).finally(() => { entry.pending = undefined })
    }
    const result = await entry.pending
    if (this.entries.get(entry.descriptor.id) !== entry || entry.abort.signal.aborted || owner.isDestroyed()) return { success: false, error: '登录会话已关闭' }
    if (entry.expiresAt <= this.clock()) { await this.cancelEntry(entry.descriptor.id); return { success: false, state: 'expired', error: '登录会话已过期，请刷新二维码' } }
    return result
  }

  private async cookies(entry: Entry): Promise<string> {
    const domain = entry.descriptor.platform === 'quark' ? 'quark.cn' : 'uc.cn'
    return (await entry.session.cookies.get({})).filter(cookie => {
      const host = (cookie.domain || '').replace(/^\./, '')
      return host === domain || host.endsWith(`.${domain}`)
    }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  }

  private async verify(entry: Entry): Promise<InlineLoginResult> {
    let cookies = await this.cookies(entry)
    if (!cookies) return { success: true, state: 'waiting' }
    const platform = entry.descriptor.platform
    const headers = { 'User-Agent': USER_AGENT, Cookie: cookies, Referer: INLINE_LOGIN_URLS[platform], Accept: 'application/json, text/plain, */*' }
    const signal = AbortSignal.any([entry.abort.signal, AbortSignal.timeout(12_000)])
    if (platform === 'uc') {
      const response = await entry.session.fetch('https://pc-api.uc.cn/1/clouddrive/member?pr=UCBrowser&fr=pc', { headers, signal })
      const member = await response.json() as { code?: number; status?: number; data?: unknown }
      if (!response.ok || member.code !== 0 || !member.data) return { success: true, state: 'waiting' }
      cookies = await this.cookies(entry)
      headers.Cookie = cookies
    }
    const response = await entry.session.fetch(`${INLINE_LOGIN_URLS[platform]}account/info?fr=pc&platform=pc`, { headers, signal })
    const info = await response.json() as { code?: number; success?: boolean; data?: { nickname?: string } }
    if (!response.ok || info.success === false || (info.code != null && info.code !== 0) || typeof info.data?.nickname !== 'string' || !info.data.nickname.trim()) return { success: true, state: 'waiting' }
    // Include any API-side security cookies set during verification.
    cookies = await this.cookies(entry)
    return { success: true, state: 'success', cookies, nickname: info.data.nickname.trim(), userAgent: USER_AGENT }
  }

  async cancel(owner: WebContents, id: unknown): Promise<InlineLoginResult> {
    const entry = typeof id === 'string' ? this.entries.get(id) || this.cancellations.get(id)?.entry : undefined
    if (entry?.owner === owner) await this.cancelEntry(entry.descriptor.id)
    if (typeof id === 'string' && this.cancellations.get(id)?.owner === owner && this.cancellations.get(id)?.failed)
      return { success: false, error: '登录会话清理失败，请重试取消或关闭应用' }
    return { success: true }
  }
  private async cancelEntry(id: string): Promise<void> {
    const existing = this.cancellations.get(id)
    if (existing && !existing.failed) return existing.promise
    const entry = this.entries.get(id) || existing?.entry
    if (!entry) return
    this.entries.delete(id)
    // Publish the cleanup promise before closing the guest: its destroyed event
    // and the renderer may both request cancellation before storage is cleared.
    const cancellation = { owner: entry.owner, entry, promise: Promise.resolve(), failed: false }
    const promise = Promise.resolve().then(async () => {
      entry.abort.abort()
      entry.disposeOwner()
      const guest = entry.guest
      if (guest && !guest.isDestroyed()) {
        await new Promise<void>(resolve => {
          const done = () => resolve()
          guest.once('destroyed', done)
          try { guest.stop(); guest.close({ waitForBeforeUnload: false }) }
          catch { guest.removeListener('destroyed', done); resolve() }
        })
      }
      const connections = await Promise.allSettled([Promise.resolve().then(() => entry.session.closeAllConnections()), entry.pending || Promise.resolve()])
      const storage = await Promise.allSettled([Promise.resolve().then(() => entry.session.clearStorageData()), Promise.resolve().then(() => entry.session.clearCache())])
      if ([...connections, ...storage].some(result => result.status === 'rejected')) throw new Error('登录会话清理失败')
      this.cancellations.delete(id)
    }).catch(() => {
      cancellation.failed = true
      // Never log provider responses or credentials. Keep the entry only for a
      // cleanup retry; it is absent from the active/attach/status registries.
      console.warn('登录会话清理失败，请重试取消或关闭应用')
    })
    cancellation.promise = promise
    this.cancellations.set(id, cancellation)
    return promise
  }
  async dispose(): Promise<void> {
    await Promise.all([...new Set([...this.entries.keys(), ...this.cancellations.keys()])].map(id => this.cancelEntry(id)))
  }
}

export const inlineLoginManager = new InlineLoginManager()
