import { app, BrowserWindow, session } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getDb, getTaskById, initDatabase, insertAccount, setSetting } from '../../src/main/db'
import { cleanupIpcResources, registerIpcHandlers } from '../../src/main/ipc'
import { getTransferPlanService } from '../../src/main/transfer-plan-runtime'
import { getAdapter } from '../../src/adapters/registry'
import { encryptCredential } from '../../src/main/crypto'
import type { DriveAccount, FileItem } from '../../src/shared/types'
import type { TransferPreview, TransferRun } from '../../src/shared/transfer-plan'

const profile = process.env.PANLITE_TRANSFER_PLANS_SMOKE_PROFILE!
const output = process.env.PANLITE_TRANSFER_PLANS_SMOKE_OUTPUT!
if (!profile || !output) throw new Error('Isolated transfer plan smoke paths are required')
app.setPath('userData', profile)
app.disableHardwareAcceleration()
const stamp = Date.now() - 3600_000
const sourceId = 'plan-source'
const targetId = 'plan-target'
type MemoryFile = { file: FileItem; bytes?: Buffer }
const trees = new Map<string, Map<string, MemoryFile>>([[sourceId, new Map()], [targetId, new Map()]])
const writes: Array<{ action: string; parentId: string; name: string; size?: number }> = []
const downloads: Array<{ fileId: string; size: number; exactPath: boolean }> = []
const network: string[] = []
let idSequence = 0

function checkAccount(account: DriveAccount) { if (!trees.has(account.id)) throw new Error('Fixture attempted a non-test account') }
function addFile(accountId: string, id: string, parentId: string, name: string, isDir = false, bytes?: Buffer, hash = false): FileItem {
  const file: FileItem = { id, parentId, name, isDir, size: bytes?.length || 0, accountId, platform: accountId === sourceId ? 'pan123' : 'webdav', createdAt: stamp, updatedAt: stamp,
    ...(hash && bytes ? { raw: { etag: createHash('md5').update(bytes).digest('hex') } } : {}) }
  trees.get(accountId)!.set(id, { file, bytes })
  return file
}
function children(accountId: string, parentId: string): FileItem[] { return [...trees.get(accountId)!.values()].filter(item => item.file.parentId === parentId).map(item => structuredClone(item.file)) }
function ownedFile(file: string) { const relative = path.relative(path.resolve(profile), path.resolve(file)); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }

function installMemoryAdapters() {
  for (const [accountId, platform, nickname] of [[sourceId, 'pan123', '项目资料源盘'], [targetId, 'webdav', '迁移归档目标盘']] as const) {
    insertAccount({ id: accountId, platform, nickname, login_type: 'password', encrypted_credential: encryptCredential('{}'), user_agent: null, status: 'active', bind_machine: 1, created_at: stamp, updated_at: stamp, last_check_at: null })
    const adapter = getAdapter(platform)
    adapter.listFiles = async (account, parentId) => { checkAccount(account); return { files: children(account.id, parentId), parentId, hasMore: false } }
    adapter.getQuota = async account => { checkAccount(account); return { used: 1024 * 1024, total: 1024 ** 3 } }
    adapter.checkLogin = async account => { checkAccount(account); return true }
    adapter.mkdir = async (account, parentId, name) => {
      checkAccount(account); if (account.id !== targetId) throw new Error('Unexpected source mutation')
      if (children(account.id, parentId).some(file => file.name === name)) throw new Error('Unexpected existing directory')
      writes.push({ action: 'mkdir', parentId, name })
      return addFile(targetId, `written-dir-${++idSequence}`, parentId, name, true)
    }
    adapter.download = async (account, fileId, directory, options) => {
      checkAccount(account); if (account.id !== sourceId) throw new Error('Unexpected target download')
      options?.signal?.throwIfAborted()
      const item = trees.get(account.id)!.get(fileId)
      if (!item?.bytes || !options?.fileName) throw new Error('Unknown fixture download source')
      const localPath = path.join(directory, options.fileName)
      if (!ownedFile(localPath) || path.basename(options.fileName) !== options.fileName) throw new Error('Download escaped isolated profile')
      mkdirSync(directory, { recursive: true }); writeFileSync(localPath, item.bytes)
      downloads.push({ fileId, size: item.bytes.length, exactPath: true })
      options.onProgress?.({ loaded: item.bytes.length, total: item.bytes.length, percent: 100, speed: item.bytes.length })
      return { success: true, localPath, fileName: options.fileName, fileSize: item.bytes.length }
    }
    adapter.upload = async (account, localFilePath, parentId, options) => {
      checkAccount(account); if (account.id !== targetId || !ownedFile(localFilePath)) throw new Error('Upload escaped fixture scope')
      options?.signal?.throwIfAborted()
      if (!options?.fileName || options.overwrite || children(account.id, parentId).some(file => file.name === options.fileName)) throw new Error('Unexpected overwrite or missing upload name')
      const bytes = readFileSync(localFilePath)
      const file = addFile(targetId, `written-file-${++idSequence}`, parentId, options.fileName, false, bytes)
      writes.push({ action: 'upload', parentId, name: file.name, size: bytes.length })
      options.onProgress?.({ loaded: bytes.length, total: bytes.length, percent: 100, speed: bytes.length })
      return { success: true, fileId: file.id, fileName: file.name, size: bytes.length }
    }
    const forbidden = async () => { throw new Error('Unexpected provider operation outside the synthetic migration') }
    adapter.copy = forbidden; adapter.move = forbidden; adapter.rename = forbidden; adapter.delete = forbidden
    adapter.getDownloadSource = forbidden; adapter.getDownloadUrl = forbidden
  }
  addFile(sourceId, 'source-root', '0', '项目资料', true)
  addFile(targetId, 'target-root', '0', '归档库', true)
  addFile(sourceId, 'empty-dir', 'source-root', '空目录', true)
  for (let index = 1; index <= 51; index++) addFile(sourceId, `source-${index}`, 'source-root', `交付说明-${String(index).padStart(3, '0')}.txt`, false, Buffer.from(`PanLite isolated content ${index}\n`, 'utf8'), true)
  addFile(sourceId, 'rename-review', 'source-root', '同名资料.txt', false, Buffer.from('NEW-RENAME-CONTENT'))
  addFile(targetId, 'original-rename', 'target-root', '同名资料.txt', false, Buffer.from('OLD-RENAME-CONTENT'))
  addFile(sourceId, 'skip-review', 'source-root', '保留旧稿.txt', false, Buffer.from('NEW-SKIP-CONTENT'))
  addFile(targetId, 'original-skip', 'target-root', '保留旧稿.txt', false, Buffer.from('OLD-SKIP-CONTENT'))
  addFile(sourceId, 'excluded-file', 'source-root', '忽略.tmp', false, Buffer.from('excluded temporary bytes'))
}

async function evaluate<T = unknown>(win: BrowserWindow, code: string): Promise<T> {
  try { return await win.webContents.executeJavaScript(code) as T }
  catch (error) {
    console.error(`Renderer script failed: ${code}`)
    const detail = await win.webContents.executeJavaScript('document.body.innerText').catch(() => 'Renderer unavailable')
    writeFileSync(path.join(output, 'failure-state.txt'), String(detail))
    writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG())
    console.error(detail)
    throw error
  }
}
async function waitFor(win: BrowserWindow, predicate: string, attempts = 300): Promise<void> {
  for (let index = 0; index < attempts; index++) { if (await evaluate(win, predicate)) return; await new Promise(resolveWait => setTimeout(resolveWait, 50)) }
  writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  const detail = await evaluate(win, 'document.body.innerText')
  writeFileSync(path.join(output, 'failure-state.txt'), String(detail))
  throw new Error(`Renderer state did not appear: ${predicate}\n${detail}`)
}
async function clickButton(win: BrowserWindow, label: string) {
  await waitFor(win, `(() => { const button=Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim() === ${JSON.stringify(label)}); return !!button && !button.disabled; })()`)
  await evaluate(win, `(() => { const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw new Error('Unavailable button: ' + ${JSON.stringify(label)}); button.click(); })()`)
}
async function setControl(win: BrowserWindow, selector: string, value: string, event = 'input') {
  await waitFor(win, `(() => { const input=document.querySelector(${JSON.stringify(selector)}); return !!input && !input.disabled; })()`)
  await evaluate(win, `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input || input.disabled) throw new Error('Unavailable control'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event(${JSON.stringify(event)}, {bubbles:true})); })()`)
}
async function chooseDirectory(win: BrowserWindow, side: 'source' | 'target') {
  await clickButton(win, side === 'source' ? '选择源目录' : '选择目标目录')
  await setControl(win, 'select[aria-label="目录账号"]', side === 'source' ? sourceId : targetId, 'change')
  await waitFor(win, 'document.querySelectorAll(".scope-picker .folder").length === 1')
  await evaluate(win, 'document.querySelector(".scope-picker .folder").click()')
  await waitFor(win, 'document.querySelectorAll(".scope-picker .breadcrumbs button").length === 2 && !document.querySelector(".scope-picker .primary").disabled')
  await clickButton(win, '选择当前目录')
  await waitFor(win, '!document.querySelector(".scope-picker")')
}
async function chooseDecision(win: BrowserWindow, relativePath: string, action: 'rename' | 'skip') {
  const selector = `select[aria-label=${JSON.stringify(`处理${relativePath}`)}]`
  await setControl(win, selector, action, 'change')
  await evaluate(win, `(() => { const select = document.querySelector(${JSON.stringify(selector)}); select.closest('tr').querySelector('button').click(); })()`)
  await waitFor(win, `!document.querySelector(${JSON.stringify(selector)})`)
}
async function scrollToReview(win: BrowserWindow) {
  await evaluate(win, `(() => { const page=document.querySelector('.transfer-plans-page'), panel=document.querySelector('.review-panel'); page.scrollTop += panel.getBoundingClientRect().top - page.getBoundingClientRect().top; })()`)
}
interface Geometry { width: number; bodyOverflow: boolean; pageOverflow: boolean; rootDark: boolean; rows: number; pageRect: { x: number; y: number; width: number; height: number } }
async function capture(win: BrowserWindow, theme: string, width: number, file: string) {
  await new Promise(resolveWait => setTimeout(resolveWait, 250))
  const geometry = await evaluate<Geometry>(win, `(() => { const page=document.querySelector('.transfer-plans-page'), rect=page.getBoundingClientRect(); return {width:innerWidth,bodyOverflow:document.body.scrollWidth>innerWidth,pageOverflow:page.scrollWidth>page.clientWidth+1,rootDark:document.documentElement.classList.contains('dark'),rows:document.querySelectorAll('.review-panel tbody tr').length,pageRect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}; })()`)
  if (geometry.bodyOverflow || geometry.pageOverflow || geometry.rootDark !== (theme === 'dark')) throw new Error(`Invalid transfer plan layout: ${JSON.stringify(geometry)}`)
  writeFileSync(path.join(output, file), (await win.webContents.capturePage()).toPNG())
  return { theme, width, file, geometry }
}

app.whenReady().then(async () => {
  const errors: string[] = []
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(new URL(details.url).origin); callback({ cancel: true }) })
  globalThis.fetch = async () => { network.push('blocked-main-fetch'); throw new Error('External network is disabled in the smoke fixture') }
  initDatabase()
  setSetting('theme', 'light')
  setSetting('transferTempDir', path.join(profile, 'transfer-temp'))
  installMemoryAdapters()
  registerIpcHandlers()
  const service = getTransferPlanService()
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true } })
  win.removeMenu()
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const screenshots: Awaited<ReturnType<typeof capture>>[] = []
  try {
    await win.loadFile(path.join(__dirname, '../../renderer/index.html'), { hash: '/transfer-plans' })
    await waitFor(win, '!!document.querySelector(".transfer-plans-page .plan-form input")')
    await setControl(win, 'input[aria-label="计划名称"]', '项目交付资料迁移')
    await chooseDirectory(win, 'source'); await chooseDirectory(win, 'target')
    await setControl(win, 'textarea[aria-label="排除规则"]', '*.tmp')
    await evaluate(win, 'document.querySelector("form.plan-form").requestSubmit()')
    await waitFor(win, 'document.body.textContent.includes("计划已保存，可以生成差异预演")')
    const saved = await service.listPlans()
    if (!saved.success || saved.plans.length !== 1) throw new Error('Renderer save did not persist exactly one plan')
    const plan = saved.plans[0]
    if (plan.source.rootId !== 'source-root' || plan.target.rootId !== 'target-root') throw new Error('Real directory picker scope did not persist')
    screenshots.push(await capture(win, 'light', 1280, 'transfer-plans-configuration-light-1280.png'))
    await clickButton(win, '生成预演')
    await waitFor(win, '!!document.querySelector(".preview-table") && !document.querySelector(".spinning")')
    const ready = await service.listPlans()
    if (!ready.success || !ready.plans[0].latestPreviewId) throw new Error('Renderer preview did not persist')
    const previewId = ready.plans[0].latestPreviewId
    let evidence = await service.getPreview({ previewId, page: 1, pageSize: 200 })
    if (!evidence.success || evidence.preview.summary.reviewCount !== 2 || evidence.preview.executable || evidence.total !== 55) throw new Error(`Unexpected initial preview: ${JSON.stringify(evidence)}`)
    if (writes.length || downloads.length) throw new Error('Preview unexpectedly wrote or downloaded files')
    const initialPreview: TransferPreview = structuredClone(evidence.preview)
    await setControl(win, 'select[aria-label="预演分类"]', 'review', 'change')
    await waitFor(win, 'document.querySelectorAll(".preview-table tbody tr").length === 2')
    await chooseDecision(win, '同名资料.txt', 'rename')
    await chooseDecision(win, '保留旧稿.txt', 'skip')
    evidence = await service.getPreview({ previewId, page: 1, pageSize: 200 })
    if (!evidence.success || !evidence.preview.executable || evidence.preview.summary.reviewCount !== 0) throw new Error('Renderer decisions did not make the preview executable')
    const renamed = evidence.items.find(item => item.relativePath === '同名资料.txt')!
    if (renamed.action !== 'rename' || renamed.outputPath === renamed.relativePath || evidence.items.find(item => item.relativePath === '保留旧稿.txt')?.action !== 'skip') throw new Error('Review decisions were not stored correctly')
    for (const [theme, width] of [['light', 1280], ['dark', 960]] as const) {
      setSetting('theme', theme); win.setSize(width, 900)
      await win.loadURL('about:blank')
      await win.loadFile(path.join(__dirname, '../../renderer/index.html'), { hash: '/transfer-plans' })
      await waitFor(win, '!!document.querySelector(".preview-table")')
      await setControl(win, 'select[aria-label="预演分类"]', 'review', 'change')
      await waitFor(win, 'document.querySelectorAll(".preview-table tbody tr").length === 2')
      await scrollToReview(win)
      screenshots.push(await capture(win, theme, width, `transfer-plans-preview-${theme}-${width}.png`))
    }
    await clickButton(win, '执行此预演')
    await waitFor(win, '!!document.querySelector(".execution-confirmation")')
    if (service.store.listRuns(plan.id).length) throw new Error('Opening the confirmation unexpectedly enqueued a task')
    await clickButton(win, '确认执行此版本')
    let completed: TransferRun | undefined
    for (let attempt = 0; attempt < 500; attempt++) {
      const result = await service.listRuns(plan.id)
      if (result.success) {
        const current = result.runs[0]
        if (current && ['completed', 'partial', 'failed', 'stale'].includes(current.status)
          && (current.status !== 'completed' || (current.taskId && getTaskById(current.taskId)?.status === 'success'))) { completed = current; break }
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
    if (!completed || completed.status !== 'completed' || !completed.taskId || getTaskById(completed.taskId)?.status !== 'success') throw new Error(`Queued migration did not complete: ${JSON.stringify(completed)}`)
    if (completed.totalItems !== 55 || completed.succeeded !== 53 || completed.skipped !== 2 || completed.failed || completed.uncertain) throw new Error(`Unexpected runtime report: ${JSON.stringify(completed)}`)
    await waitFor(win, '!!document.querySelector(".run-selector")')
    await clickButton(win, '刷新报告')
    await waitFor(win, 'document.querySelectorAll(".report-table tbody tr").length === 50')
    await waitFor(win, 'document.querySelector(".run-selector option:checked").textContent.includes("已完成")')
    await clickButton(win, '下一页报告')
    await waitFor(win, 'document.querySelectorAll(".report-table tbody tr").length === 5')
    await scrollToReview(win)
    screenshots.push(await capture(win, 'dark', 960, 'transfer-plans-report-dark-960.png'))
    const report = await service.getReport({ runId: completed.id, page: 1, pageSize: 200 })
    if (!report.success || report.total !== 55 || report.items.some(item => !['success', 'skipped'].includes(item.status))) throw new Error('Per-file report did not match successful task')
    const targetFiles = children(targetId, 'target-root')
    const migrated = targetFiles.find(file => file.name === renamed.outputPath)
    if (!migrated || !trees.get(targetId)!.get(migrated.id)!.bytes!.equals(trees.get(sourceId)!.get('rename-review')!.bytes!)) throw new Error('Renamed transfer content did not match source')
    if (trees.get(targetId)!.get('original-rename')!.bytes!.toString() !== 'OLD-RENAME-CONTENT' || trees.get(targetId)!.get('original-skip')!.bytes!.toString() !== 'OLD-SKIP-CONTENT') throw new Error('Original target contents were changed')
    if (!targetFiles.some(file => file.name === '空目录' && file.isDir) || targetFiles.some(file => file.name === '忽略.tmp')) throw new Error('Empty directory or exclusion behavior is incorrect')
    for (let index = 1; index <= 51; index++) {
      const original = trees.get(sourceId)!.get(`source-${index}`)!
      const copied = targetFiles.find(file => file.name === original.file.name)
      if (!copied || !trees.get(targetId)!.get(copied.id)!.bytes!.equals(original.bytes!)) throw new Error(`Content mismatch for ${original.file.name}`)
    }
    const exported = await service.exportPlan({ planId: plan.id, previewId, runId: completed.id })
    if (!exported.success) throw new Error('Completed plan export failed')
    writeFileSync(path.join(output, 'exported-plan.json'), exported.json)
    const journal = getDb().prepare('select count(*) total from task_operations where task_id = ?').get(completed.taskId) as { total: number }
    if (!journal.total || network.length || errors.length) throw new Error(`Runtime diagnostics: ${JSON.stringify({ journal, network, errors })}`)
    await clickButton(win, '查看任务 / 暂停恢复')
    await waitFor(win, '!!document.querySelector(".task-log") && document.querySelectorAll(".task-row").length === 1')
    writeFileSync(path.join(output, 'transfer-plans-task-location.png'), (await win.webContents.capturePage()).toPNG())
    writeFileSync(path.join(output, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), electron: process.versions.electron, sqlite: getDb().prepare('select sqlite_version() version').get(),
      scenario: 'Isolated profile; real renderer, preload, IPC, SQLite, TransferPlanService, task queue and journal; memory-only source/target adapters and verified local small-file download/upload',
      rendererActions: ['choose source directory', 'choose target directory', 'save plan', 'preview', 'rename unknown-hash conflict', 'skip unknown-hash conflict', 'confirm exact preview', 'report page 2', 'locate task'],
      initialPreview, finalPreview: evidence.preview, run: completed, reportPageSize: 50, secondPageRows: 5, emptyDirectoryPreserved: true, excludedFileNotTransferred: true, targetOriginalsPreserved: true,
      downloadedFiles: downloads.length, uploadedFiles: writes.filter(write => write.action === 'upload').length, createdDirectories: writes.filter(write => write.action === 'mkdir').length, allTransferredContentsMatch: true,
      taskOperationJournalEntries: journal.total, screenshots, externalRequests: network.length, rendererErrors: errors, taskLocationVerified: true }, null, 2))
    console.log('Transfer plans Electron UI, real IPC/task execution and content verification passed')
  } finally { cleanupIpcResources(); win.destroy() }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
