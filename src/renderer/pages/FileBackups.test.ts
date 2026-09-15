// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FileBackupPlan, FileBackupPreview, FileBackupSnapshot, FileRestorePreview, FileBackupJob, FileBackupRetentionPreview } from '@shared/file-backup'

const api = vi.hoisted(() => ({ listPlans: vi.fn(), savePlan: vi.fn(), removePlan: vi.fn(), previewBackup: vi.fn(), getBackupPreview: vi.fn(), executeBackup: vi.fn(), listSnapshots: vi.fn(), getSnapshot: vi.fn(), previewRestore: vi.fn(), getRestorePreview: vi.fn(), executeRestore: vi.fn(), retentionPreview: vi.fn(), getRetentionPreview: vi.fn(), prune: vi.fn(), listJobs: vi.fn(), getJob: vi.fn() }))
const electron = vi.hoisted(() => ({ listAccounts: vi.fn(), listFiles: vi.fn(), showOpenDialog: vi.fn() }))
const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('../api/file-backups', () => ({ fileBackupsApi: api }))
vi.mock('../api/ipc', () => ({ electronApi: electron }))
vi.mock('vue-router', () => ({ useRouter: () => navigation }))
import FileBackups from './FileBackups.vue'
import FileBackupVersions from '../components/FileBackupVersions.vue'
import FileBackupRetention from '../components/FileBackupRetention.vue'
import FileBackupJobs from '../components/FileBackupJobs.vue'

const now = Date.now(), target = { accountId: 'webdav', rootId: 'archive', rootPath: '/备份' }
function plan(id = 'plan-a'): FileBackupPlan { return { id, name: id === 'plan-a' ? '工作文档' : '个人照片', sourcePath: 'D:\\工作', target, exclude: ['*.tmp'], keepLast: 5, keepDays: 30, version: 2, createdAt: now, updatedAt: now } }
function preview(id = 'plan-a'): FileBackupPreview { return { id: `preview-${id}`, planId: id, planVersion: 2, fingerprint: 'fingerprint', createdAt: now, complete: true, executable: true, unchanged: false, fileCount: 51, directoryCount: 1, totalBytes: 2048, uploadFiles: 1, uploadBytes: 1024, reusedFiles: 50, excludedCount: 1, failures: [] } }
function snapshot(id = 'snapshot-a'): FileBackupSnapshot { return { id, planId: 'plan-a', planVersion: 2, status: 'ready', fingerprint: 'fingerprint', sourcePath: 'D:\\工作', createdAt: now, fileCount: 51, directoryCount: 1, totalBytes: 2048, uploadedFiles: 1, reusedFiles: 50 } }
function restore(): FileRestorePreview { return { id: 'restore-a', snapshotId: 'snapshot-a', planId: 'plan-a', targetPath: 'D:\\恢复', overwrite: false, createdAt: now, executable: true, fileCount: 51, directoryCount: 1, totalBytes: 2048, overwriteCount: 0, failures: [] } }
function job(id = 'job-a'): FileBackupJob { return { id, planId: 'plan-a', previewId: 'preview-plan-a', snapshotId: 'snapshot-a', kind: 'backup', taskId: `task-${id}`, taskStatus: 'running', status: 'running', totalItems: 51, completedItems: 50, createdAt: now, updatedAt: now } }
function retention(): FileBackupRetentionPreview { return { id: 'retention-a', planId: 'plan-a', planVersion: 2, createdAt: now, executable: true, snapshotIds: ['snapshot-a'], retainedSnapshotCount: 0, objectCount: 51, reclaimBytes: 2048, warnings: ['本次会删除最后一个可恢复版本。'] } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.resetAllMocks()
  api.listPlans.mockResolvedValue({ success: true, plans: [plan(), plan('plan-b')] })
  api.savePlan.mockResolvedValue({ success: true, plan: { ...plan(), version: 3 } }); api.removePlan.mockResolvedValue({ success: true })
  api.listJobs.mockResolvedValue({ success: true, jobs: [] })
  api.previewBackup.mockImplementation(id => Promise.resolve({ success: true, preview: preview(id) }))
  api.getBackupPreview.mockImplementation(input => Promise.resolve({ success: true, preview: preview(input.previewId.replace('preview-', '')), items: [{ relativePath: input.page === 2 ? '末页文件.txt' : '项目文件.txt', isDir: false, size: 1024, action: 'reuse' }], total: 51, page: input.page || 1, pageSize: 50 }))
  api.executeBackup.mockResolvedValue({ success: true, snapshot: snapshot(), unchanged: true })
  api.listSnapshots.mockResolvedValue({ success: true, snapshots: [snapshot()], total: 1, page: 1, pageSize: 50 })
  api.getSnapshot.mockImplementation(input => Promise.resolve({ success: true, snapshot: snapshot(input.snapshotId), entries: [{ relativePath: '版本文件.txt', isDir: false, size: 1024, sha256: 'sha256' }], total: 51, page: input.page || 1, pageSize: 50 }))
  api.previewRestore.mockResolvedValue({ success: true, preview: restore() })
  api.getRestorePreview.mockImplementation(input => Promise.resolve({ success: true, preview: restore(), items: [{ relativePath: '版本文件.txt', isDir: false, size: 1024, action: 'create' }], total: 51, page: input.page || 1, pageSize: 50 }))
  api.executeRestore.mockResolvedValue({ success: true, job: { ...job(), kind: 'restore' }, taskId: 'task-restore' })
  api.retentionPreview.mockResolvedValue({ success: true, preview: retention() })
  api.getRetentionPreview.mockImplementation(input => Promise.resolve({ success: true, preview: retention(), objects: [{ objectId: 'object-a', name: 'content-object', size: 1024, sha256: 'sha256', referenceCount: 1, state: 'verified' }], total: 51, page: input.page || 1, pageSize: 50 }))
  api.prune.mockResolvedValue({ success: true, job: { ...job(), kind: 'prune' }, taskId: 'task-prune' })
  api.getJob.mockImplementation(input => Promise.resolve({ success: true, job: job(input.jobId), items: [{ itemId: 'item-a', path: input.page === 2 ? '末页结果.txt' : '项目文件.txt', status: 'success', updatedAt: now }], total: 51, page: input.page || 1, pageSize: 50 }))
  electron.listAccounts.mockResolvedValue({ success: true, accounts: [{ id: 'webdav', nickname: '家庭备份盘', platform: 'webdav', status: 'active' }, { id: 'quark', nickname: '夸克', platform: 'quark', status: 'active' }] })
  electron.listFiles.mockResolvedValue({ success: true, files: [], parentId: '0', hasMore: false })
  electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['D:\\恢复'] })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })
function button(view: VueWrapper, label: string) { const result = view.findAll('button').find(item => item.text() === label); if (!result) throw new Error(`Missing button ${label}`); return result }
async function render() { wrapper = mount(FileBackups); await flushPromises(); return wrapper }
async function versions() { wrapper = mount(FileBackupVersions, { props: { planId: 'plan-a', busy: false, refreshKey: 0, selectedSnapshots: [] } }); await flushPromises(); await wrapper.get('.snapshot-table tbody button').trigger('click'); await flushPromises(); return wrapper }

it('retains the draft and saved version after a rejected save', async () => {
  const view = await render(); await view.get('input[aria-label="备份计划名称"]').setValue('变更后的计划'); await view.get('input[aria-label="保留版本数"]').setValue(8)
  api.savePlan.mockResolvedValueOnce({ success: false, code: 'PLAN_VERSION', error: '配置版本已变化，请重新读取' })
  await view.get('form.backup-plan-form').trigger('submit'); await flushPromises()
  expect(api.savePlan).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan-a', expectedVersion: 2, name: '变更后的计划', keepLast: 8 }))
  expect(view.get('input[aria-label="备份计划名称"]').element).toHaveProperty('value', '变更后的计划'); expect(view.text()).toContain('配置版本已变化')
  expect(button(view, '生成备份预演').attributes('disabled')).toBeDefined()
})

it('creates a plan from a native local directory and a real WebDAV folder', async () => {
  api.listPlans.mockResolvedValueOnce({ success: true, plans: [] }); const view = await render()
  await view.get('input[aria-label="备份计划名称"]').setValue('本地文档'); await button(view, '选择本地源目录').trigger('click'); await flushPromises()
  await button(view, '选择 WebDAV 目录').trigger('click'); expect(view.get('select[aria-label="目录账号"]').text()).not.toContain('夸克')
  electron.listFiles.mockResolvedValueOnce({ success: true, files: [{ id: 'selected-folder', name: '历史版本', isDir: true, path: '/历史版本' }], hasMore: false })
  await view.get('select[aria-label="目录账号"]').setValue('webdav'); await flushPromises(); await view.get('.folder').trigger('click'); await flushPromises(); await button(view, '选择当前目录').trigger('click')
  await view.get('form.backup-plan-form').trigger('submit'); await flushPromises()
  expect(electron.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openDirectory'] }))
  expect(api.savePlan).toHaveBeenCalledWith(expect.objectContaining({ name: '本地文档', sourcePath: 'D:\\恢复', target: { accountId: 'webdav', rootId: 'selected-folder', rootPath: '/历史版本' } }))
})

it('ignores a late native directory choice after switching the plan', async () => {
  const view = await render(), late = deferred<unknown>(); electron.showOpenDialog.mockReturnValueOnce(late.promise)
  await button(view, '选择本地源目录').trigger('click'); await view.findAll('.backup-plan-item')[1].trigger('click'); await flushPromises()
  late.resolve({ canceled: false, filePaths: ['D:\\旧请求'] }); await flushPromises(); expect(view.get('form.backup-plan-form').text()).not.toContain('D:\\旧请求')
})

it('rejects a late preview belonging to another plan', async () => {
  const view = await render(), late = deferred<unknown>(); api.previewBackup.mockReturnValueOnce(late.promise)
  await button(view, '生成备份预演').trigger('click'); await view.findAll('.backup-plan-item')[1].trigger('click'); await flushPromises(); await button(view, '生成备份预演').trigger('click'); await flushPromises()
  late.resolve({ success: true, preview: { ...preview(), failures: [{ path: '旧计划', error: '旧错误' }] } }); await flushPromises()
  expect(view.get('.backup-preview-panel').text()).not.toContain('旧错误'); expect(api.getBackupPreview).toHaveBeenLastCalledWith(expect.objectContaining({ previewId: 'preview-plan-b' }))
})

it('paginates the backup preview and commits its exact version only after confirmation', async () => {
  const view = await render(); await button(view, '生成备份预演').trigger('click'); await flushPromises()
  expect(button(view, '确认执行备份').attributes('disabled')).toBeDefined(); await button(view, '下一页备份清单').trigger('click'); await flushPromises()
  expect(view.get('.backup-preview-panel').text()).toContain('末页文件.txt'); expect(api.getBackupPreview).toHaveBeenLastCalledWith({ previewId: 'preview-plan-a', page: 2, pageSize: 50 })
  await view.get('input[aria-label="确认备份预演"]').setValue(true); await button(view, '确认执行备份').trigger('click'); await flushPromises()
  expect(api.executeBackup).toHaveBeenCalledWith({ planId: 'plan-a', previewId: 'preview-plan-a' }); expect(view.text()).toContain('源内容无变化，复用已有已校验版本，0 上传')
  await button(view, '查看复用版本').trigger('click'); await flushPromises(); expect(api.getSnapshot).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: 'snapshot-a' })); expect(navigation.push).not.toHaveBeenCalled()
})

it('blocks an expired backup preview and guides regeneration', async () => {
  const view = await render(); await button(view, '生成备份预演').trigger('click'); await flushPromises(); api.executeBackup.mockResolvedValueOnce({ success: false, code: 'STALE_PREVIEW', error: '源文件发生变化' })
  await view.get('input[aria-label="确认备份预演"]').setValue(true); await button(view, '确认执行备份').trigger('click'); await flushPromises()
  expect(view.text()).toContain('请重新生成备份预演'); expect(button(view, '确认执行备份').attributes('disabled')).toBeDefined(); expect(button(view, '生成备份预演').attributes('disabled')).toBeUndefined()
})

it('locks configuration for a paused task and unlocks after terminal report refresh', async () => {
  api.listJobs.mockResolvedValue({ success: true, jobs: [{ ...job(), taskStatus: 'paused' }] }); api.getJob.mockResolvedValueOnce({ success: true, job: { ...job(), taskStatus: 'paused' }, items: [], total: 0, page: 1, pageSize: 50 })
  const view = await render(); expect(view.get('input[aria-label="备份计划名称"]').attributes('disabled')).toBeDefined()
  api.getJob.mockResolvedValueOnce({ success: true, job: { ...job(), status: 'completed', taskStatus: 'success' }, items: [], total: 0, page: 1, pageSize: 50 })
  await button(view, '刷新本页报告').trigger('click'); await flushPromises(); expect(view.get('input[aria-label="备份计划名称"]').attributes('disabled')).toBeUndefined()
  expect(view.get('select[aria-label="选择备份作业"]').text()).toContain('已完成')
})

it('does not offer restoring a failed version', async () => {
  api.getSnapshot.mockResolvedValueOnce({ success: true, snapshot: { ...snapshot(), status: 'failed', error: '校验失败' }, entries: [], total: 0, page: 1, pageSize: 50 })
  const view = await versions(); expect(view.text()).toContain('当前不能用于恢复'); expect(view.find('.restore-form').exists()).toBe(false); expect(api.previewRestore).not.toHaveBeenCalled()
})

it('invalidates restore approval when overwrite changes and sends the chosen mode', async () => {
  const view = await versions(); await button(view, '选择恢复目录').trigger('click'); await flushPromises(); await view.get('.restore-form').trigger('submit'); await flushPromises(); await view.get('input[aria-label="确认恢复范围"]').setValue(true)
  await view.get('input[aria-label="允许覆盖恢复目标"]').setValue(true); expect(view.find('.restore-preview').exists()).toBe(false); expect(api.executeRestore).not.toHaveBeenCalled()
  await view.get('.restore-form').trigger('submit'); await flushPromises(); expect(api.previewRestore).toHaveBeenLastCalledWith({ snapshotId: 'snapshot-a', targetPath: 'D:\\恢复', overwrite: true })
  await view.get('input[aria-label="确认恢复范围"]').setValue(true); await button(view, '确认执行恢复').trigger('click'); await flushPromises(); expect(api.executeRestore).toHaveBeenCalledWith('restore-a'); expect(view.emitted('job')).toHaveLength(1)
})

it('ignores a restore preflight result after choosing another version', async () => {
  api.listSnapshots.mockResolvedValue({ success: true, snapshots: [snapshot(), snapshot('snapshot-b')], total: 2, page: 1, pageSize: 50 })
  const view = await versions(), late = deferred<unknown>(); await button(view, '选择恢复目录').trigger('click'); await flushPromises(); api.previewRestore.mockReturnValueOnce(late.promise)
  await view.get('.restore-form').trigger('submit'); await view.findAll('.snapshot-table tbody button')[1].trigger('click'); await flushPromises(); late.resolve({ success: true, preview: restore() }); await flushPromises()
  expect(view.find('.restore-preview').exists()).toBe(false); expect(api.getRestorePreview).not.toHaveBeenCalled(); expect(button(view, '选择恢复目录').attributes('disabled')).toBeUndefined()
})

it('retains selected files and directories across pages and invalidates their restore preview on changes', async () => {
  api.getSnapshot.mockImplementation(input => Promise.resolve({ success: true, snapshot: snapshot(input.snapshotId), entries: input.page === 2 ? [{ relativePath: '年度资料', isDir: true, size: 0 }] : [{ relativePath: '报告.txt', isDir: false, size: 100, sha256: 'sha' }], total: 51, page: input.page || 1, pageSize: 50 }))
  const view = await versions(); await view.get('input[aria-label="选择恢复条目报告.txt"]').setValue(true); await button(view, '下一页目录').trigger('click'); await flushPromises(); await view.get('input[aria-label="选择恢复条目年度资料"]').setValue(true)
  await button(view, '上一页目录').trigger('click'); await flushPromises(); expect(view.get('input[aria-label="选择恢复条目报告.txt"]').element).toHaveProperty('checked', true)
  await button(view, '选择恢复目录').trigger('click'); await flushPromises(); await view.get('.restore-form').trigger('submit'); await flushPromises()
  expect(api.previewRestore).toHaveBeenLastCalledWith({ snapshotId: 'snapshot-a', targetPath: 'D:\\恢复', overwrite: false, relativePaths: ['报告.txt', '年度资料'] })
  await view.get('input[aria-label="确认恢复范围"]').setValue(true); await view.get('input[aria-label="选择恢复条目报告.txt"]').setValue(false); expect(view.find('.restore-preview').exists()).toBe(false)
  await view.get('select[aria-label="恢复范围"]').setValue('all'); await view.get('.restore-form').trigger('submit'); await flushPromises(); expect(api.previewRestore).toHaveBeenLastCalledWith({ snapshotId: 'snapshot-a', targetPath: 'D:\\恢复', overwrite: false })
})

it('clears restore entry selection when opening a different snapshot', async () => {
  api.listSnapshots.mockResolvedValue({ success: true, snapshots: [snapshot(), snapshot('snapshot-b')], total: 2, page: 1, pageSize: 50 })
  const view = await versions(); await view.get('input[aria-label="选择恢复条目版本文件.txt"]').setValue(true); await view.findAll('.snapshot-table tbody button')[1].trigger('click'); await flushPromises()
  expect(view.get('input[aria-label="选择恢复条目版本文件.txt"]').element).toHaveProperty('checked', false); expect(view.get('select[aria-label="恢复范围"]').element).toHaveProperty('value', 'all')
})

it('shows the last-version warning and exact object list before cleanup submission', async () => {
  wrapper = mount(FileBackupRetention, { props: { plan: plan(), selectedSnapshots: [snapshot()], busy: false } }); const view = wrapper
  await button(view, '预演清理所选 1 个版本').trigger('click'); await flushPromises(); expect(api.retentionPreview).toHaveBeenCalledWith({ planId: 'plan-a', snapshotIds: ['snapshot-a'] })
  expect(view.text()).toContain('本次会删除最后一个可恢复版本'); expect(view.text()).toContain('content-object'); expect(button(view, '确认清理此预演').attributes('disabled')).toBeDefined()
  await button(view, '下一页清理对象').trigger('click'); await flushPromises(); expect(api.getRetentionPreview).toHaveBeenLastCalledWith({ previewId: 'retention-a', page: 2, pageSize: 50 })
  await view.get('input[aria-label="确认版本清理范围"]').setValue(true); await button(view, '确认清理此预演').trigger('click'); await flushPromises(); expect(api.prune).toHaveBeenCalledWith('retention-a'); expect(view.emitted('job')).toHaveLength(1)
})

it('invalidates cleanup preview when the chosen snapshots change', async () => {
  wrapper = mount(FileBackupRetention, { props: { plan: plan(), selectedSnapshots: [snapshot()], busy: false } }); const view = wrapper
  await button(view, '按保留策略预演清理').trigger('click'); await flushPromises(); await view.get('input[aria-label="确认版本清理范围"]').setValue(true)
  await view.setProps({ selectedSnapshots: [] }); expect(view.find('.retention-preview').exists()).toBe(false); expect(api.prune).not.toHaveBeenCalled()
})

it('keeps the current job report when an older page arrives after a job switch', async () => {
  wrapper = mount(FileBackupJobs, { props: { jobs: [job(), job('job-b')], loading: false, error: '', refreshKey: 0 } }); const view = wrapper; await flushPromises()
  const late = deferred<unknown>(); api.getJob.mockReturnValueOnce(late.promise); await button(view, '下一页作业报告').trigger('click'); await view.get('select[aria-label="选择备份作业"]').setValue('job-b'); await flushPromises()
  late.resolve({ success: true, job: job(), items: [{ itemId: 'old', path: '旧作业文件', status: 'failed', updatedAt: now }], total: 51, page: 2, pageSize: 50 }); await flushPromises()
  expect(view.text()).not.toContain('旧作业文件'); await button(view, '查看作业任务').trigger('click'); expect(navigation.push).toHaveBeenCalledWith({ path: '/tasks', query: { taskId: 'task-job-b', from: 'file-backups' } })
})

it('background: preserves retention-only draft edits when the first plan listing arrives late', async () => {
  const late = deferred<unknown>(); api.listPlans.mockReturnValueOnce(late.promise)
  wrapper = mount(FileBackups); const view = wrapper
  await view.get('input[aria-label="保留版本数"]').setValue(9)
  await view.get('textarea[aria-label="备份排除规则"]').setValue('**/本地缓存/**')
  late.resolve({ success: true, plans: [plan()] }); await flushPromises()
  expect(view.get('input[aria-label="保留版本数"]').element).toHaveProperty('value', '9')
  expect(view.get('textarea[aria-label="备份排除规则"]').element).toHaveProperty('value', '**/本地缓存/**')
  expect(view.get('form.backup-plan-form').text()).toContain('新建备份计划')
})

it('background: a paused job learned from the list survives an older in-flight report and a report failure', async () => {
  api.listJobs.mockResolvedValue({ success: true, jobs: [job()] })
  const view = await render(), late = deferred<unknown>()
  api.getJob.mockReturnValueOnce(late.promise); await button(view, '刷新本页报告').trigger('click')
  api.listJobs.mockResolvedValue({ success: true, jobs: [{ ...job(), taskStatus: 'paused' }] })
  await button(view, '刷新作业').trigger('click'); await flushPromises()
  late.resolve({ success: true, job: job(), items: [], total: 0, page: 1, pageSize: 50 }); await flushPromises()
  expect(view.get('.backup-jobs .backup-subpanel h3').text()).toContain('已暂停')
  expect(view.get('select[aria-label="选择备份作业"]').text()).toContain('已暂停')
  expect(view.get('input[aria-label="备份计划名称"]').attributes('disabled')).toBeDefined()
  api.getJob.mockResolvedValueOnce({ success: false, code: 'ACCOUNT_UNAVAILABLE', error: '目标账号失效，不能读取报告' })
  await button(view, '刷新本页报告').trigger('click'); await flushPromises()
  expect(view.get('.backup-jobs .backup-subpanel h3').text()).toContain('已暂停')
  expect(view.text()).toContain('目标账号失效，不能读取报告')
  expect(api.executeBackup).not.toHaveBeenCalled()
})

it('background: an older job list cannot overwrite a later completed report or a dirty draft', async () => {
  api.listJobs.mockResolvedValue({ success: true, jobs: [{ ...job(), status: 'completed', taskStatus: 'success' }] })
  api.getJob.mockImplementation(() => Promise.resolve({ success: true, job: { ...job(), status: 'completed', taskStatus: 'success' }, items: [], total: 0, page: 1, pageSize: 50 }))
  const view = await render(), late = deferred<unknown>()
  await view.get('input[aria-label="备份计划名称"]').setValue('未保存的计划名称')
  api.listJobs.mockReturnValueOnce(late.promise); await button(view, '刷新作业').trigger('click')
  await button(view, '刷新本页报告').trigger('click'); await flushPromises()
  const nextReport = deferred<unknown>(); api.getJob.mockReturnValueOnce(nextReport.promise)
  late.resolve({ success: true, jobs: [job()] }); await flushPromises()
  expect(view.get('input[aria-label="备份计划名称"]').element).toHaveProperty('value', '未保存的计划名称')
  expect(view.get('input[aria-label="备份计划名称"]').attributes('disabled')).toBeUndefined()
  expect(view.get('select[aria-label="选择备份作业"]').text()).toContain('已完成')
  nextReport.resolve({ success: true, job: { ...job(), status: 'completed', taskStatus: 'success' }, items: [], total: 0, page: 1, pageSize: 50 }); await flushPromises()
})

it('background: leaving the page during backup preview prevents follow-up reads or execution', async () => {
  const view = await render(), late = deferred<unknown>(); api.previewBackup.mockReturnValueOnce(late.promise)
  await button(view, '生成备份预演').trigger('click'); view.unmount(); wrapper = undefined
  late.resolve({ success: true, preview: preview() }); await flushPromises()
  expect(api.getBackupPreview).not.toHaveBeenCalled(); expect(api.executeBackup).not.toHaveBeenCalled(); expect(navigation.push).not.toHaveBeenCalled()
})

it('background: a plan list started before saving cannot restore the previous configuration', async () => {
  const view = await render(), late = deferred<unknown>()
  api.listPlans.mockReturnValueOnce(late.promise); await button(view, '刷新').trigger('click')
  await view.get('input[aria-label="备份计划名称"]').setValue('新的已保存配置')
  api.savePlan.mockResolvedValueOnce({ success: true, plan: { ...plan(), version: 3, name: '新的已保存配置' } })
  await view.get('form.backup-plan-form').trigger('submit'); await flushPromises()
  late.resolve({ success: true, plans: [plan(), plan('plan-b')] }); await flushPromises()
  expect(view.findAll('.backup-plan-item')[0].text()).toContain('新的已保存配置')
  await view.findAll('.backup-plan-item')[0].trigger('click'); await flushPromises()
  expect(view.get('input[aria-label="备份计划名称"]').element).toHaveProperty('value', '新的已保存配置')
  expect(view.get('form.backup-plan-form').text()).toContain('配置 v3')
})
