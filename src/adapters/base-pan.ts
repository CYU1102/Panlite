import { session } from 'electron'
import type { DriveAdapter } from './base'
import type { DriveAccount, FileItem, FileListResult, ShareInfo, ShareOptions, ShareDetail, ShareTaskPayload, TransferLinkInput, TransferResult } from '../shared/types'
import { fatal, retryable } from './errors'
import log from 'electron-log'

/**
 * 夸克/UC 类网盘适配器基类
 * 封装 Cookie 注入、分页轮询、任务状态轮询等通用逻辑
 */

export interface PanApiConfig {
  platform: string
  apiBase: string
  sessionPartition: string
  cookieDomain: string
  origin: string
  referer: string
  userAgent: string
  commonParams: Record<string, string>
}

export interface PanApiResponse<T = unknown> {
  status: number
  code: number
  message: string
  data: T
  metadata?: Record<string, unknown>
}

export abstract class BasePanAdapter implements DriveAdapter {
  protected config: PanApiConfig

  constructor(config: PanApiConfig) {
    this.config = config
  }

  // ── Cookie 管理 ──

  protected async injectCookies(cookieStr: string): Promise<void> {
    const ses = session.fromPartition(this.config.sessionPartition)
    const pairs = cookieStr.split(';').map((p) => p.trim()).filter(Boolean)
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=')
      if (eqIdx < 1) continue
      const name = pair.substring(0, eqIdx).trim()
      const value = pair.substring(eqIdx + 1).trim()
      if (!name) continue
      try {
        await ses.cookies.set({
          url: this.config.apiBase,
          name,
          value,
          domain: this.config.cookieDomain,
          path: '/',
          secure: true,
        })
      } catch { /* ignore */ }
    }
  }

  // ── HTTP 请求 ──

  protected async request<T>(
    url: string,
    cookies: string,
    options: { method?: string; body?: unknown; params?: Record<string, string> } = {},
  ): Promise<PanApiResponse<T>> {
    const method = options.method || 'GET'
    const urlObj = new URL(url)

    // 添加通用参数
    for (const [key, value] of Object.entries(this.config.commonParams)) {
      if (!urlObj.searchParams.has(key)) {
        urlObj.searchParams.set(key, value)
      }
    }
    // 添加缓存破坏参数
    urlObj.searchParams.set('__dt', String(Math.floor(Math.random() * 9000) + 1000))
    urlObj.searchParams.set('__t', String(Date.now()))

    const finalUrl = urlObj.toString()
    log.info(`${this.config.platform} ${method} ${finalUrl}`)

    await this.injectCookies(cookies)

    const headers: Record<string, string> = {
      'User-Agent': this.config.userAgent,
      'Origin': this.config.origin,
      'Referer': this.config.referer,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }

    const fetchOptions: RequestInit = { method, headers }
    if (options.body) {
      headers['Content-Type'] = 'application/json'
      fetchOptions.body = JSON.stringify(options.body)
    }

    const ses = session.fromPartition(this.config.sessionPartition)
    const response = await ses.fetch(finalUrl, fetchOptions)
    const text = await response.text()

    try {
      return JSON.parse(text) as PanApiResponse<T>
    } catch {
      throw new Error(`Failed to parse ${this.config.platform} API response: ${text.substring(0, 200)}`)
    }
  }

  // ── 分页轮询 ──

  protected async fetchAllPages<T>(
    url: string,
    cookies: string,
    extractList: (data: T) => unknown[],
    pageSize: number = 200,
    maxPages: number = 100,
  ): Promise<unknown[]> {
    const allItems: unknown[] = []
    for (let page = 1; page <= maxPages; page++) {
      const pageUrl = `${url}&_page=${page}&_size=${pageSize}`
      const res = await this.request<T>(pageUrl, cookies)
      if (res.code !== 0) throw new Error(`分页请求失败: ${res.message}`)
      const items = extractList(res.data)
      if (!Array.isArray(items)) break
      allItems.push(...items)
      if (items.length < pageSize) break
      await this.delay(200)
    }
    return allItems
  }

  // ── 任务轮询 ──

  protected async pollTask(
    taskId: string,
    cookies: string,
    maxRetries: number = 50,
  ): Promise<{ status: number; shareId?: string; savedFileIds?: string[] }> {
    for (let retryIndex = 0; retryIndex < maxRetries; retryIndex++) {
      await this.delay(Math.floor(Math.random() * 500) + 500)

      const taskRes = await this.request<{ status: number; share_id?: string; save_as?: { save_as_top_fids?: string[] } }>(
        `${this.config.apiBase}/task?task_id=${taskId}&retry_index=${retryIndex}`,
        cookies,
      )

      if (taskRes.code !== 0) {
        if (taskRes.code === 32003) throw fatal('容量不足', { platform: this.config.platform, action: '任务轮询' })
        if (taskRes.code === 41013) throw fatal('目标文件夹不存在', { platform: this.config.platform, action: '任务轮询' })
        log.info(`${this.config.platform} task poll [${retryIndex}]: code=${taskRes.code}, waiting...`)
        continue
      }

      if (taskRes.data?.status === 2) {
        return {
          status: 2,
          shareId: taskRes.data.share_id,
          savedFileIds: taskRes.data.save_as?.save_as_top_fids,
        }
      }
    }
    throw retryable('任务轮询超时', { platform: this.config.platform, action: '任务轮询' })
  }

  // ── 工具方法 ──

  protected delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  protected randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min
  }

  protected generateRandomCode(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''
    for (let i = 0; i < 4; i++) result += chars.charAt(Math.floor(Math.random() * chars.length))
    return result
  }

  protected mapExpireDays(days?: number): number {
    if (!days || days <= 0) return 1 // 永久
    if (days <= 1) return 2  // 1天
    if (days <= 7) return 3  // 7天
    return 4  // 30天
  }

  protected getCookies(account: DriveAccount): string {
    const cookies = account.credential.cookies
    if (!cookies) throw fatal('No cookies available', { platform: this.config.platform })
    return cookies
  }

  // ── 抽象方法（子类必须实现） ──

  abstract checkLogin(account: DriveAccount): Promise<boolean>
  abstract getUserInfo(account: DriveAccount): Promise<{ nickname: string; avatar?: string }>
  abstract listFiles(account: DriveAccount, parentId: string): Promise<FileListResult>
  abstract searchFiles(account: DriveAccount, keyword: string): Promise<FileItem[]>
  abstract mkdir(account: DriveAccount, parentId: string, name: string): Promise<FileItem>
  abstract rename(account: DriveAccount, fileId: string, newName: string): Promise<void>
  abstract move(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void>
  abstract delete(account: DriveAccount, fileIds: string[]): Promise<void>
}
