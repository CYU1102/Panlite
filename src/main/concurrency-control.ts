import log from 'electron-log'

/**
 * 并发控制模块
 * 参考 xinyue-search 的缓存锁机制
 * 防止同一关键词重复搜索，支持等待正在进行的搜索结果
 */

// ── 搜索结果缓存 ──

interface CacheEntry {
  results: any[]
  expiresAt: number
}

// 搜索结果缓存（60秒过期，与xinyue-search一致）
const SEARCH_CACHE_TTL_MS = 60 * 1000
const searchCache = new Map<string, CacheEntry>()

// ── 处理锁 ──

interface ProcessingLock {
  promise: Promise<any[]>
  startTime: number
}

// 正在处理的搜索请求
const processingLocks = new Map<string, ProcessingLock>()

// 处理锁超时时间（60秒，与xinyue-search一致）
const PROCESSING_LOCK_TIMEOUT_MS = 60 * 1000

// ── 频率限制 ──

interface RateLimitEntry {
  count: number
  resetAt: number
}

// IP频率限制（10秒内最多1次，与xinyue-search一致）
const RATE_LIMIT_WINDOW_MS = 10 * 1000
const RATE_LIMIT_MAX_REQUESTS = 1
const rateLimitMap = new Map<string, RateLimitEntry>()

// ── 缓存操作 ──

/**
 * 获取缓存的搜索结果
 */
export function getCachedResults(keyword: string): any[] | null {
  const cached = searchCache.get(keyword)
  if (cached && cached.expiresAt > Date.now()) {
    log.info(`[Concurrency] Cache hit for "${keyword}"`)
    return cached.results
  }
  if (cached) {
    searchCache.delete(keyword)
  }
  return null
}

/**
 * 设置搜索结果缓存
 */
export function setCachedResults(keyword: string, results: any[]): void {
  searchCache.set(keyword, {
    results,
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
  })

  // 清理过期缓存
  if (searchCache.size > 100) {
    const now = Date.now()
    for (const [key, entry] of searchCache) {
      if (entry.expiresAt < now) {
        searchCache.delete(key)
      }
    }
  }
}

// ── 处理锁操作 ──

/**
 * 检查是否有正在进行的搜索
 */
export function isProcessing(keyword: string): boolean {
  const lock = processingLocks.get(keyword)
  if (!lock) return false

  // 检查是否超时
  if (Date.now() - lock.startTime > PROCESSING_LOCK_TIMEOUT_MS) {
    processingLocks.delete(keyword)
    return false
  }

  return true
}

/**
 * 获取正在进行的搜索结果（等待完成）
 */
export async function waitForResults(keyword: string, timeoutMs: number = 60000): Promise<any[] | null> {
  const lock = processingLocks.get(keyword)
  if (!lock) return null

  const startTime = Date.now()

  // 等待锁释放或超时
  while (processingLocks.has(keyword)) {
    if (Date.now() - startTime > timeoutMs) {
      log.warn(`[Concurrency] Timeout waiting for "${keyword}"`)
      return null
    }

    // 暂停1秒后重试（与xinyue-search一致）
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  // 返回缓存的结果
  return getCachedResults(keyword)
}

/**
 * 设置处理锁
 */
export function setProcessingLock(keyword: string, promise: Promise<any[]>): void {
  processingLocks.set(keyword, {
    promise,
    startTime: Date.now(),
  })
}

/**
 * 释放处理锁
 */
export function releaseProcessingLock(keyword: string): void {
  processingLocks.delete(keyword)
}

/**
 * 执行带并发控制的搜索
 * 与 xinyue-search 的 all_search 逻辑一致
 */
export async function executeWithConcurrency<T>(
  keyword: string,
  searchFn: () => Promise<T[]>
): Promise<T[]> {
  // 1. 检查缓存
  const cached = getCachedResults(keyword)
  if (cached) {
    return cached as T[]
  }

  // 2. 检查是否有正在进行的请求
  if (isProcessing(keyword)) {
    log.info(`[Concurrency] Waiting for ongoing search: "${keyword}"`)
    const results = await waitForResults(keyword)
    if (results) {
      return results as T[]
    }
  }

  // 3. 设置处理锁
  const searchPromise = searchFn()
  setProcessingLock(keyword, searchPromise as Promise<any[]>)

  try {
    // 4. 执行搜索
    const results = await searchPromise

    // 5. 缓存结果
    setCachedResults(keyword, results)

    return results
  } finally {
    // 6. 释放处理锁
    releaseProcessingLock(keyword)
  }
}

// ── 频率限制 ──

/**
 * 检查请求是否被频率限制
 * 与 xinyue-search 的 IP 频率限制逻辑一致
 */
export function isRateLimited(clientId: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(clientId)

  if (!entry) {
    // 首次请求
    rateLimitMap.set(clientId, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    })
    return false
  }

  // 检查是否在限制窗口内
  if (now < entry.resetAt) {
    if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
      log.warn(`[Concurrency] Rate limited: ${clientId}`)
      return true
    }
    entry.count++
    return false
  }

  // 窗口已过期，重置
  rateLimitMap.set(clientId, {
    count: 1,
    resetAt: now + RATE_LIMIT_WINDOW_MS,
  })
  return false
}

/**
 * 获取频率限制剩余时间（秒）
 */
export function getRateLimitResetSeconds(clientId: string): number {
  const entry = rateLimitMap.get(clientId)
  if (!entry) return 0

  const remaining = entry.resetAt - Date.now()
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

/**
 * 清理过期的频率限制记录
 */
export function cleanupRateLimits(): void {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (entry.resetAt < now) {
      rateLimitMap.delete(key)
    }
  }
}

// 定期清理（每分钟）
setInterval(cleanupRateLimits, 60 * 1000)
