import { session, webContents, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { baiduAdapter } from '../adapters/baidu'
import { quarkAdapter } from '../adapters/quark'
import { ucAdapter } from '../adapters/uc'
import type { DriveAccount } from '../shared/types'
import {
  INLINE_LOGIN_CONFIGS,
  QUARK_LOGIN_USER_AGENT,
  isInlineLoginUrl,
  type InlineLoginPlatform,
  type InlineLoginRequest,
  type InlineLoginStatus,
} from '../shared/inline-login'

interface CachedInspection {
  fingerprint: string
  checkedAt: number
  status: InlineLoginStatus
}

let inspections = new WeakMap<WebContents, CachedInspection>()
const FAILED_CHECK_TTL_MS = 5_000

function cookieString(cookies: Electron.Cookie[], domain: string): string {
  return cookies
    .filter((cookie) => {
      const cookieDomain = (cookie.domain || '').replace(/^\./, '')
      return cookieDomain === domain || cookieDomain.endsWith(`.${domain}`)
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ')
}

function hasCookie(cookies: Electron.Cookie[], name: string): boolean {
  return cookies.some((cookie) => cookie.name.toUpperCase() === name.toUpperCase() && Boolean(cookie.value))
}

function temporaryAccount(platform: InlineLoginPlatform, cookies: string, userAgent?: string): DriveAccount {
  return {
    id: `inline-login-${platform}`,
    platform,
    nickname: '',
    loginType: 'cookie',
    credential: { cookies, userAgent },
    userAgent,
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  }
}

async function enrichUcCookies(guest: WebContents, cookies: string): Promise<string> {
  try {
    await guest.session.fetch('https://pc-api.uc.cn/1/clouddrive/member?pr=UCBrowser&fr=pc', {
      headers: {
        Cookie: cookies,
        Referer: 'https://drive.uc.cn/',
        Accept: 'application/json, text/plain, */*',
      },
    })
    const refreshed = await guest.session.cookies.get({})
    return cookieString(refreshed, INLINE_LOGIN_CONFIGS.uc.domain) || cookies
  } catch {
    return cookies
  }
}

async function inspectCredentials(platform: InlineLoginPlatform, guest: WebContents): Promise<InlineLoginStatus> {
  const config = INLINE_LOGIN_CONFIGS[platform]
  const rawCookies = await guest.session.cookies.get({})
  let cookies = cookieString(rawCookies, config.domain)

  if (platform === 'baidu' && !hasCookie(rawCookies, 'BDUSS') && !hasCookie(rawCookies, 'BDUSS_BFESS')) {
    return { state: 'pending' }
  }
  if (platform !== 'baidu' && cookies.length < 50) return { state: 'pending' }

  const fingerprint = cookies
  const cached = inspections.get(guest)
  if (cached?.fingerprint === fingerprint) {
    if (cached.status.state === 'success' || Date.now() - cached.checkedAt < FAILED_CHECK_TTL_MS) return cached.status
  }

  let verified = false
  let nickname = config.label.replace('网盘', '') + '用户'
  let userAgent = guest.getUserAgent()

  try {
    if (platform === 'uc') cookies = await enrichUcCookies(guest, cookies)
    if (platform === 'quark') {
      userAgent = QUARK_LOGIN_USER_AGENT
      const account = temporaryAccount(platform, cookies, userAgent)
      verified = await quarkAdapter.checkLogin(account)
      if (verified) nickname = (await quarkAdapter.getUserInfo(account)).nickname || nickname
    } else if (platform === 'baidu') {
      const account = temporaryAccount(platform, cookies, userAgent)
      verified = await baiduAdapter.checkLogin(account)
      if (verified) nickname = (await baiduAdapter.getUserInfo(account)).nickname || nickname
      cookies = account.credential.cookies || cookies
    } else {
      const account = temporaryAccount(platform, cookies, userAgent)
      verified = await ucAdapter.checkLogin(account)
      if (verified) nickname = (await ucAdapter.getUserInfo(account)).nickname || nickname
    }
  } catch {
    verified = false
  }

  const status: InlineLoginStatus = verified
    ? { state: 'success', result: { success: true, cookies, userAgent, nickname } }
    : { state: 'pending' }
  inspections.set(guest, { fingerprint, checkedAt: Date.now(), status })
  return status
}

export function resolveInlineLoginGuest(
  sender: IpcMainInvokeEvent['sender'],
  input: InlineLoginRequest,
): WebContents {
  if (!input || !Number.isInteger(input.webContentsId) || input.webContentsId <= 0) {
    throw new Error('无效的内嵌登录页面')
  }
  if (!Object.prototype.hasOwnProperty.call(INLINE_LOGIN_CONFIGS, input.platform)) {
    throw new Error('不支持的内嵌登录平台')
  }

  const guest = webContents.fromId(input.webContentsId)
  if (!guest || guest.isDestroyed() || guest.getType() !== 'webview' || guest.hostWebContents !== sender) {
    throw new Error('内嵌登录页面不属于当前窗口')
  }

  const config = INLINE_LOGIN_CONFIGS[input.platform]
  if (guest.session !== session.fromPartition(config.partition) || !isInlineLoginUrl(input.platform, guest.getURL())) {
    throw new Error('内嵌登录页面来源校验失败')
  }
  return guest
}

export async function getInlineLoginStatus(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  input: InlineLoginRequest,
): Promise<InlineLoginStatus> {
  try {
    const guest = resolveInlineLoginGuest(event.sender, input)
    return await inspectCredentials(input.platform, guest)
  } catch (error) {
    return { state: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function resetInlineLoginSession(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  input: InlineLoginRequest,
): Promise<{ success: boolean; error?: string }> {
  try {
    const guest = resolveInlineLoginGuest(event.sender, input)
    inspections.delete(guest)
    await guest.session.clearStorageData()
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function clearInlineLoginInspection(webContentsId?: number): void {
  if (webContentsId) {
    const guest = webContents.fromId(webContentsId)
    if (guest) inspections.delete(guest)
  } else {
    inspections = new WeakMap<WebContents, CachedInspection>()
  }
}
