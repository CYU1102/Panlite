import { app, BrowserWindow, session } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getDb, getTaskById, initDatabase, insertAccount, setSetting } from '../../src/main/db'
import { cleanupIpcResources, registerIpcHandlers } from '../../src/main/ipc'
import { getFileBackupService } from '../../src/main/file-backup-runtime'
import { getAutomationRuleService } from '../../src/main/automation-rule-runtime'
import { getAdapter } from '../../src/adapters/registry'
import { encryptCredential } from '../../src/main/crypto'
import type { DriveAccount, FileItem } from '../../src/shared/types'
import type { AutomationRule, AutomationRun } from '../../src/shared/automation-rules'

const profile = process.env.PANLITE_AUTOMATION_SMOKE_PROFILE!, output = process.env.PANLITE_AUTOMATION_SMOKE_OUTPUT!
if (!profile || !output) throw new Error('Isolated automation smoke paths are required')
app.setPath('userData', profile); app.disableHardwareAcceleration()
const source = path.join(profile, 'local-source'), accountId = 'automation-webdav', stamp = Date.now() - 3600_000
const remote = new Map<string, { file: FileItem; bytes?: Buffer }>(), writes: Array<{ action: string; name: string; size?: number }> = [], network: string[] = []
let sequence = 0, readbacks = 0
function owned(file: string) { const relative = path.relative(path.resolve(profile), path.resolve(file)); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }
function accountOnly(account: DriveAccount) { if (account.id !== accountId) throw new Error('Unexpected account outside fixture') }
function children(parentId: string) { return [...remote.values()].filter(item => item.file.parentId === parentId).map(item => structuredClone(item.file)) }
function addFile(id: string, parentId: string, name: string, isDir: boolean, bytes?: Buffer) { const file: FileItem = { id, parentId, name, isDir, size: bytes?.length || 0, accountId, platform: 'webdav', createdAt: stamp, updatedAt: stamp }; remote.set(id, { file, bytes }); return file }
function installAdapter() {
  insertAccount({ id: accountId, platform: 'webdav', nickname: '规则测试归档盘', login_type: 'password', encrypted_credential: encryptCredential('{}'), user_agent: null, status: 'active', bind_machine: 1, created_at: stamp, updated_at: stamp, last_check_at: null })
  const adapter = getAdapter('webdav')
  adapter.listFiles = async (account, parentId) => { accountOnly(account); return { files: children(parentId), parentId, hasMore: false } }
  adapter.checkLogin = async account => { accountOnly(account); return true }
  adapter.getQuota = async account => { accountOnly(account); return { used: 0, total: 1024 ** 3 } }
  adapter.mkdir = async (account, parentId, name) => { accountOnly(account); if (children(parentId).some(file => file.name === name)) throw new Error('Unexpected directory collision'); writes.push({ action: 'mkdir', name }); return addFile(`directory-${++sequence}`, parentId, name, true) }
  adapter.upload = async (account, localFile, parentId, options) => { accountOnly(account); if (!owned(localFile) || !options?.fileName || options.overwrite || children(parentId).some(file => file.name === options.fileName)) throw new Error('Unexpected upload outside fixture objects'); options.signal?.throwIfAborted(); const bytes = readFileSync(localFile), file = addFile(`object-${++sequence}`, parentId, options.fileName, false, bytes); writes.push({ action: 'upload', name: file.name, size: bytes.length }); return { success: true, fileId: file.id, fileName: file.name, fileSize: bytes.length } }
  adapter.download = async (account, fileId, directory, options) => { accountOnly(account); options?.signal?.throwIfAborted(); const item = remote.get(fileId); if (!item?.bytes || !options?.fileName) throw new Error('Unknown fixture object'); const localPath = path.join(directory, options.fileName); if (!owned(localPath)) throw new Error('Download escaped isolated profile'); mkdirSync(directory, { recursive: true }); writeFileSync(localPath, item.bytes, { flag: 'wx' }); readbacks++; return { success: true, localPath, fileName: options.fileName, fileSize: item.bytes.length } }
  adapter.getDownloadSource = async (account, fileId) => { accountOnly(account); return { url: 'https://fixture.invalid/object', fetch: async () => { readbacks++; const item = remote.get(fileId); return item?.bytes ? new Response(item.bytes as unknown as BodyInit) : new Response(null, { status: 404 }) } } }
  const forbidden = async () => { throw new Error('Unexpected provider write') }; adapter.delete = forbidden; adapter.copy = forbidden; adapter.move = forbidden; adapter.rename = forbidden; adapter.getDownloadUrl = forbidden
  addFile('archive-root', '0', '规则归档', true)
  mkdirSync(source); mkdirSync(path.join(source, '资料')); mkdirSync(path.join(source, '空目录'))
  writeFileSync(path.join(source, '计划说明.txt'), 'Automation rule fixture document')
  writeFileSync(path.join(source, '资料', '会议记录.txt'), 'Nested fixture document')
  writeFileSync(path.join(source, '排除.tmp'), 'Must never upload')
}
async function evaluate<T = unknown>(win: BrowserWindow, code: string): Promise<T> { try { return await win.webContents.executeJavaScript(code) as T } catch (error) { console.error(`Renderer script failed: ${code}`); throw error } }
async function waitFor(win: BrowserWindow, predicate: string, attempts = 500) { for (let index = 0; index < attempts; index++) { if (await evaluate(win, predicate)) return; await new Promise(resolve => setTimeout(resolve, 50)) }; throw new Error(`Renderer state did not appear: ${predicate}\n${await evaluate(win, 'document.body.innerText')}`) }
async function click(win: BrowserWindow, label: string) { await waitFor(win, `Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()===${JSON.stringify(label)}&&!button.disabled)`); await evaluate(win, `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)}&&!button.disabled).click()`) }
async function setControl(win: BrowserWindow, selector: string, value: string, event = 'input') { await waitFor(win, `!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`); await evaluate(win, `(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`) }
async function chooseRule(win: BrowserWindow, name: string) { await waitFor(win, `Array.from(document.querySelectorAll('.rule-item')).some(item=>item.querySelector('strong').textContent===${JSON.stringify(name)})`); await evaluate(win, `Array.from(document.querySelectorAll('.rule-item')).find(item=>item.querySelector('strong').textContent===${JSON.stringify(name)}).click()`); await waitFor(win, `document.querySelector('input[aria-label="规则名称"]').value===${JSON.stringify(name)}`) }
async function scrollTo(win: BrowserWindow, selector: string) { await evaluate(win, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`) }
async function capture(win: BrowserWindow, theme: string, file: string) { await new Promise(resolve => setTimeout(resolve, 200)); const geometry = await evaluate<{ width: number; bodyOverflow: boolean; pageOverflow: boolean; rootDark: boolean }>(win, `(()=>{const page=document.querySelector('.automation-page');return {width:innerWidth,bodyOverflow:document.body.scrollWidth>innerWidth,pageOverflow:page.scrollWidth>page.clientWidth+1,rootDark:document.documentElement.classList.contains('dark')};})()`); if (geometry.bodyOverflow || geometry.pageOverflow || geometry.rootDark !== (theme === 'dark')) throw new Error(`Invalid automation layout ${JSON.stringify(geometry)}`); writeFileSync(path.join(output, file), (await win.webContents.capturePage()).toPNG()); return { theme, file, geometry } }

app.whenReady().then(async () => {
  const errors: string[] = [], screenshots: Awaited<ReturnType<typeof capture>>[] = []
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(new URL(details.url).origin); callback({ cancel: true }) })
  globalThis.fetch = async () => { network.push('blocked-main-fetch'); throw new Error('External network is disabled') }
  initDatabase(); setSetting('theme', 'light'); setSetting('transferTempDir', path.join(profile, 'transfer-temp')); installAdapter(); registerIpcHandlers()
  const backups = getFileBackupService(), service = getAutomationRuleService()
  const savedPlan = await backups.savePlan({ name: '项目文件每日归档', sourcePath: source, target: { accountId, rootId: 'archive-root', rootPath: '/规则归档' }, exclude: ['*.tmp'], keepLast: 10, keepDays: 0 })
  if (!savedPlan.success) throw new Error(savedPlan.error)
  const plan = savedPlan.plan, actionKey = JSON.stringify(['backup', plan.id, plan.version])
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true } })
  win.removeMenu(); win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  async function savedRule(name: string): Promise<AutomationRule> { const result = await service.listRules(); if (!result.success) throw new Error(result.error); const rule = result.rules.find(item => item.name === name); if (!rule) throw new Error(`Rule not saved: ${name}`); return rule }
  async function waitRun(ruleId: string): Promise<AutomationRun> { for (let attempt = 0; attempt < 800; attempt++) { await service.waitForIdle(); service.reconcile(); const run = service.store.runs(ruleId)[0]; if (run && ['success', 'failed', 'attention'].includes(run.status)) { if (run.status !== 'success') throw new Error(`Rule execution failed: ${JSON.stringify(run)}`); return run }; await new Promise(resolve => setTimeout(resolve, 50)) }; throw new Error('Rule did not complete') }
  try {
    await win.loadFile(path.join(__dirname, '../../renderer/index.html'), { hash: '/automation-rules' }); await waitFor(win, '!!document.querySelector(".rule-form")&&!document.querySelector("select[aria-label=执行计划版本]").disabled')
    await setControl(win, 'input[aria-label="规则名称"]', '项目手动归档'); await setControl(win, 'select[aria-label="执行计划版本"]', actionKey, 'change'); await click(win, '保存规则'); await waitFor(win, 'document.body.textContent.includes("规则已保存")')
    let main = await savedRule('项目手动归档'); if (main.enabled || main.trigger.kind !== 'manual') throw new Error('New manual rule was not saved paused')
    await click(win, '只读试运行'); await waitFor(win, '!!document.querySelector(".preview-result")')
    if (writes.length || service.store.runs(main.id).length || !(await evaluate(win, 'Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()==="手动执行").disabled'))) throw new Error('Paused preview mutated remote data or enabled manual dispatch')
    screenshots.push(await capture(win, 'light', 'automation-rules-paused-light-1280.png'))
    await click(win, '启用规则'); await waitFor(win, 'document.body.textContent.includes("规则已启用，后续按保存的触发方式执行")')
    await setControl(win, 'select[aria-label="触发方式"]', 'interval', 'change'); await setControl(win, 'input[aria-label="间隔分钟"]', '45'); await setControl(win, 'select[aria-label="错过执行时间"]', 'run_once', 'change'); await click(win, '保存规则'); await waitFor(win, 'document.body.textContent.includes("规则已保存")')
    main = await savedRule('项目手动归档'); if (main.trigger.kind !== 'interval' || main.trigger.everyMinutes !== 45 || main.trigger.missed !== 'run_once') throw new Error('Interval trigger not persisted')
    await setControl(win, 'select[aria-label="触发方式"]', 'daily', 'change'); await setControl(win, 'input[aria-label="本机每天时间"]', '22:35'); await setControl(win, 'select[aria-label="错过执行时间"]', 'skip', 'change'); await click(win, '保存规则'); await waitFor(win, 'document.body.textContent.includes("规则已保存")')
    main = await savedRule('项目手动归档'); if (main.trigger.kind !== 'daily' || main.trigger.time !== '22:35' || main.trigger.missed !== 'skip') throw new Error('Daily local trigger not persisted')
    screenshots.push(await capture(win, 'light', 'automation-rules-daily-light-1280.png'))
    await setControl(win, 'select[aria-label="触发方式"]', 'manual', 'change'); await click(win, '保存规则'); await waitFor(win, 'document.body.textContent.includes("规则已保存")'); main = await savedRule('项目手动归档')
    await click(win, '新建'); await setControl(win, 'input[aria-label="规则名称"]', '归档成功后复核'); await setControl(win, 'select[aria-label="执行计划版本"]', actionKey, 'change'); await setControl(win, 'select[aria-label="触发方式"]', 'task_success', 'change'); await setControl(win, 'select[aria-label="成功触发来源规则"]', main.id, 'change'); await evaluate(win, 'document.querySelector("input[aria-label=保存后启用规则]").click()'); await click(win, '保存规则'); await waitFor(win, 'document.body.textContent.includes("规则已保存")')
    const follower = await savedRule('归档成功后复核'); if (!follower.enabled || follower.trigger.kind !== 'task_success' || follower.trigger.sourceRuleId !== main.id) throw new Error('Success dependency was not persisted')
    await chooseRule(win, main.name); await click(win, '只读试运行'); await waitFor(win, '!!document.querySelector(".preview-result")'); await click(win, '手动执行'); await waitFor(win, '!!document.querySelector(".run-confirmation")')
    if (writes.length || service.store.runs(main.id).length) throw new Error('Preview or confirmation opened a write task')
    await scrollTo(win, '.preview-panel'); screenshots.push(await capture(win, 'light', 'automation-rules-confirm-light-1280.png'))
    await click(win, '确认手动执行'); const manualRun = await waitRun(main.id)
    if (!manualRun.taskId || getTaskById(manualRun.taskId)?.status !== 'success') throw new Error('Rule did not use the real task queue')
    const queued = getTaskById(manualRun.taskId)!, payload = JSON.parse(queued.payload || '{}')
    if (payload._automation?.runId !== manualRun.id || payload._automation?.ruleId !== main.id) throw new Error('Task lost automation provenance')
    const uploadsAfterManual = writes.filter(item => item.action === 'upload').length
    const snapshot = backups.store.snapshots(plan.id)[0]
    if (snapshot?.status !== 'ready' || snapshot.fileCount !== 2 || snapshot.uploadedFiles !== 2 || uploadsAfterManual !== 3) throw new Error('Expected two verified content files plus one immutable version manifest')
    await service.tick(); const chainedRun = await waitRun(follower.id); await service.tick()
    if (service.store.runs(follower.id).length !== 1 || writes.filter(item => item.action === 'upload').length !== uploadsAfterManual || !readbacks || chainedRun.taskId) throw new Error('Success trigger duplicated work or skipped verified unchanged reuse')
    await click(win, '刷新历史'); await waitFor(win, 'document.querySelectorAll(".history-table tbody tr").length===1')
    // Reopen a concrete confirmation, then edit the version through another real
    // service caller. Renderer and atomic service CAS must both block old runs.
    await click(win, '只读试运行'); await waitFor(win, '!!document.querySelector(".preview-result")'); await click(win, '手动执行')
    const paused = await service.setEnabled({ id: main.id, expectedVersion: main.version, enabled: false }); if (!paused.success) throw new Error(paused.error)
    await click(win, '确认手动执行'); await waitFor(win, 'document.body.textContent.includes("规则版本已变化，本次未提交")')
    const staleResult = await service.runNow({ id: main.id, expectedVersion: main.version }); if (staleResult.success || staleResult.code !== 'RULE_VERSION' || service.store.runs(main.id).length !== 1) throw new Error('Stale confirmation was not rejected atomically')
    await click(win, '放弃草稿并读取最新规则'); await waitFor(win, 'document.body.textContent.includes("执行前请先启用规则")')
    const disabledResult = await service.runNow({ id: main.id, expectedVersion: paused.rule.version }); if (disabledResult.success || disabledResult.code !== 'RULE_DISABLED') throw new Error('Paused manual rule accepted a new run')
    setSetting('theme', 'dark'); win.setSize(960, 900); await win.loadURL('about:blank'); await win.loadFile(path.join(__dirname, '../../renderer/index.html'), { hash: '/automation-rules' }); await waitFor(win, '!!document.querySelector(".rule-form")'); await chooseRule(win, main.name)
    await click(win, '只读试运行'); await waitFor(win, '!!document.querySelector(".preview-result")'); await scrollTo(win, '.preview-panel'); screenshots.push(await capture(win, 'dark', 'automation-rules-history-dark-960.png'))
    await click(win, '查看任务'); await waitFor(win, '!!document.querySelector(".task-log")&&document.querySelectorAll(".task-row").length===1')
    const taskLocation = await evaluate<string>(win, 'location.hash'); if (!taskLocation.includes('from=automation-rules') || !taskLocation.includes(encodeURIComponent(manualRun.taskId))) throw new Error('Task location is not scoped to the rule run')
    writeFileSync(path.join(output, 'automation-rules-task-dark-960.png'), (await win.webContents.capturePage()).toPNG())
    if (network.length || errors.length) throw new Error(`Runtime diagnostics: ${JSON.stringify({ network, errors })}`)
    writeFileSync(path.join(output, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), electron: process.versions.electron, sqlite: getDb().prepare('SELECT sqlite_version() version').get(), scenario: 'Isolated real renderer/preload/IPC/SQLite/AutomationRuleService/FileBackupService/task queue and operation journal; only WebDAV adapter contents are synthetic', rendererActions: ['save paused manual rule with explicit backup version', 'read-only paused preview', 'enable rule', 'save interval with merged catch-up', 'save daily local time with skip', 'save success-trigger successor', 'preview and confirm exact rule version', 'complete backup through task queue', 'success-trigger unchanged backup verification', 'reject stale confirmation', 'reload paused rule', 'open task with rule return route'], planId: plan.id, mainRuleId: main.id, followerRuleId: follower.id, manualRun, chainedRun, uploadedFiles: snapshot.uploadedFiles, uploadedObjectsIncludingManifest: uploadsAfterManual, successorUploads: 0, successorRuns: 1, pausedRuleBlocked: true, staleVersionBlocked: true, previewWrites: 0, readbacks, taskLocation, screenshots, rendererErrors: errors, externalRequests: network.length }, null, 2))
    console.log('Automation rules Electron UI, version CAS, queue and success trigger passed')
  } catch (error) { writeFileSync(path.join(output, 'failure-state.txt'), String(await evaluate(win, 'document.body.innerText').catch(() => 'Renderer unavailable'))); writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); throw error }
  finally { cleanupIpcResources(); win.destroy() }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
