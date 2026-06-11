/**
 * 统一错误处理模块
 * 参考 xinyue-search 的 jerr2() 模式
 * 所有适配器使用统一的错误类型和格式
 */

/** 错误级别 */
export type ErrorLevel = 'error' | 'warn' | 'info'

/** 统一错误类 */
export class PanError extends Error {
  code: string
  level: ErrorLevel
  platform: string
  action: string
  retryable: boolean

  constructor(opts: {
    message: string
    code?: string
    level?: ErrorLevel
    platform?: string
    action?: string
    retryable?: boolean
  }) {
    super(opts.message)
    this.name = 'PanError'
    this.code = opts.code || 'UNKNOWN'
    this.level = opts.level || 'error'
    this.platform = opts.platform || ''
    this.action = opts.action || ''
    this.retryable = opts.retryable ?? false
  }

  toString(): string {
    return `[${this.platform}] ${this.action}失败: ${this.message}`
  }
}

/** 创建不可重试的错误 */
export function fatal(message: string, opts?: { code?: string; platform?: string; action?: string }): PanError {
  return new PanError({ message, retryable: false, level: 'error', ...opts })
}

/** 创建可重试的错误 */
export function retryable(message: string, opts?: { code?: string; platform?: string; action?: string }): PanError {
  return new PanError({ message, retryable: true, level: 'warn', ...opts })
}

/** 判断错误是否可重试 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof PanError) return err.retryable
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    // 网络错误通常可重试
    if (msg.includes('timeout') || msg.includes('network') || msg.includes('econnrefused')) return true
    if (msg.includes('请求过于频繁') || msg.includes('too many requests')) return true
    if (msg.includes('服务器错误') || msg.includes('server error')) return true
  }
  return false
}

/** 判断是否为永久性错误（不应重试） */
export function isPermanentError(err: unknown): boolean {
  if (err instanceof PanError) return !err.retryable
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    // 永久性错误
    if (msg.includes('登录已失效') || msg.includes('未登录')) return true
    if (msg.includes('链接已失效') || msg.includes('分享已取消')) return true
    if (msg.includes('提取码错误')) return true
    if (msg.includes('容量不足')) return true
    if (msg.includes('文件违规')) return true
    if (msg.includes('链接访问次数过多')) return true
  }
  return false
}

/** 从未知错误中提取错误消息 */
export function sanitizeError(err: unknown): string {
  let msg = String(err instanceof Error ? err.message : err)
  // 清理敏感信息
  msg = msg.replace(/access_token=[^&\s]+/gi, 'access_token=***')
  msg = msg.replace(/refresh_token=[^&\s]+/gi, 'refresh_token=***')
  msg = msg.replace(/client_secret=[^&\s]+/gi, 'client_secret=***')
  msg = msg.replace(/Cookie:[^\n]+/gi, 'Cookie:***')
  msg = msg.replace(/BDUSS=[^;\s]+/gi, 'BDUSS=***')
  msg = msg.replace(/BDCLND=[^;\s]+/gi, 'BDCLND=***')
  if (msg.length > 500) msg = msg.substring(0, 500) + '...'
  return msg
}
