import { app, BrowserWindow, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import log from 'electron-log'
import { initDatabase, getDb, insertAccount, insertTask, getTaskById, setSetting } from '../../src/main/db'
import { encryptCredential } from '../../src/main/crypto'
import { enqueueTask, refreshTaskScheduling, getQueueStatus, pauseTask, resumeTask } from '../../src/main/task-runner'
import { saveTaskSchedule } from '../../src/main/task-scheduling'
import { readTaskSchedule } from '../../src/main/task-scheduling-store'

const profile = process.env.PANLITE_SCHEDULING_PROFILE!, output = process.env.PANLITE_SCHEDULING_OUTPUT!
if (!profile || !output) throw new Error('Isolated acceptance paths are required')
app.setPath('userData', profile); app.setPath('sessionData', profile)
log.transports.console.level = false; log.transports.file.level = false
const body = Buffer.from('PanLite real HTTP scheduling acceptance\n预算 420000 元\n')
const requests: Array<{ path: string; method: string; at: number }> = [], checks: string[] = []
const verifiedFiles: Array<{ path: string; sha256: string; bytes: number }> = []
const blockedNetwork: string[] = []
let closeOnFirstDownload = false, activeServer: http.Server | undefined, databaseOpened = false
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await pause(20) }
}
function closedWindow(): string { const hour = new Date().getHours(); return `${String((hour + 2) % 24).padStart(2, '0')}:00-${String((hour + 3) % 24).padStart(2, '0')}:00` }
function makeTask(name: string, files = [name]): string {
  const id = randomUUID(), now = Date.now()
  insertTask({ id, account_id: 'loopback', platform: 'webdav', task_type: 'download', title: name,
    payload: JSON.stringify({ targetDirPath: path.join(profile, 'downloads', name), conflictPolicy: 'overwrite', files: files.map(file => ({ fileId: `/${file}.txt`, fileName: `${file}.txt`, fileSize: body.length, isDir: false })) }),
    status: 'pending', progress: 0, retry_count: 0, execution_token: null, error_message: null, created_at: now, updated_at: now, finished_at: null })
  return id
}
async function success(id: string): Promise<void> {
  await waitFor(() => ['success', 'failed', 'partial_success'].includes(getTaskById(id)?.status || ''), id)
  assert.equal(getTaskById(id)?.status, 'success', getTaskById(id)?.error_message || undefined)
  await waitFor(() => Object.values(getQueueStatus()).every(queue => !queue.running), 'idle queue')
}

app.whenReady().then(async () => {
  let passed = false, failure = ''
  try {
    initDatabase(); databaseOpened = true
    const authorization = `Basic ${Buffer.from('acceptance:local-only').toString('base64')}`
    activeServer = http.createServer((request, response) => {
      if (request.method !== 'GET' || request.headers.authorization !== authorization) { response.writeHead(403).end(); return }
      requests.push({ path: request.url!, method: request.method, at: Date.now() })
      if (closeOnFirstDownload && request.url === '/boundary-one.txt') { closeOnFirstDownload = false; setSetting('transferScheduledWindow', closedWindow()) }
      response.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' }).end(body)
    })
    await new Promise<void>(resolve => activeServer!.listen(0, '127.0.0.1', resolve))
    const address = activeServer.address(); assert(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = new URL(details.url).origin === origin
      if (!allowed) blockedNetwork.push(new URL(details.url).protocol)
      callback({ cancel: !allowed })
    })
    insertAccount({ id: 'loopback', platform: 'webdav', nickname: 'Local protocol acceptance', login_type: 'password', encrypted_credential: encryptCredential(JSON.stringify({ serverUrl: origin, username: 'acceptance', password: 'local-only' })), user_agent: null, status: 'active', bind_machine: 0, created_at: 1, updated_at: 1, last_check_at: null })
    setSetting('transferScheduledWindow', closedWindow()); setSetting('transferPauseAtWindowEnd', 'true')
    const night = makeTask('night'), immediate = makeTask('immediate')
    saveTaskSchedule(immediate, { priority: 'normal', window: '', notBefore: null })
    enqueueTask(night); enqueueTask(immediate); await success(immediate)
    assert.equal(getTaskById(night)?.status, 'pending'); assert(!requests.some(item => item.path === '/night.txt'))
    checks.push('An eligible task completed real HTTP I/O while the night task remained pending without occupying the single platform worker')
    assert(pauseTask(night)); setSetting('transferScheduledWindow', ''); refreshTaskScheduling(); await pause(1100)
    assert.equal(getTaskById(night)?.status, 'paused'); assert(!requests.some(item => item.path === '/night.txt'))
    assert(resumeTask(night)); await success(night)
    checks.push('Configuration refresh preserved manual pause; explicit resume downloaded the file exactly once')

    const priorityStart = requests.length, notBefore = Date.now() + 300
    const priorities = [['low', 'low'], ['normal', 'normal'], ['high', 'high']] as const
    const ids = priorities.map(([name, priority]) => { const id = makeTask(name); saveTaskSchedule(id, { priority, window: '', notBefore }); enqueueTask(id); return id })
    const reopened = new Database(path.join(profile, 'panlite.db'), { readonly: true })
    try { assert.deepEqual(readTaskSchedule(reopened, ids[2]), { priority: 'high', window: '', notBefore }) } finally { reopened.close() }
    await success(ids[0]); await success(ids[1]); await success(ids[2])
    assert.deepEqual(requests.slice(priorityStart).map(item => item.path), ['/high.txt', '/normal.txt', '/low.txt'])
    assert(requests.slice(priorityStart).every(item => item.at >= notBefore))
    checks.push('Persisted priority/not-before survived a second SQLite connection; real requests executed high, normal, low after the deadline')

    closeOnFirstDownload = true
    const boundary = makeTask('boundary', ['boundary-one', 'boundary-two']); enqueueTask(boundary)
    await waitFor(() => requests.some(item => item.path === '/boundary-one.txt') && getTaskById(boundary)?.status === 'pending', 'operation boundary wait')
    assert(!requests.some(item => item.path === '/boundary-two.txt')); assert.equal(getTaskById(boundary)?.retry_count, 0)
    assert.equal(fs.readFileSync(path.join(profile, 'downloads/boundary/boundary-one.txt')).equals(body), true)
    setSetting('transferScheduledWindow', ''); refreshTaskScheduling(); await success(boundary)
    for (const name of ['boundary-one', 'boundary-two']) assert.equal(requests.filter(item => item.path === `/${name}.txt`).length, 1)
    checks.push('The current download was published before window-end deferral; reopening the window did not repeat the first download')
    for (const relative of ['immediate/immediate.txt', 'night/night.txt', 'high/high.txt', 'normal/normal.txt', 'low/low.txt', 'boundary/boundary-one.txt', 'boundary/boundary-two.txt']) {
      const bytes = fs.readFileSync(path.join(profile, 'downloads', relative))
      assert(bytes.equals(body), `Downloaded bytes differ: ${relative}`)
      verifiedFiles.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
    }
    checks.push('All seven published files matched the HTTP source bytes and SHA256')
    assert.equal(BrowserWindow.getAllWindows().length, 0); assert.deepEqual(blockedNetwork, [])
    passed = true
  } catch (error) { failure = error instanceof Error ? error.message : String(error) }
  finally {
    const report = { passed, kind: 'background-real-product-queue-and-WebDAV-HTTP-on-loopback', externalCloudVerified: false, createdWindows: BrowserWindow.getAllWindows().length,
      checks, requests, verifiedFiles, blockedNetwork, expectedFileSha256: createHash('sha256').update(body).digest('hex'), ...(failure ? { failure } : {}) }
    fs.writeFileSync(path.join(output, 'scheduling-report.json'), JSON.stringify(report, null, 2))
    activeServer?.closeAllConnections(); if (activeServer) await new Promise<void>(resolve => activeServer!.close(() => resolve()))
    if (databaseOpened) getDb().close()
    app.exit(passed ? 0 : 1)
  }
}).catch(() => app.exit(1))
