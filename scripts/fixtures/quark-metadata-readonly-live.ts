import { app, session } from 'electron'
import Database from 'better-sqlite3'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log'
import { decryptCredential } from '../../src/main/crypto'
import { quarkAdapter } from '../../src/adapters/quark'
import { scanSubscription, planSubscription } from '../../src/main/subscription-recursive'
import { AccountRequestBudget } from '../../src/main/account-request-budget'
import { configureRequestSettings, getRequestSettings } from '../../src/main/request-settings'
import type { DriveAccount, FileItem } from '../../src/shared/types'
import type { ShareSubscription, SubscriptionEntry } from '../../src/shared/subscription-types'

// This driver deliberately imports no application startup, scheduler, database
// initializer, preview service or BrowserWindow. Every provider response is live.
const profile = process.env.PANLITE_READONLY_PROFILE!
const output = process.env.PANLITE_READONLY_OUTPUT!
const databasePath = process.env.PANLITE_READONLY_DATABASE!
const nativeBinding = process.env.PANLITE_READONLY_NATIVE!
if (!profile || !output || !databasePath || !nativeBinding) throw new Error('Isolated acceptance paths required')
app.setPath('userData', profile)
app.setPath('sessionData', profile)
log.transports.console.level = false
log.transports.file.level = false
const salt = randomBytes(32)
const redactId = (value: string) => createHmac('sha256', salt).update(value).digest('hex').slice(0, 16)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const continueShares = process.argv.includes('--continue-shares')
const previous = continueShares ? JSON.parse(readFileSync(join(output, 'quark-readonly-report.json'), 'utf8')) : undefined
const report: Record<string, any> = {
  startedAt: new Date().toISOString(), runtime: process.versions,
  execution: 'Real production Quark adapter; live provider responses; no provider mocks or request rewriting',
  safety: { databaseReadOnly: true, databaseInitialized: false, taskSchedulerStarted: false,
    cloudWritesAllowed: false, fileContentRequestsAllowed: false, windowsCreated: 0, isolatedCredentialRefresh: true },
  limits: { perPartRequests: 20, perPartMilliseconds: 90_000 },
  ...(previous || {}),
  ...(continueShares ? { continuedAt: new Date().toISOString() } : {}),
}
const save = () => writeFileSync(join(output, 'quark-readonly-report.json'), JSON.stringify(report, null, 2))
const safeFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : ''
  if (/登录|认证|401|403|41001/.test(message)) return 'authentication-required'
  if (/验证码|captcha/i.test(message)) return 'captcha-required'
  if (/提取码|41012/.test(message)) return 'share-password-rejected'
  if (/分享已失效|41014/.test(message)) return 'share-expired'
  if (/budget/.test(message)) return 'request-budget-reached'
  if (/deadline|abort|timeout/i.test(message)) return 'time-budget-reached'
  if (/层级|目录数量|数量超过/.test(message)) return 'scan-size-limit-reached'
  if (/循环|重复|同名|完整|分页|无效名称/.test(message)) return 'directory-consistency-rejected'
  return 'provider-or-local-operation-failed'
}
interface Candidate { url: string; password?: string; platform: string; accountId: string; updatedAt: number; source: string }
interface Part { startedAt: number; requests: number; phase: string; controller: AbortController; audit: Array<Record<string, unknown>>; blocked: number }
let part: Part | undefined
let timer: ReturnType<typeof setTimeout> | undefined
const startPart = (key: string) => {
  const prior = continueShares ? previous?.[key] : undefined
  part = { startedAt: Date.now() - (prior?.elapsedMs || 0), requests: prior?.requestsUsed || 0, phase: key,
    controller: new AbortController(), audit: prior?.requests || [], blocked: prior?.blockedRequests || 0 }
  report[key] = { ...prior, status: 'running', requests: part.audit }
  timer = setTimeout(() => {
    part!.controller.abort(new Error('deadline'))
    report[key].status = 'time-budget-reached'
    report[key].requestsUsed = part!.requests
    report.finishedAt = new Date().toISOString()
    save()
    app.exit(2)
  }, 90_000 - (prior?.elapsedMs || 0))
}
const endPart = (key: string) => {
  clearTimeout(timer)
  report[key].requestsUsed = part!.requests
  report[key].blockedRequests = part!.blocked
  report[key].elapsedMs = Date.now() - part!.startedAt
  part = undefined
  save()
}
const check = () => {
  if (!part) throw new Error('No authorized network phase')
  part.controller.signal.throwIfAborted()
  if (Date.now() - part.startedAt >= 90_000) throw new Error('deadline')
}
const hashFile = () => createHash('sha256').update(readFileSync(databasePath)).digest('hex')

app.whenReady().then(async () => {
  let beforeDatabase = ''
  try {
    beforeDatabase = hashFile()
    const db = new Database(databasePath, { readonly: true, fileMustExist: true, nativeBinding })
    let account: DriveAccount
    const candidates: Candidate[] = []
    try {
      db.pragma('query_only = ON')
      const row = db.prepare("SELECT * FROM accounts WHERE platform='quark' ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END,updated_at DESC LIMIT 1").get() as any
      if (!row) { report.account = { status: 'no-configured-quark-account' }; save(); return }
      account = { id: row.id, platform: 'quark', nickname: row.nickname, loginType: row.login_type,
        credential: JSON.parse(decryptCredential(row.encrypted_credential)), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }
      report.account = { platform: 'quark', reference: redactId(row.id), storedStatus: row.status, credentialAvailable: Boolean(account.credential.cookies) }
      if (!account.credential.cookies) throw new Error('Missing account credential')
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name))
      const sources: Array<Record<string, unknown>> = []
      const collect = (source: string, rows: Array<any>) => {
        const selected = rows.filter(row => ['quark', 'uc'].includes(row.platform))
        sources.push({ source, rowsInspected: rows.length, quark: selected.filter(row => row.platform === 'quark').length,
          uc: selected.filter(row => row.platform === 'uc').length })
        for (const row of selected) if (typeof row.url === 'string') candidates.push({ url: row.url, password: row.password || '',
          platform: row.platform, accountId: row.accountId || row.account_id, updatedAt: Number(row.updatedAt || row.updated_at) || 0, source })
      }
      if (tables.has('subscription_configs')) collect('subscription_configs',
        (db.prepare('SELECT data FROM subscription_configs ORDER BY rowid DESC LIMIT 1000').all() as Array<{ data: string }>).flatMap(row => {
          try { return [JSON.parse(row.data)] } catch { return [] }
        }))
      if (tables.has('share_subscriptions')) collect('share_subscriptions', db.prepare("SELECT account_id,platform,url,password,updated_at FROM share_subscriptions WHERE platform IN ('quark','uc') ORDER BY updated_at DESC LIMIT 1000").all())
      if (tables.has('share_links')) collect('share_links', db.prepare("SELECT account_id,platform,share_url AS url,password,updated_at FROM share_links WHERE platform IN ('quark','uc') AND status='active' AND (expired_at IS NULL OR expired_at=0 OR expired_at>?) ORDER BY updated_at DESC LIMIT 1000").all(Date.now()))
      if (tables.has('transfer_records')) collect('transfer_records', db.prepare("SELECT account_id,platform,source_url AS url,password,updated_at FROM transfer_records WHERE platform IN ('quark','uc') AND status='success' ORDER BY updated_at DESC LIMIT 1000").all())
      report.savedShareInventory = { sources, queryLimitPerSource: 1000, originalDatabaseReadOnly: db.readonly }
      if (tables.has('settings')) {
        const settings = db.prepare("SELECT key,value FROM settings WHERE key IN ('quarkPageSize','requestDelayMs') AND encrypted=0").all() as Array<{ key: string; value: string }>
        for (const row of settings) try { configureRequestSettings({ [row.key]: row.value }) } catch {}
      }
      report.requestSettings = getRequestSettings()
    } finally { db.close() }

    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }))
    const ses = session.fromPartition('persist:quark')
    const originalFetch = ses.fetch.bind(ses)
    let listTemplate: { url: string; init?: RequestInit } | undefined
    const allowed = (url: URL, method: string) => url.protocol === 'https:' && url.hostname === 'drive-pc.quark.cn'
      && ((part?.phase.startsWith('metadata') && method === 'GET' && url.pathname === '/1/clouddrive/file/sort')
        || (part?.phase.startsWith('share') && ((['POST', 'OPTIONS'].includes(method) && url.pathname === '/1/clouddrive/share/sharepage/token')
          || (['GET', 'OPTIONS'].includes(method) && url.pathname === '/1/clouddrive/share/sharepage/detail'))))
    ses.webRequest.onBeforeRequest((details, callback) => {
      const permitted = part && !part.controller.signal.aborted && Date.now() - part.startedAt < 90_000
        && part.requests < 20 && allowed(new URL(details.url), details.method)
      if (permitted) part!.requests++
      else if (part) part.blocked++
      callback({ cancel: !permitted })
    })
    // Observe response metadata only. Forward the unmodified production request
    // and response; an AbortSignal only imposes the acceptance time limit.
    ses.fetch = async (input, init) => {
      check()
      if (part!.requests >= 20) throw new Error('request budget reached')
      if (typeof input !== 'string') throw new Error('Unexpected request shape')
      const url = new URL(input)
      const method = init?.method || 'GET'
      if (!allowed(url, method)) throw new Error('Blocked non-readonly API')
      if (part!.phase === 'metadata-verify-first-page' && url.pathname === '/1/clouddrive/file/sort') listTemplate = { url: input, init }
      const audit: Record<string, unknown> = { phase: part!.phase, operation: url.pathname, method,
        parent: url.searchParams.has('pdir_fid') ? redactId(url.searchParams.get('pdir_fid')!) : undefined,
        page: Number(url.searchParams.get('_page')) || undefined, pageSize: Number(url.searchParams.get('_size')) || undefined }
      part!.audit.push(audit)
      try {
        const response = await originalFetch(input, { ...init, signal: part!.controller.signal })
        audit.httpStatus = response.status
        const json = await response.clone().json().catch(() => undefined)
        audit.businessCode = typeof json?.code === 'number' ? json.code : undefined
        audit.itemCount = Array.isArray(json?.data?.list) ? json.data.list.length : undefined
        audit.providerTotal = typeof json?.metadata?._total === 'number' ? json.metadata._total : undefined
        return response
      } catch (error) { audit.failure = safeFailure(error); throw error }
      finally { save() }
    }

    if (continueShares && process.argv.includes('--verify-second-page')) {
      startPart('metadata')
      part!.phase = 'metadata-verify-first-page'
      try {
        const saved = JSON.parse(readFileSync(process.env.PANLITE_READONLY_PREVIOUS_METADATA!, 'utf8'))
        const fullPages = saved.folders.filter((folder: any) => folder.entries === 200 && typeof folder.directory?.id === 'string')
        if (fullPages.length !== 1) throw new Error('Ambiguous previous directory sample')
        const first = await quarkAdapter.listFiles(account!, fullPages[0].directory.id)
        const firstDigest = digest(first.files.map(file => [file.id, file.parentId, file.name, file.isDir, file.size]).sort())
        if (!previous.metadata.folders.some((folder: any) => folder.entries === 200 && folder.metadataDigest === firstDigest) || !listTemplate) throw new Error('Previous directory sample changed')
        part!.phase = 'metadata-verify-second-page'
        const nextPage = new URL(listTemplate.url)
        nextPage.searchParams.set('_page', '2')
        const response = await ses.fetch(nextPage.href, listTemplate.init)
        const json = await response.json()
        if (!response.ok || json?.code !== 0 || !Array.isArray(json?.data?.list)) throw new Error('Second page response invalid')
        const ids = new Set(first.files.map(file => file.id))
        const secondIds = json.data.list.map((file: any) => String(file.fid || ''))
        const evidence = { firstPageMatchesEarlierLiveDigest: true, firstPageItems: first.files.length,
          firstPageAdapterReportedComplete: first.hasMore === false, secondPageItems: secondIds.length,
          secondPageDistinctNewIds: secondIds.filter((id: string) => id && !ids.has(id)).length,
          secondPageAllIdsUnique: new Set(secondIds).size === secondIds.length,
          secondPageProviderTotal: typeof json.metadata?._total === 'number' ? json.metadata._total : undefined,
          method: 'Direct live page 2 from captured production request; only _page changed; responses unmodified',
          entireDirectoryCovered: secondIds.length < 200 }
        report.metadata.secondPageVerification = evidence
        report.metadata.status = secondIds.length > 0 ? 'failed-premature-pagination-stop' : 'passed-single-full-page-directory'
        report.metadata.multiPageObserved = true
        report.metadata.findings = secondIds.length > 0 ? [{ issue: 'Production adapter returned complete after 200 items while real page 2 contains additional entries',
          severity: 'confirmed-pagination-bug', firstPageItems: 200, missedObservedItems: evidence.secondPageDistinctNewIds }] : []
      } catch (error) {
        report.metadata.status = 'pagination-completeness-unverified'
        report.metadata.secondPageVerification = { failure: safeFailure(error) }
      } finally { endPart('metadata') }
    }

    let rootSuccess = continueShares && previous?.metadata?.folders?.some((folder: any) => folder.depth === 0 && folder.complete)
    if (!continueShares) {
    startPart('metadata')
    const folders: Array<Record<string, unknown>> = []
    const extensions: Record<string, number> = {}
    report.metadata.folders = folders
    report.metadata.extensionCounts = extensions
    try {
      const seen = new Set<string>()
      const queue = [{ id: '0', depth: 0 }]
      while (queue.length && part!.requests < 20) {
        check()
        const next = queue.shift()!
        const listed = await quarkAdapter.listFiles(account!, next.id)
        if (listed.hasMore !== false || listed.files.some(file => file.accountId !== account!.id || file.platform !== 'quark' || file.parentId !== next.id)) throw new Error('目录完整性或账号范围错误')
        for (const file of listed.files) {
          if (seen.has(file.id)) throw new Error('目录重复 ID')
          seen.add(file.id)
          if (!file.isDir) {
            const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : ''
            if (/^[a-z0-9]{1,8}$/.test(ext)) extensions[ext] = (extensions[ext] || 0) + 1
          }
        }
        folders.push({ parent: redactId(next.id), depth: next.depth, entries: listed.files.length,
          directories: listed.files.filter(file => file.isDir).length, complete: true,
          metadataDigest: digest(listed.files.map((file: FileItem) => [file.id, file.parentId, file.name, file.isDir, file.size]).sort()) })
        if (next.id === '0') rootSuccess = true
        if (next.depth < 2) {
          const maximum = next.depth === 0 ? 5 : Math.max(0, 20 - queue.length)
          for (const file of listed.files.filter(file => file.isDir).slice(0, maximum)) queue.push({ id: file.id, depth: next.depth + 1 })
        }
        report.metadata.remainingQueuedDirectories = queue.length
        save()
      }
      report.metadata.status = 'passed'
      report.metadata.uniqueEntries = seen.size
      report.metadata.scope = 'Root and sampled first five root folders, at most two nested levels; not a whole-drive inventory'
      report.metadata.multiPageObserved = part!.audit.some(item => Number(item.page) > 1)
      const uncertain = part!.audit.filter(item => Number(item.itemCount) >= Number(item.pageSize) && Number(item.providerTotal) < Number(item.itemCount))
      if (uncertain.length) {
        report.metadata.status = 'pagination-completeness-unverified'
        report.metadata.findings = [{ issue: 'Provider returned a full page with _total=0; production adapter stopped after page 1',
          affectedDirectories: uncertain.map(item => item.parent), severity: 'requires-second-page-verification' }]
      }
    } catch (error) { report.metadata.status = safeFailure(error) }
    finally { endPart('metadata') }
    }

    const candidate = candidates.filter(item => item.platform === 'quark' && item.accountId === account!.id
      && /^https:\/\/pan\.quark\.cn\/s\/[a-zA-Z0-9]+(?:[/?#]|$)/.test(item.url)).sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (!candidate) {
      report.recursiveShare = { status: 'not-covered', reason: 'No saved usable Quark share URL for the selected configured account; no share created' }
    } else if (!rootSuccess || ['authentication-required', 'captcha-required'].includes(report.metadata.status)) {
      report.recursiveShare = { status: 'not-covered', reason: 'Account root listing did not complete; no additional authentication or captcha attempts made' }
    } else {
      startPart('recursiveShare')
      part!.phase = 'share-first-scan'
      report.recursiveShare.source = candidate.source
      report.recursiveShare.shareReference = redactId(candidate.url)
      report.recursiveShare.scope = { maxDepth: 8, maxDirectories: 20, maxEntries: 2000, scans: 2, sharedTotalRequestBudget: 20 }
      try {
        const config: ShareSubscription = { id: 'readonly-acceptance', configVersion: 1, accountId: account!.id, platform: 'quark',
          url: candidate.url, password: candidate.password || '', targetDirId: '0', scope: 'recursive', initialMode: 'baseline',
          includeKeywords: [], excludeKeywords: [], extensions: [], preserveStructure: true, detectChanges: true,
          status: 'active', baselineComplete: false, lastError: '', failureCount: 0, nextCheckAt: 0, createdAt: Date.now(), updatedAt: Date.now() }
        const budget = new AccountRequestBudget(1)
        const options = { signal: part!.controller.signal, assertCurrent: check, maxDepth: 8, maxDirectories: 20, maxEntries: 2000,
          request: <T>(id: string, operation: () => Promise<T>, signal?: AbortSignal) => budget.run(id, 'background', operation, signal) }
        const first = await scanSubscription(config, account!, quarkAdapter, options)
        const normalize = (entries: SubscriptionEntry[]) => entries.map(entry => [entry.fileId, entry.parentId, entry.relativePath, entry.isDir, entry.size ?? null, entry.contentHash ?? null]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))
        const firstDigest = digest(normalize(first))
        report.recursiveShare.firstScan = { entries: first.length, directories: first.filter(item => item.isDir).length,
          nestedEntries: first.filter(item => item.parentId !== '0').length, digest: firstDigest, complete: true }
        const baselineWork = planSubscription(config, first, [])
        part!.phase = 'share-second-scan'
        const second = await scanSubscription({ ...config, baselineComplete: true }, account!, quarkAdapter, options)
        const secondDigest = digest(normalize(second))
        const followupWork = planSubscription({ ...config, baselineComplete: true }, second, first)
        report.recursiveShare.secondScan = { entries: second.length, digest: secondDigest, complete: true }
        report.recursiveShare.checks = { metadataStable: firstDigest === secondDigest, initialBaselineWork: baselineWork.length,
          repeatedScanWork: followupWork.length, nestedDirectoryObserved: first.some(item => item.parentId !== '0'),
          multiPageObserved: part!.audit.some(item => Number(item.page) > 1) }
        report.recursiveShare.status = firstDigest === secondDigest && baselineWork.length === 0 && followupWork.length === 0 ? 'passed' : 'changed-during-scan-or-idempotence-failed'
        report.recursiveShare.limitations = 'Repeated live metadata agreement is not an independent provider checksum; no remote mutation or transfer execution tested'
      } catch (error) { report.recursiveShare.status = safeFailure(error) }
      finally { endPart('recursiveShare') }
    }
  } catch (error) { report.failure = safeFailure(error) }
  finally {
    clearTimeout(timer)
    report.safety.originalDatabaseMainFileUnchanged = Boolean(beforeDatabase && beforeDatabase === hashFile())
    report.finishedAt = new Date().toISOString()
    save()
    app.exit(report.failure ? 1 : 0)
  }
}).catch(() => { report.failure = 'electron-initialization-failed'; save(); app.exit(1) })
