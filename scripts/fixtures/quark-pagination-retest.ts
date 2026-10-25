import { app, session } from 'electron'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import log from 'electron-log'
import { decryptCredential } from '../../src/main/crypto'
import { quarkAdapter } from '../../src/adapters/quark'
import { configureRequestSettings } from '../../src/main/request-settings'
import type { DriveAccount } from '../../src/shared/types'

const profile = process.env.PANLITE_READONLY_PROFILE!
const databasePath = process.env.PANLITE_READONLY_DATABASE!
const reportPath = process.env.PANLITE_READONLY_REPORT!
app.setPath('userData', profile)
app.setPath('sessionData', profile)
log.transports.console.level = false
log.transports.file.level = false
const report = { startedAt: new Date().toISOString(), passed: false, execution: 'One production listFiles call against the previously observed live directory', requests: [] as Array<{ page: number; items?: number; total?: number; status?: number }>, requestsStarted: 0, blockedRequests: 0, entries: 0, uniqueEntries: 0, complete: false, failure: '', safety: { windowsCreated: 0, databaseReadOnly: true, cloudWritesAllowed: false, fileContentRequestsAllowed: false, originalDatabaseMainFileUnchanged: false } }
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2))
const hashDatabase = () => createHash('sha256').update(readFileSync(databasePath)).digest('hex')
app.whenReady().then(async () => {
  const before = hashDatabase()
  const abort = new AbortController()
  const timer = setTimeout(() => { report.failure = 'time-budget-reached'; save(); abort.abort(); app.exit(2) }, 60_000)
  try {
    const saved = JSON.parse(readFileSync(process.env.PANLITE_READONLY_PREVIOUS_METADATA!, 'utf8'))
    const candidates = saved.folders.filter((folder: { entries: number; directory?: { id?: string } }) => folder.entries === 200 && typeof folder.directory?.id === 'string')
    if (candidates.length !== 1) throw new Error('ambiguous-sample')
    const parentId = candidates[0].directory.id
    const db = new Database(databasePath, { readonly: true, fileMustExist: true, nativeBinding: process.env.PANLITE_READONLY_NATIVE })
    let account: DriveAccount
    try {
      db.pragma('query_only = ON')
      const row = db.prepare("SELECT * FROM accounts WHERE platform='quark' ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END,updated_at DESC LIMIT 1").get() as { id: string; nickname: string; login_type: DriveAccount['loginType']; encrypted_credential: string; status: DriveAccount['status']; created_at: number; updated_at: number }
      if (!row) throw new Error('missing-account')
      account = { id: row.id, platform: 'quark', nickname: row.nickname, loginType: row.login_type, credential: JSON.parse(decryptCredential(row.encrypted_credential)), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }
    } finally { db.close() }
    configureRequestSettings({ quarkPageSize: '200' })
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }))
    const ses = session.fromPartition('persist:quark')
    const originalFetch = ses.fetch.bind(ses)
    const allowed = (url: URL, method: string) => method === 'GET' && url.protocol === 'https:' && url.hostname === 'drive-pc.quark.cn' && url.pathname === '/1/clouddrive/file/sort' && url.searchParams.get('pdir_fid') === parentId
    ses.webRequest.onBeforeRequest((details, callback) => {
      const permitted = !abort.signal.aborted && report.requestsStarted < 4 && allowed(new URL(details.url), details.method)
      if (permitted) report.requestsStarted++
      else report.blockedRequests++
      callback({ cancel: !permitted })
    })
    ses.fetch = async (input, init) => {
      if (typeof input !== 'string' || !allowed(new URL(input), init?.method || 'GET')) throw new Error('blocked-request')
      const audit = { page: Number(new URL(input).searchParams.get('_page')) } as typeof report.requests[number]
      report.requests.push(audit)
      const response = await originalFetch(input, { ...init, signal: abort.signal })
      const json = await response.clone().json()
      audit.status = response.status
      audit.items = json?.data?.list?.length
      audit.total = json?.metadata?._total
      save()
      return response
    }
    const result = await quarkAdapter.listFiles(account, parentId)
    report.entries = result.files.length
    report.uniqueEntries = new Set(result.files.map(file => file.id)).size
    report.complete = result.hasMore === false
    report.passed = report.entries === 243 && report.uniqueEntries === 243 && report.complete && report.requestsStarted === 2 && report.blockedRequests === 0 && report.requests[0]?.items === 200 && report.requests[1]?.items === 43
  } catch { report.failure = 'live-retest-failed-see-sanitized-counts' }
  finally {
    clearTimeout(timer)
    report.safety.originalDatabaseMainFileUnchanged = before === hashDatabase()
    save()
    app.exit(report.passed ? 0 : 1)
  }
}).catch(() => { report.failure = 'electron-startup-failed'; save(); app.exit(1) })
