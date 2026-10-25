import { app, BrowserWindow, net, protocol, session } from 'electron'
import Database from 'better-sqlite3'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import log from 'electron-log'
import { decryptCredential } from '../../src/main/crypto'
import { quarkAdapter } from '../../src/adapters/quark'
import { FilePreviewService } from '../../src/main/file-preview'
import { downloadPreviewSource } from '../../src/main/preview-download'
import { verifyHiddenMedia, verifyHiddenImage, verifyHiddenPdf } from '../hidden-media-acceptance'
import type { PreviewSource } from '../../src/main/preview-stream'
import type { DriveAccount, FileItem } from '../../src/shared/types'
// Bundled by the standalone driver; never imported into the application.
import { runReadOnlyPreviewProbe } from '../readonly-preview-probe.mjs'

const ACCOUNT_ID = 'caa8b863-d548-4233-86c8-4d2dfe28ad98'
const DATABASE = 'C:/Users/27199/AppData/Roaming/panlite/panlite.db'
const NATIVE = 'D:/27199/Documents/PanLite/release-next-ocr-20260909/verified/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
const profile = process.env.PANLITE_QUARK_LIVE_PROFILE
const output = process.env.PANLITE_QUARK_LIVE_OUTPUT
if (!profile || !output) throw new Error('Isolated paths are required')
app.setPath('userData', profile)
app.setPath('sessionData', profile)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
log.transports.console.level = false
log.transports.file.level = false
protocol.registerSchemesAsPrivileged([{ scheme: 'panlite-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
let phase = 'start'
const safeFile = (file: FileItem) => ({ id: file.id, parentId: file.parentId, name: file.name, size: file.size, isDir: file.isDir, updatedAt: file.updatedAt })
const save = (name: string, value: unknown) => writeFileSync(join(output!, name), JSON.stringify(value, null, 2))

app.whenReady().then(async () => {
  mkdirSync(output!, { recursive: true })
  let service: FilePreviewService | undefined
  const allowedRequests: Array<{ operation: string; method: string }> = []
  const apiResponses: Array<{ operation: string; status: number }> = []
  const blockedRequests: Array<{ host: string; method: string }> = []
  const streamRequests: Array<Record<string, unknown>> = []
  const resolvedContentHosts = new Set<string>()
  const sourceShapes: Array<Record<string, unknown>> = []
  const cookieEvidence: Array<Record<string, unknown>> = []
  const productionCookies = process.argv.includes('--diagnostics')
  const responseCookieRefresh = new Map<string, string>()
  let metadataRequests = process.argv.includes('--fallback-samples') ? 6 : 0
  let cloudBodyBytes = 0
  const cloudBodyBudget = 16 * 1024 * 1024
  let hiddenWindowsCreated = 0
  const mediaOnly = process.argv.includes('--media-only')
  const boundedAcceptance = process.argv.includes('--full-acceptance') || mediaOnly
  const searchQDiagnostic = process.argv.includes('--search-q-test')
  const searchGetDiagnostic = process.argv.includes('--search-get-test') || searchQDiagnostic
  const searchGetEvidence: Array<Record<string, unknown>> = []
  const productionSearchSamples = process.argv.includes('--production-search-samples')
  try {
    phase = 'read-authorized-account'
    const db = new Database(DATABASE, { readonly: true, fileMustExist: true, nativeBinding: NATIVE })
    let row: any
    try {
      row = db.prepare('SELECT id, platform, nickname, login_type, encrypted_credential, status, created_at, updated_at FROM accounts WHERE id = ? AND platform = ?').get(ACCOUNT_ID, 'quark')
    } finally { db.close() }
    if (!row || row.id !== ACCOUNT_ID || row.platform !== 'quark' || !row.nickname?.startsWith('飞快')) throw new Error('Account scope mismatch')
    phase = 'decrypt-in-memory'
    const account: DriveAccount = { id: row.id, platform: 'quark', nickname: row.nickname, loginType: row.login_type,
      credential: JSON.parse(decryptCredential(row.encrypted_credential)), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }
    row = undefined
    if (!account.credential.cookies) throw new Error('Missing credential')
    // Fail closed if a read-only adapter path unexpectedly dispatches any other API.
    const quarkSession = session.fromPartition('persist:quark')
    const originalSessionFetch = quarkSession.fetch.bind(quarkSession)
    let productionSearchTemplate: { url: string; init?: RequestInit } | undefined
    if (productionSearchSamples) {
      quarkSession.fetch = async (input, init) => {
        if (typeof input === 'string' && new URL(input).pathname === '/1/clouddrive/file/search') {
          productionSearchTemplate = { url: input, init }
        }
        return originalSessionFetch(input, init)
      }
    }
    if (searchGetDiagnostic) {
      let requests = 0
      quarkSession.fetch = async (input, init) => {
        if (typeof input !== 'string' || new URL(input).pathname !== '/1/clouddrive/file/search' || requests++ >= (searchQDiagnostic ? 2 : 1)) throw new Error('Search diagnostic request limit reached')
        const url = new URL(input)
        const values = JSON.parse(String(init?.body || '{}'))
        for (const [key, value] of Object.entries(values)) url.searchParams.set(searchQDiagnostic && key === 'keyword' ? 'q' : key, String(value))
        url.searchParams.set('_size', '20')
        if (searchQDiagnostic) url.searchParams.set('_fetch_total', 'true')
        const response = await originalSessionFetch(url.href, { ...init, method: 'GET', body: undefined })
        const json = await response.clone().json().catch(() => undefined)
        searchGetEvidence.push({ method: 'GET', status: response.status, ...(typeof json?.code === 'number' ? { code: json.code } : {}),
          responseItemCount: Array.isArray(json?.data?.list) ? json.data.list.length : null })
        return response
      }
    }
    if (productionCookies) {
      quarkSession.fetch = async (input, init) => {
        const response = await originalSessionFetch(input, init)
        if (typeof input === 'string' && new URL(input).pathname === '/1/clouddrive/file/download') {
          const clone = response.clone()
          const reader = clone.body?.getReader()
          try {
            const chunks: Uint8Array[] = []
            let size = 0
            if (reader) for (;;) {
              const chunk = await reader.read()
              if (chunk.done) break
              size += chunk.value.length
              if (size > 32768) break
              chunks.push(chunk.value)
            }
            if (size <= 32768) {
              const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              const safeKeys = (object: unknown) => object && typeof object === 'object' ? Object.keys(object).filter(key => /^[A-Za-z_][\w.-]{0,63}$/.test(key)).slice(0, 32) : []
              const item = Array.isArray(json.data) ? json.data[0] : json.data
              sourceShapes.push({ responseKeys: safeKeys(json), itemKeys: safeKeys(item),
                headerFieldNames: ['headers', 'header', 'request_headers', 'download_headers'].flatMap(key => safeKeys(item?.[key])) })
            }
          } catch { sourceShapes.push({ metadataShapeUnavailable: true }) }
          finally { void reader?.cancel().catch(() => undefined) }
        }
        return response
      }
      quarkSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const url = new URL(details.url)
        const cookieKey = Object.keys(details.requestHeaders).find(key => key.toLowerCase() === 'cookie')
        const sent = cookieKey ? details.requestHeaders[cookieKey] : undefined
        cookieEvidence.push({ phase: 'request', operation: url.hostname === 'drive-pc.quark.cn' ? url.pathname : 'resolved-content',
          cookieHeaderPresent: Boolean(sent), exactlyMatchesAccountCookie: sent === account.credential.cookies })
        callback({ requestHeaders: details.requestHeaders })
      })
    }
    quarkSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const operation = url.pathname
      const apiAllowed = url.protocol === 'https:' && url.hostname === 'drive-pc.quark.cn'
        && ((details.method === 'GET' && (operation === '/1/clouddrive/file/sort' || ((searchGetDiagnostic || productionSearchSamples) && operation === '/1/clouddrive/file/search')))
          || (['POST', 'OPTIONS'].includes(details.method) && ['/1/clouddrive/file/download', '/1/clouddrive/file/search'].includes(operation)))
      const contentAllowed = ['http:', 'https:'].includes(url.protocol) && resolvedContentHosts.has(url.hostname)
        && ['GET', 'HEAD', 'OPTIONS'].includes(details.method)
      const allowed = apiAllowed || contentAllowed
      if ((process.argv.includes('--metadata') || process.argv.includes('--extra-samples') || process.argv.includes('--fallback-samples')) && apiAllowed && details.method !== 'OPTIONS') {
        if (metadataRequests >= (process.argv.includes('--metadata') ? 20 : 10)) { callback({ cancel: true }); return }
        metadataRequests++
      }
      if (allowed) allowedRequests.push({ operation: apiAllowed ? operation : 'resolved-content', method: details.method })
      else blockedRequests.push({ host: url.hostname, method: details.method })
      callback({ cancel: !allowed })
    })
    // Keep production response-cookie behavior inside this disposable profile.
    quarkSession.webRequest.onHeadersReceived((details, callback) => {
      const responseUrl = new URL(details.url)
      apiResponses.push({ operation: responseUrl.hostname === 'drive-pc.quark.cn' ? responseUrl.pathname : 'resolved-content', status: details.statusCode })
      const headers = { ...details.responseHeaders }
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'set-cookie') {
        const existing = new Map((account.credential.cookies || '').split(';').map(pair => { const index = pair.indexOf('='); return [pair.slice(0, index).trim(), pair.slice(index + 1)] }))
        const pairs = headers[key].map(value => value.split(';')[0]).map(pair => { const index = pair.indexOf('='); return [pair.slice(0, index).trim(), pair.slice(index + 1)] })
        if (productionCookies && responseUrl.hostname === 'drive-pc.quark.cn') {
          for (const [name, value] of pairs) if (existing.has(name)) responseCookieRefresh.set(name, value)
        }
        cookieEvidence.push({ phase: 'response', setCookiePresent: true, names: pairs.map(pair => pair[0]).filter(name => /^[\w.-]{1,64}$/.test(name)),
          introducesCookieName: pairs.some(([name]) => !existing.has(name)), existingCookieValueChanged: pairs.some(([name, value]) => existing.has(name) && existing.get(name) !== value),
          attributes: headers[key].map(value => {
            const attributes = new Map(value.split(';').slice(1).map(part => { const index = part.indexOf('='); return [part.slice(0, index < 0 ? undefined : index).trim().toLowerCase(), index < 0 ? '' : part.slice(index + 1).trim()] }))
            const domain = attributes.get('domain'), cookiePath = attributes.get('path'), maxAge = attributes.get('max-age'), expires = attributes.get('expires')
            return { ...(domain && /^\.?[\w.-]+\.cn$/.test(domain) ? { domain } : {}), ...(cookiePath === '/' ? { path: '/' } : {}),
              ...(maxAge && /^-?\d{1,12}$/.test(maxAge) ? { maxAgeSeconds: Number(maxAge) } : {}),
              ...(expires && Number.isFinite(Date.parse(expires)) ? { expires: new Date(expires).toISOString() } : {}),
              secure: attributes.has('secure'), httpOnly: attributes.has('httponly') }
          }),
          retainedInIsolatedSession: true })
      }
      callback({ responseHeaders: headers })
    })
    if (productionSearchSamples) {
      phase = 'production-search-and-samples'
      const known = await quarkAdapter.searchFiles(account, '夸克网盘使用指南')
      const accuracy = { total: known.length, knownPdfFound: known.some(file => file.id === '359b4abaeeee4157b429941b560ea0d0'),
        knownPngFound: known.some(file => file.id === 'f2b453c691094075b2d5bbf976d5a458') }
      if (accuracy.total !== 2 || !accuracy.knownPdfFound || !accuracy.knownPngFound) throw new Error('Production search failed known-file accuracy check')
      const searches: Array<Record<string, unknown>> = []
      const downloads: Array<Record<string, unknown>> = []
      let downloadedBytes = 0
      const download = async (file: FileItem) => {
        if (file.accountId !== ACCOUNT_ID || file.isDir || file.size <= 0 || file.size > 10 * 1024 * 1024 || downloadedBytes + file.size > 30 * 1024 * 1024) return
        const extension = file.name.split('.').pop()!.toLowerCase()
        const evidence: Record<string, unknown> = { extension, file: safeFile(file), maxBytes: Math.min(10 * 1024 * 1024, 30 * 1024 * 1024 - downloadedBytes) }
        downloads.push(evidence)
        try {
          const source = await quarkAdapter.getDownloadSource(account, file.id)
          const fileName = `authorized-sample-${extension}.${extension}`
          const result = await downloadPreviewSource(source, { directory: output!, fileName, maxBytes: Number(evidence.maxBytes) })
          evidence.success = result.success
          if (result.success && result.localPath) {
            const bytes = readFileSync(result.localPath)
            downloadedBytes += bytes.length
            evidence.bytes = bytes.length; evidence.savedFile = fileName; evidence.sizeMatches = bytes.length === file.size
            evidence.sha256 = createHash('sha256').update(bytes).digest('hex')
          }
        } catch { evidence.success = false }
        save('production-search-samples.json', { knownQueryAccuracy: accuracy, searches, downloads, downloadedBytes, time: new Date().toISOString() })
      }
      await download({ id: 'b969e53914ec43529044a05dc050a096', parentId: '6786839753a540d88256109ee346a1e8', name: '2022年6月英语六级真题第三套.docx',
        size: 12517, isDir: false, platform: 'quark', accountId: ACCOUNT_ID, createdAt: 0, updatedAt: 1788775008256 })
      for (const extension of ['xlsx', 'pptx', 'txt', 'zip', 'srt']) {
        try {
          if (!productionSearchTemplate) throw new Error('No validated production search request')
          const url = new URL(productionSearchTemplate.url)
          if ((productionSearchTemplate.init?.method || 'GET') !== 'GET' || !url.searchParams.has('q')) throw new Error('Expected production GET and q')
          url.searchParams.set('q', `.${extension}`); url.searchParams.set('_page', '1'); url.searchParams.set('_size', '20')
          const response = await originalSessionFetch(url.href, productionSearchTemplate.init)
          const json = await response.json()
          if (response.status !== 200 || json.code !== 0 || !Array.isArray(json.data?.list) || json.data.list.length > 20) throw new Error('Single search page invalid')
          const files: FileItem[] = json.data.list.map((file: { fid: string; pdir_fid: string; file_name: string; file?: boolean; file_type: number; dir: boolean; size: number; created_at: number; updated_at: number }) => ({
            id: file.fid, parentId: file.pdir_fid, name: file.file_name, isDir: typeof file.file === 'boolean' ? !file.file : file.file_type === 0 || file.dir === true,
            size: file.size || 0, createdAt: file.created_at, updatedAt: file.updated_at, platform: 'quark', accountId: ACCOUNT_ID,
          }))
          const candidate = files.filter(file => file.accountId === ACCOUNT_ID && !file.isDir && file.name.toLowerCase().endsWith(`.${extension}`)
            && file.size > 0 && file.size <= 10 * 1024 * 1024).sort((left, right) => left.size - right.size)[0]
          searches.push({ extension, responseCount: files.length, page: 1, pageSize: 20, scope: 'Sample discovery only; not the complete search result',
            ...(candidate ? { candidate: safeFile(candidate) } : {}) })
          if (candidate) await download(candidate)
        } catch { searches.push({ extension, failed: true }) }
      }
      save('production-search-samples.json', { knownQueryAccuracy: accuracy, searches, downloads, downloadedBytes, time: new Date().toISOString() })
      phase = 'complete'
      return
    }
    if (searchGetDiagnostic) {
      phase = 'single-get-search-diagnostic'
      const results: Array<Record<string, unknown>> = []
      for (const query of searchQDiagnostic ? ['夸克网盘使用指南', '.docx'] : ['.docx']) {
        const files = await quarkAdapter.searchFiles(account, query)
        if (files.some(file => file.accountId !== ACCOUNT_ID)) throw new Error('File scope mismatch')
        results.push({ query, resultCount: files.length,
          ...(query === '夸克网盘使用指南' ? { knownPdfFound: files.some(file => file.id === '359b4abaeeee4157b429941b560ea0d0'),
            knownPngFound: files.some(file => file.id === 'f2b453c691094075b2d5bbf976d5a458') } : {}),
          representativeFiles: files.filter(file => !file.isDir && (query !== '.docx' || /\.docx$/i.test(file.name)))
            .sort((left, right) => left.size - right.size).slice(0, 2).map(safeFile) })
      }
      save(searchQDiagnostic ? 'search-q-diagnostic.json' : 'search-get-diagnostic.json', { checks: searchGetEvidence, requestCount: searchGetEvidence.length, page: 1, pageSize: 20,
        scope: searchQDiagnostic ? 'At most two diagnostic GET calls using q; production request unchanged' : 'One diagnostic GET using keyword; production request unchanged',
        results, time: new Date().toISOString() })
      phase = 'complete'
      return
    }
    if (process.argv.includes('--fallback-samples')) {
      phase = 'fallback-word-directory'
      const queue = [{ id: '36b5f3167f564615acd2b38130b34552', depth: 0 }]
      const listings: Array<Record<string, unknown>> = []
      let candidate: FileItem | undefined
      while (queue.length && metadataRequests < 9 && !candidate) {
        const directory = queue.shift()!
        try {
          const result = await quarkAdapter.listFiles(account, directory.id)
          if (result.files.some(file => file.accountId !== ACCOUNT_ID)) throw new Error('File scope mismatch')
          listings.push({ directoryId: directory.id, depthBelowKnownWordDirectory: directory.depth, entries: result.files.length, complete: result.hasMore === false })
          candidate = result.files.filter(file => !file.isDir && /\.(?:docx?|xlsx?|pptx?|txt|zip)$/i.test(file.name) && file.size > 0 && file.size <= 10 * 1024 * 1024)
            .sort((left, right) => left.size - right.size)[0]
          if (directory.depth < 2) for (const file of result.files.filter(file => file.isDir).slice(0, 2)) queue.push({ id: file.id, depth: directory.depth + 1 })
        } catch { listings.push({ directoryId: directory.id, failed: true }) }
      }
      const downloads: Array<Record<string, unknown>> = []
      if (candidate && metadataRequests < 10) {
        const extension = candidate.name.split('.').pop()!.toLowerCase()
        const source = await quarkAdapter.getDownloadSource(account, candidate.id)
        const fileName = `authorized-sample-${extension}.${extension}`
        const result = await downloadPreviewSource(source, { directory: output!, fileName, maxBytes: 10 * 1024 * 1024 })
        const evidence: Record<string, unknown> = { file: safeFile(candidate), success: result.success, maxBytes: 10 * 1024 * 1024 }
        if (result.success && result.localPath) {
          const bytes = readFileSync(result.localPath)
          evidence.savedFile = fileName
          evidence.bytes = bytes.length
          evidence.sizeMatches = bytes.length === candidate.size
          evidence.sha256 = createHash('sha256').update(bytes).digest('hex')
        }
        downloads.push(evidence)
      }
      save('fallback-samples.json', { scope: 'Known Word directory and at most two nested levels; remaining four-call budget after the six-call extension-search attempt',
        listings, downloads, combinedApiRequestsUsed: metadataRequests, combinedApiRequestBudget: 10, time: new Date().toISOString() })
      phase = 'complete'
      return
    }
    phase = 'list-root'
    const root = await quarkAdapter.listFiles(account, '0')
    if (root.files.some(file => file.accountId !== ACCOUNT_ID || file.platform !== 'quark')) throw new Error('File scope mismatch')
    const samples: Record<string, ReturnType<typeof safeFile>[]> = {}
    for (const file of root.files.filter(file => !file.isDir)) {
      const extension = file.name.split('.').pop()!.toLowerCase()
      if (['mp4', 'pdf', 'png', 'jpg', 'jpeg', 'mp3', 'txt', 'docx', 'xlsx', 'pptx'].includes(extension)) {
        const group = samples[extension] ||= []
        if (group.length < 2) group.push(safeFile(file))
      }
    }
    save('root-inventory.json', { account: { id: account.id, nickname: account.nickname, platform: account.platform },
      time: new Date().toISOString(), rootComplete: root.hasMore === false, totalEntries: root.files.length,
      directories: root.files.filter(file => file.isDir).slice(0, 5).map(safeFile), samples,
      scope: 'Real authorized root listing only; no file contents downloaded' })
    if (process.argv.includes('--extra-samples')) {
      phase = 'bounded-extension-search'
      const searches: Array<Record<string, unknown>> = []
      const candidates: Array<{ extension: string; file: FileItem }> = []
      for (const extension of ['docx', 'xlsx', 'pptx', 'txt', 'zip']) {
        if (metadataRequests >= 10) break
        try {
          const files = await quarkAdapter.searchFiles(account, `.${extension}`)
          if (files.some(file => file.accountId !== ACCOUNT_ID)) throw new Error('File scope mismatch')
          const suitable = files.filter(file => !file.isDir && file.name.toLowerCase().endsWith(`.${extension}`) && file.size > 0 && file.size <= 10 * 1024 * 1024)
            .sort((left, right) => left.size - right.size)
          const candidate = suitable[0]
          searches.push({ extension, resultCount: files.length, suitableCount: suitable.length, ...(candidate ? { candidate: safeFile(candidate) } : {}) })
          if (candidate) candidates.push({ extension, file: candidate })
        } catch { searches.push({ extension, failed: true, error: 'Search failed or request budget reached' }) }
      }
      phase = 'bounded-extra-downloads'
      let downloadedBytes = 0
      const downloads: Array<Record<string, unknown>> = []
      for (const { extension, file } of candidates) {
        if (metadataRequests >= 10 || downloadedBytes + file.size > 30 * 1024 * 1024) break
        const maxBytes = Math.min(10 * 1024 * 1024, 30 * 1024 * 1024 - downloadedBytes)
        const evidence: Record<string, unknown> = { extension, file: safeFile(file), maxBytes }
        try {
          const source = await quarkAdapter.getDownloadSource(account, file.id)
          const fileName = `authorized-sample-${extension}.${extension}`
          const result = await downloadPreviewSource(source, { directory: output!, fileName, maxBytes })
          evidence.success = result.success
          if (result.success && result.localPath) {
            const bytes = readFileSync(result.localPath)
            downloadedBytes += bytes.length
            evidence.savedFile = fileName
            evidence.bytes = bytes.length
            evidence.sizeMatches = bytes.length === file.size
            evidence.sha256 = createHash('sha256').update(bytes).digest('hex')
          }
        } catch { evidence.success = false }
        downloads.push(evidence)
        save('extra-samples.json', { searches, downloads, downloadedBytes, requestBudget: 10, apiRequestsUsed: metadataRequests,
          note: 'Business API calls counted including initial root listing; browser OPTIONS preflights are separately retained in request audit', time: new Date().toISOString() })
      }
      save('extra-samples.json', { searches, downloads, downloadedBytes, requestBudget: 10, apiRequestsUsed: metadataRequests,
        note: 'Business API calls counted including initial root listing; browser OPTIONS preflights are separately retained in request audit', time: new Date().toISOString() })
      phase = 'complete'
      return
    }
    if (process.argv.includes('--metadata')) {
      phase = 'bounded-metadata-sampling'
      const queue = root.files.filter(file => file.isDir).slice(0, 5).map(file => ({ file, depth: 1 }))
      const sampled: Record<string, ReturnType<typeof safeFile>[]> = {}
      const folders: Array<Record<string, unknown>> = []
      const wanted = new Set(['txt', 'md', 'csv', 'srt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', '7z', 'tar', 'mp3', 'mp4', 'png', 'jpg'])
      const takeSamples = (files: FileItem[]) => {
        for (const file of files) {
          if (file.accountId !== ACCOUNT_ID) throw new Error('File scope mismatch')
          if (file.isDir) continue
          const extension = file.name.split('.').pop()!.toLowerCase()
          if (!wanted.has(extension)) continue
          const group = sampled[extension] ||= []
          if (group.length < 2) group.push(safeFile(file))
        }
      }
      takeSamples(root.files)
      while (queue.length && metadataRequests < 20) {
        const next = queue.shift()!
        try {
          const listing = await quarkAdapter.listFiles(account, next.file.id)
          folders.push({ directory: safeFile(next.file), depth: next.depth, complete: listing.hasMore === false, entries: listing.files.length })
          takeSamples(listing.files)
          if (next.depth < 2) {
            for (const file of listing.files.filter(file => file.isDir).slice(0, Math.max(0, 20 - queue.length))) queue.push({ file, depth: next.depth + 1 })
          }
        } catch { folders.push({ directory: safeFile(next.file), depth: next.depth, complete: false, error: 'Listing failed or request budget reached' }) }
      }
      save('bounded-metadata-samples.json', { scope: 'Only authorized account; root plus at most two nested levels; no file contents read',
        requestBudget: 20, requestsUsed: metadataRequests, remainingQueuedDirectories: queue.length, folders, samples: sampled, time: new Date().toISOString() })
      phase = 'complete'
      return
    }
    if (process.argv.includes('--list-only')) return
    const getAuditedSource = async (file: FileItem): Promise<PreviewSource> => {
      const source = await quarkAdapter.getDownloadSource(account, file.id)
      resolvedContentHosts.add(new URL(source.url).hostname)
      return { ...source, fetch: async (url, init) => {
        const evidence: Record<string, unknown> = { extension: file.name.split('.').pop(), method: init.method || 'GET', range: new Headers(init.headers).get('range') }
        streamRequests.push(evidence)
        try {
          if (boundedAcceptance && cloudBodyBytes >= cloudBodyBudget && init.method !== 'HEAD') throw new Error('Acceptance byte budget reached')
          const response = await (source.fetch || fetch)(url, init)
          evidence.status = response.status
          if (boundedAcceptance && response.body && init.method !== 'HEAD' && [200, 206].includes(response.status)) {
            const reader = response.body.getReader()
            let bytes = 0
            const body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const part = await reader.read()
                  if (part.done) { controller.close(); return }
                  bytes += part.value.length
                  cloudBodyBytes += part.value.length
                  evidence.consumedBytes = bytes
                  if (cloudBodyBytes > cloudBodyBudget) {
                    await reader.cancel()
                    controller.error(new Error('Acceptance byte budget reached'))
                    return
                  }
                  if (mediaOnly) {
                    // Test-only throughput cap prevents native media read-ahead
                    // from consuming the whole video before the seek assertions.
                    await new Promise(resolve => setTimeout(resolve, Math.ceil(part.value.length / (1024 * 1024) * 1000)))
                    init.signal?.throwIfAborted()
                  }
                  controller.enqueue(part.value)
                } catch { controller.error(new Error('Acceptance source interrupted')) }
              },
              async cancel() { await reader.cancel().catch(() => undefined) },
            })
            return new Response(body, { status: response.status, headers: response.headers })
          }
          return response
        } catch (error) {
          const cause = (error as { cause?: { code?: unknown } })?.cause?.code
          if (typeof cause === 'string' && /^[A-Z_]{2,64}$/.test(cause)) evidence.networkCode = cause
          throw new Error('Upstream request failed')
        }
      } }
    }
    const video = root.files.find(file => !file.isDir && file.name === '夸克网盘能干什么.mp4')
    if (!video) throw new Error('Expected root video not found')
    if (productionCookies) {
      phase = 'production-cookie-diagnostics'
      const diagnostics: Array<Record<string, unknown>> = []
      const source = await getAuditedSource(video)
      for (const [stack, send] of [['node', fetch], ['electron-net', net.fetch.bind(net)], ['electron-quark-session', quarkSession.fetch.bind(quarkSession)]] as const) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 12_000)
        const evidence: Record<string, unknown> = { stack, method: 'GET', range: 'bytes=0-65535', maxErrorBodyParsedBytes: 4096 }
        diagnostics.push(evidence)
        let response: Response | undefined
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        try {
          response = await send(source.url, { headers: { ...source.headers, Range: 'bytes=0-65535', 'Accept-Encoding': 'identity' }, signal: controller.signal })
          evidence.status = response.status
          const mime = response.headers.get('content-type')?.split(';')[0].trim()
          if (mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime)) evidence.contentType = mime
          if (response.status === 412 && response.body) {
            reader = response.body.getReader()
            const chunks: Buffer[] = []
            let parsedBytes = 0
            while (parsedBytes < 4096) {
              const chunk = await reader.read()
              if (chunk.done) break
              const slice = Buffer.from(chunk.value).subarray(0, 4096 - parsedBytes)
              chunks.push(slice); parsedBytes += slice.length
            }
            const body = Buffer.concat(chunks).toString('utf8')
            evidence.parsedBytes = parsedBytes
            evidence.errorTypes = ['PreconditionFailed', 'AccessDenied', 'UserAgentMismatch', 'SignatureDoesNotMatch', 'ExpiredToken', 'RequestExpired', 'Captcha', 'VerifyRequired']
              .filter(type => body.toLowerCase().includes(type.toLowerCase()))
            evidence.containsCaptcha = /captcha/i.test(body)
            evidence.containsVerify = /verify|verification/i.test(body)
          }
        } catch { evidence.failed = true }
        finally {
          controller.abort()
          if (reader) await reader.cancel().catch(() => undefined)
          else await response?.body?.cancel().catch(() => undefined)
          clearTimeout(timer)
        }
      }
      const currentCookies = await quarkSession.cookies.get({ url: 'https://drive-pc.quark.cn/' })
      const refreshed = new Map((account.credential.cookies || '').split(';').map(pair => { const index = pair.indexOf('='); return [pair.slice(0, index).trim(), pair.slice(index + 1)] }))
      for (const cookie of currentCookies) if (!responseCookieRefresh.has(cookie.name)) responseCookieRefresh.set(cookie.name, cookie.value)
      const changedNames = [...responseCookieRefresh].filter(([name, value]) => refreshed.has(name) && refreshed.get(name) !== value).map(([name]) => name)
      for (const cookie of currentCookies) if (refreshed.has(cookie.name)) refreshed.set(cookie.name, cookie.value)
      for (const [name, value] of responseCookieRefresh) if (refreshed.has(name)) refreshed.set(name, value)
      const refreshedCookie = [...refreshed].map(([name, value]) => `${name}=${value}`).join('; ')
      if (changedNames.length) for (const [stack, send] of [['node-refreshed-response-cookie', fetch]] as const) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 12_000)
        const evidence: Record<string, unknown> = { stack, method: 'GET', range: 'bytes=0-65535', changedExistingCookieNames: changedNames,
          sameResolvedSource: true, accountAndDatabaseUnchanged: true, consumedBytes: 0 }
        diagnostics.push(evidence)
        let response: Response | undefined
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        try {
          response = await send(source.url, { headers: { ...source.headers, Cookie: refreshedCookie, Range: 'bytes=0-65535', 'Accept-Encoding': 'identity' }, signal: controller.signal })
          evidence.status = response.status
          if (response.status === 206 && response.headers.get('content-range') === `bytes 0-65535/${video.size}` && response.body) {
            reader = response.body.getReader()
            const hash = createHash('sha256')
            let count = 0
            for (;;) {
              const chunk = await reader.read()
              if (chunk.done) break
              count += chunk.value.length
              if (count > 65536) throw new Error('Range limit exceeded')
              hash.update(chunk.value)
            }
            evidence.consumedBytes = count
            evidence.exactRange = count === 65536
            evidence.sha256 = hash.digest('hex')
          }
        } catch { evidence.failed = true }
        finally {
          controller.abort()
          if (reader) await reader.cancel().catch(() => undefined)
          else await response?.body?.cancel().catch(() => undefined)
          clearTimeout(timer)
        }
      }
      save('cdn-error-diagnostic.json', { checks: diagnostics, productionResponseCookiesRetained: true,
        legalResponseCookieChanges: changedNames, time: new Date().toISOString() })
      const uploadDirectory = root.files.find(file => file.isDir && file.name === '夸克上传文件')
      if (uploadDirectory) {
        phase = 'list-upload-directory'
        const listed = await quarkAdapter.listFiles(account, uploadDirectory.id)
        const groups: Record<string, ReturnType<typeof safeFile>[]> = {}
        for (const file of listed.files) {
          if (file.accountId !== ACCOUNT_ID) throw new Error('File scope mismatch')
          const type = file.isDir ? 'directory' : file.name.split('.').pop()!.toLowerCase()
          const group = groups[type] ||= []
          if (group.length < 2) group.push(safeFile(file))
        }
        save('upload-directory-samples.json', { directory: safeFile(uploadDirectory), totalEntries: listed.files.length, complete: listed.hasMore === false, groups })
      }
      phase = 'complete'
      return
    }
    if (process.argv.includes('--compare-stacks')) {
      phase = 'compare-stacks'
      const rows: Array<Record<string, unknown>> = []
      const source = await getAuditedSource(video)
      const stacks = [['node', fetch], ['electron-net', net.fetch.bind(net)], ['electron-quark-session', quarkSession.fetch.bind(quarkSession)]] as const
      for (const [stack, send] of stacks) {
        for (const method of ['HEAD', 'GET']) {
          const evidence: Record<string, unknown> = { stack, method, consumedBytes: 0 }
          rows.push(evidence)
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 12_000)
          let response: Response | undefined
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
          try {
            const headers = new Headers(source.headers)
            headers.set('Accept-Encoding', 'identity')
            if (method === 'GET') headers.set('Range', 'bytes=0-65535')
            response = await send(source.url, { method, headers, signal: controller.signal })
            evidence.status = response.status
            if (method === 'GET' && response.status === 206 && response.headers.get('content-range') === `bytes 0-65535/${video.size}` && response.body) {
              reader = response.body.getReader()
              const hash = createHash('sha256')
              let size = 0
              for (;;) {
                const chunk = await reader.read()
                if (chunk.done) break
                size += chunk.value.length
                if (size > 65536) throw new Error('Range too large')
                hash.update(chunk.value)
              }
              evidence.consumedBytes = size
              evidence.exactRange = size === 65536
              evidence.sha256 = hash.digest('hex')
            }
          } catch { evidence.failed = true }
          finally {
            controller.abort()
            if (reader) await reader.cancel().catch(() => undefined)
            else await response?.body?.cancel().catch(() => undefined)
            clearTimeout(timer)
          }
        }
      }
      save('transport-comparison.json', { file: safeFile(video), checks: rows,
        identicalResolvedSourceAndHeaders: true, scope: 'Diagnostic comparison only; production fetch selection unchanged', time: new Date().toISOString() })
      const pdf = root.files.find(file => !file.isDir && file.name === '夸克网盘使用指南.pdf')
      if (pdf) {
        phase = 'bounded-pdf-get'
        const pdfSource = await getAuditedSource(pdf)
        const pdfChecks: Array<Record<string, unknown>> = []
        for (const [stack, send] of stacks) {
          const evidence: Record<string, unknown> = { stack, method: 'GET', maxBytes: 2 * 1024 * 1024, consumedBytes: 0 }
          pdfChecks.push(evidence)
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 20_000)
          let response: Response | undefined
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
          try {
            response = await send(pdfSource.url, { headers: pdfSource.headers, signal: controller.signal })
            evidence.status = response.status
            if (response.status === 200 && response.body && Number(response.headers.get('content-length')) <= 2 * 1024 * 1024) {
              reader = response.body.getReader()
              const chunks: Buffer[] = []
              let count = 0
              for (;;) {
                const chunk = await reader.read()
                if (chunk.done) break
                count += chunk.value.length
                if (count > 2 * 1024 * 1024) throw new Error('PDF limit exceeded')
                chunks.push(Buffer.from(chunk.value))
              }
              evidence.consumedBytes = count
              const bytes = Buffer.concat(chunks)
              if (count !== pdf.size || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('PDF content validation failed')
              const target = `authorized-guide-${stack}.pdf`
              writeFileSync(join(output!, target), bytes, { flag: 'wx' })
              evidence.savedFile = target
              evidence.sha256 = createHash('sha256').update(bytes).digest('hex')
            }
          } catch { evidence.failed = true }
          finally {
            controller.abort()
            if (reader) await reader.cancel().catch(() => undefined)
            else await response?.body?.cancel().catch(() => undefined)
            clearTimeout(timer)
          }
        }
        save('pdf-get-comparison.json', { file: safeFile(pdf), checks: pdfChecks, time: new Date().toISOString() })
      }
      phase = 'complete'
      return
    }
    phase = 'range-probe'
    service = new FilePreviewService({ tempRoot: join(profile!, 'previews') })
    protocol.handle('panlite-preview', request => service!.handleRequest(request))
    const report = await runReadOnlyPreviewProbe({ expectedFileSize: video.size,
      create: () => service!.createSession({ accountId: ACCOUNT_ID, fileId: video.id, fileName: video.name, fileSize: video.size },
        async () => { throw new Error('Full-file download is prohibited') },
        async () => getAuditedSource(video)),
      request: (url: string, init: RequestInit) => net.fetch(url, init),
      cleanup: (id: string) => service!.cleanupSession(id),
    })
    save('video-range-report.json', { ...report, file: safeFile(video), runtime: { electron: process.versions.electron, node: process.versions.node },
      source: 'Current production QuarkAdapter + FilePreviewService + Electron custom protocol; original database opened read-only with explicit packaged native binding' })
    const sourceChecks = []
    for (const name of ['夸克网盘使用指南.pdf', '夸克网盘使用指南.png']) {
      const file = root.files.find(item => !item.isDir && item.name === name)
      if (!file) continue
      try {
        const source = await getAuditedSource(file)
        const dto = await service.createSession({ accountId: ACCOUNT_ID, fileId: file.id, fileName: file.name, fileSize: file.size },
          async () => { throw new Error('Full-file download prohibited') }, async () => source)
        const response = await net.fetch(dto.assetUrl!, { method: 'HEAD', signal: AbortSignal.timeout(12_000) })
        sourceChecks.push({ file: safeFile(file), sourceResolved: true, headStatus: response.status })
        await response.body?.cancel()
        service.cleanupSession(dto.sessionId)
      } catch { sourceChecks.push({ file: safeFile(file), sourceResolved: false }) }
    }
    save('document-source-checks.json', { checks: sourceChecks })
    if (boundedAcceptance) {
      phase = 'bounded-document-downloads'
      const downloads: Array<Record<string, unknown>> = []
      for (const [name, fileName, maxBytes] of (mediaOnly ? [] : [['夸克网盘使用指南.pdf', 'authorized-guide.pdf', 2 * 1024 * 1024],
        ['夸克网盘使用指南.png', 'authorized-guide.png', 8 * 1024 * 1024]] as const)) {
        const file = root.files.find(item => !item.isDir && item.name === name)
        if (!file) continue
        const source = await getAuditedSource(file)
        const result = await downloadPreviewSource(source, { directory: output!, fileName, maxBytes })
        const evidence: Record<string, unknown> = { file: safeFile(file), success: result.success, maxBytes }
        if (result.success && result.localPath) {
          const bytes = readFileSync(result.localPath)
          evidence.sizeMatches = bytes.length === file.size
          evidence.sha256 = createHash('sha256').update(bytes).digest('hex')
          evidence.savedFile = fileName
        }
        downloads.push(evidence)
        save('document-downloads.json', { downloads, modelCalls: 0, time: new Date().toISOString() })
      }
      phase = 'hidden-decode-and-playback'
      const window = new BrowserWindow({ show: false, width: 960, height: 720,
        webPreferences: { backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: true } })
      hiddenWindowsCreated++
      const hidden: Record<string, unknown> = { visible: false, muted: true, userInputOperations: 0 }
      hidden.testThroughputCapBytesPerSecond = mediaOnly ? 1024 * 1024 : null
      try {
        await window.loadURL('data:text/html,<html><body></body></html>')
        const smallImage = root.files.find(item => !item.isDir && item.name === 'MARS-99029.png')
        if (smallImage) {
          const dto = await service.createSession({ accountId: ACCOUNT_ID, fileId: smallImage.id, fileName: smallImage.name, fileSize: smallImage.size },
            async () => { throw new Error('Full download prohibited for preview') }, async () => getAuditedSource(smallImage))
          try { hidden.image = { file: safeFile(smallImage), result: await verifyHiddenImage(window, dto.assetUrl!) } }
          catch { hidden.image = { file: safeFile(smallImage), passed: false, error: 'Hidden image acceptance failed' } }
          finally { service.cleanupSession(dto.sessionId) }
        }
        const dto = await service.createSession({ accountId: ACCOUNT_ID, fileId: video.id, fileName: video.name, fileSize: video.size },
          async () => { throw new Error('Full download prohibited for preview') }, async () => getAuditedSource(video))
        try { hidden.video = await verifyHiddenMedia(window, dto.assetUrl!) }
        catch { hidden.video = { passed: false, error: 'Hidden video acceptance failed or read budget reached' } }
        finally { service.cleanupSession(dto.sessionId) }
        const pdf = root.files.find(item => !item.isDir && item.name === '夸克网盘使用指南.pdf')
        if (pdf) {
          const pdfDto = await service.createSession({ accountId: ACCOUNT_ID, fileId: pdf.id, fileName: pdf.name, fileSize: pdf.size },
            async () => { throw new Error('Full download prohibited for preview') }, async () => getAuditedSource(pdf))
          try { hidden.pdf = await verifyHiddenPdf(window, pdfDto.assetUrl!, join(output!, 'hidden-pdf.png')) }
          catch { hidden.pdf = { passed: false, error: 'Hidden PDF acceptance failed' } }
          finally { service.cleanupSession(pdfDto.sessionId) }
        }
      } finally { window.destroy() }
      hidden.cloudBodyBytes = cloudBodyBytes
      hidden.cloudBodyBudget = cloudBodyBudget
      save('hidden-media-report.json', hidden)
    }
    account.credential = {}
    phase = 'complete'
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const status = /HTTP (\d{3})/.exec(message)?.[1]
    const businessCode = /code[=:]\s*(\d{1,10})/.exec(message)?.[1]
    const networkCode = /\bERR_[A-Z_]+\b/.exec(message)?.[0]
    save('driver-error.json', { failedPhase: phase, ...(status ? { httpStatus: Number(status) } : {}), ...(businessCode ? { businessCode } : {}),
      ...(networkCode ? { networkCode } : {}), message: 'Read-only acceptance failed; raw provider errors omitted to protect credentials', time: new Date().toISOString() })
    process.exitCode = 1
  } finally {
    service?.cleanupAll()
    save(productionSearchSamples ? 'production-search-request-audit.json' : searchQDiagnostic ? 'search-q-request-audit.json' : searchGetDiagnostic ? 'search-get-request-audit.json' : process.argv.includes('--fallback-samples') ? 'fallback-samples-request-audit.json' : process.argv.includes('--extra-samples') ? 'extra-samples-request-audit.json' : process.argv.includes('--metadata') ? 'metadata-request-audit.json' : 'request-audit.json', { phase, apiRequests: allowedRequests, apiResponses, blockedRequests, streamRequests, sourceShapes, cookieEvidence,
      cloudWritesAllowed: false, windowsCreated: hiddenWindowsCreated, windowsShown: 0, cloudBodyBytes, cloudBodyBudget })
    app.exit(process.exitCode || 0)
  }
})
