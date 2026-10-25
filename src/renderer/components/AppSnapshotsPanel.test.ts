// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppSnapshotInfo, PendingAppSnapshotOperation } from '@shared/app-snapshots'
const api = vi.hoisted(() => ({ listSnapshots: vi.fn(), requestSnapshot: vi.fn(), inspectSnapshot: vi.fn(), requestRestore: vi.fn(), getPendingOperation: vi.fn(), cancelPendingOperation: vi.fn() }))
vi.mock('../api/app-snapshots', () => ({ appSnapshotsApi: api }))
import AppSnapshotsPanel from './AppSnapshotsPanel.vue'
const now = Date.now()
function snapshot(id = 'snapshot-a'): AppSnapshotInfo { return { id, name: id === 'snapshot-a' ? '升级前' : '更早版本', createdAt: now, appVersion: '1.2.0', formatVersion: 1, state: 'ready', fileCount: 51, totalBytes: 4096, sameMachineOnly: true, managedRoots: ['panlite.db', 'url-crypto.key', 'ai-attachments'], externalAiSources: 3 } }
function inspection(id = 'snapshot-a') { return { success: true, snapshot: snapshot(id), files: Array.from({ length: 51 }, (_, index) => ({ path: `附件-${index}.txt`, size: 32, sha256: `sha256-${index}` })), migrationIds: ['001', '013'], schemaVersions: { catalog: 1 }, verified: true } }
function pending(kind: 'snapshot' | 'restore' = 'snapshot'): PendingAppSnapshotOperation { return { id: 'request-a', kind, status: 'requested', snapshotId: 'snapshot-a', requestedAt: now, canCancel: true } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let wrapper: VueWrapper | undefined
beforeEach(() => { vi.resetAllMocks(); api.listSnapshots.mockResolvedValue({ success: true, snapshots: [snapshot(), snapshot('snapshot-b')] }); api.getPendingOperation.mockResolvedValue({ success: true, pending: null }); api.inspectSnapshot.mockImplementation(id => Promise.resolve(inspection(id))); api.requestSnapshot.mockResolvedValue({ success: true, pending: pending(), restartRequired: true }); api.requestRestore.mockResolvedValue({ success: true, pending: pending('restore'), restartRequired: true }); api.cancelPendingOperation.mockResolvedValue({ success: true }) })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })
async function render() { wrapper = mount(AppSnapshotsPanel); await flushPromises(); return wrapper }
function button(view: VueWrapper, label: string) { const result = view.findAll('button').find(item => item.text() === label); if (!result) throw new Error(`Missing button ${label}`); return result }

it('requires explicit restart confirmation before creating a snapshot', async () => {
  const view = await render(); await view.get('input[aria-label="应用快照名称"]').setValue('本次升级前'); await view.get('form').trigger('submit'); expect(api.requestSnapshot).not.toHaveBeenCalled()
  expect(view.text()).toContain('创建和恢复均需重启 PanLite'); await view.get('input[aria-label="确认重启创建应用快照"]').setValue(true); await view.get('form').trigger('submit'); await flushPromises()
  expect(api.requestSnapshot).toHaveBeenCalledWith('本次升级前'); expect(view.text()).toContain('应用即将重启'); expect(view.get('input[aria-label="应用快照名称"]').attributes('disabled')).toBeDefined()
})

it('inspects the exact snapshot, displays replacement scope and submits only confirmed restoration', async () => {
  const view = await render(); await view.get('select[aria-label="选择应用快照"]').setValue('snapshot-a'); await flushPromises()
  expect(api.inspectSnapshot).toHaveBeenCalledWith('snapshot-a'); expect(view.get('.snapshot-inspection').text()).toContain('panlite.db、url-crypto.key、ai-attachments'); expect(view.text()).toContain('3 个外部 AI 源文件引用')
  expect(button(view, '重启并恢复此快照').attributes('disabled')).toBeDefined(); await view.get('input[aria-label="确认覆盖并重启恢复应用快照"]').setValue(true); await button(view, '重启并恢复此快照').trigger('click'); await flushPromises()
  expect(api.requestRestore).toHaveBeenCalledWith('snapshot-a'); expect(view.text()).toContain('恢复请求已保存')
})

it('never enables restoring a snapshot that failed verification', async () => {
  api.inspectSnapshot.mockResolvedValueOnce({ ...inspection(), verified: false, snapshot: { ...snapshot(), state: 'invalid', error: '哈希校验失败' } }); const view = await render(); await view.get('select[aria-label="选择应用快照"]').setValue('snapshot-a'); await flushPromises()
  expect(view.text()).toContain('哈希校验失败'); expect(view.get('input[aria-label="确认覆盖并重启恢复应用快照"]').attributes('disabled')).toBeDefined(); expect(button(view, '重启并恢复此快照').attributes('disabled')).toBeDefined(); expect(api.requestRestore).not.toHaveBeenCalled()
})

it('discards older inspections and resets confirmation when switching snapshots', async () => {
  const view = await render(), late = deferred<unknown>(); api.inspectSnapshot.mockReturnValueOnce(late.promise); await view.get('select[aria-label="选择应用快照"]').setValue('snapshot-a'); await view.get('select[aria-label="选择应用快照"]').setValue('snapshot-b'); await flushPromises()
  late.resolve(inspection()); await flushPromises(); expect(view.get('.snapshot-inspection h3').text()).toBe('更早版本'); await view.get('input[aria-label="确认覆盖并重启恢复应用快照"]').setValue(true)
  await view.get('select[aria-label="选择应用快照"]').setValue('snapshot-a'); await flushPromises(); expect(view.get('input[aria-label="确认覆盖并重启恢复应用快照"]').element).toHaveProperty('checked', false)
})

it('paginates managed files and rechecks after a rejected restore request', async () => {
  const view = await render(); await view.get('select[aria-label="选择应用快照"]').setValue('snapshot-a'); await flushPromises(); expect(view.findAll('tbody tr')).toHaveLength(50); await button(view, '下一页受管文件').trigger('click'); expect(view.findAll('tbody tr')).toHaveLength(1); expect(view.get('tbody').text()).toContain('附件-50.txt')
  api.requestRestore.mockResolvedValueOnce({ success: false, error: '快照已损坏' }); await view.get('input[aria-label="确认覆盖并重启恢复应用快照"]').setValue(true); await button(view, '重启并恢复此快照').trigger('click'); await flushPromises(); expect(view.find('.snapshot-inspection').exists()).toBe(false); expect(view.text()).toContain('请重新检查快照后再提交')
})

it('uses the backend cancellation capability for failed requests', async () => {
  api.getPendingOperation.mockResolvedValueOnce({ success: true, pending: { ...pending('restore'), status: 'failed', canCancel: false, error: '需要继续恢复事务' } }); const view = await render(); expect(view.text()).not.toContain('取消尚未执行的请求'); expect(view.text()).toContain('请关闭并重新打开应用')
  api.getPendingOperation.mockResolvedValueOnce({ success: true, pending: { ...pending(), status: 'failed', canCancel: true } }); await button(view, '刷新快照').trigger('click'); await flushPromises(); await button(view, '取消尚未执行的请求').trigger('click'); await flushPromises(); expect(api.cancelPendingOperation).toHaveBeenCalledOnce(); expect(view.find('.snapshot-pending').exists()).toBe(false)
})
