<template>
  <section class="app-snapshots-panel" aria-label="同机应用快照">
    <header class="snapshot-heading"><div><h2>同机应用快照</h2><p>将应用数据保存到一致的恢复点，适合升级或更改配置前使用。</p></div><button type="button" :disabled="loading || !!mutation" @click="refresh">刷新快照</button></header>
    <div class="snapshot-notice">创建和恢复均需重启 PanLite。快照包含应用数据库（含 AI 会话与解析文本）、受保护的 URL 密钥文件及应用管理的附件目录。恢复会替换这些数据，当前受管数据会先保存为回滚快照。</div>
    <p class="snapshot-muted">仅适用于同一台电脑的同一用户配置。登录会话、浏览器缓存、传输续传目录、AI 临时下载及外部 AI 原文件不在此快照中。</p>
    <p v-if="listError" class="snapshot-error" role="alert">{{ listError }}</p><p v-if="pendingError" class="snapshot-error" role="alert">{{ pendingError }}</p><p v-if="operationError" class="snapshot-error" role="alert">{{ operationError }}</p><p v-if="notice" class="snapshot-notice success" role="status">{{ notice }}</p>
    <section v-if="pending" class="snapshot-pending"><div class="snapshot-heading"><div><h3>{{ pending.kind === 'snapshot' ? '创建快照' : '恢复快照' }} · {{ PENDING_STATUS[pending.status] }}</h3><p>{{ pending.name || pending.snapshotId }} · {{ formatDate(pending.requestedAt) }}</p></div><button v-if="canCancel" type="button" :disabled="!!mutation" @click="cancelPending">取消尚未执行的请求</button></div><p v-if="pending.error" class="snapshot-error">{{ pending.error }}</p><p v-if="pending.status === 'running' || (pending.status === 'failed' && !canCancel)" class="snapshot-muted">数据替换事务需要在重启后继续完成。请关闭并重新打开应用。</p></section>
    <form class="snapshot-create" @submit.prevent="requestSnapshot"><h3>创建恢复点</h3><label>快照名称<input v-model="name" aria-label="应用快照名称" maxlength="120" placeholder="例如：升级前 2026-09-09" :disabled="blocked" /></label><label class="snapshot-checkbox"><input v-model="createConfirmed" type="checkbox" aria-label="确认重启创建应用快照" :disabled="blocked" />我已保存当前工作，同意重启应用后创建以上范围的快照</label><button type="submit" class="primary" :disabled="blocked || !name.trim() || !createConfirmed">{{ mutation === 'create' ? '正在安排重启…' : '重启并创建快照' }}</button></form>
    <section class="snapshot-restore"><div class="snapshot-heading"><h3>检查并恢复已有快照</h3><span class="snapshot-muted">{{ snapshots.length }} 个快照</span></div><div v-if="loading && !snapshots.length" class="snapshot-empty" role="status">正在读取快照…</div><div v-else-if="!snapshots.length && !listError" class="snapshot-empty">还没有应用快照。创建后将在这里显示。</div>
      <label v-if="snapshots.length">选择应用快照<select v-model="selectedId" aria-label="选择应用快照" :disabled="!!mutation"><option value="">请选择要检查的快照</option><option v-for="snapshot in snapshots" :key="snapshot.id" :value="snapshot.id">{{ snapshot.name }} · {{ formatDate(snapshot.createdAt) }} · {{ snapshot.state === 'ready' ? '可检查' : '无效' }}</option></select></label>
      <div v-if="inspecting" class="snapshot-empty" role="status">正在校验快照哈希、数据库与迁移兼容性…</div><p v-if="inspectionError" class="snapshot-error" role="alert">{{ inspectionError }} <button type="button" :disabled="inspecting || !!mutation" @click="inspect">重新检查</button></p>
      <section v-if="inspection && !inspecting" class="snapshot-inspection"><div class="snapshot-heading"><div><h3>{{ inspection.snapshot.name }}</h3><p>PanLite {{ inspection.snapshot.appVersion }} · {{ formatDate(inspection.snapshot.createdAt) }}</p></div><span class="snapshot-badge" :class="inspection.verified ? 'success' : 'warning'">{{ inspection.verified ? '校验通过' : '校验未通过' }}</span></div>
        <p v-if="inspection.snapshot.error" class="snapshot-error">{{ inspection.snapshot.error }}</p><p class="snapshot-muted">{{ inspection.snapshot.fileCount }} 个文件 · {{ formatSize(inspection.snapshot.totalBytes) }} · {{ inspection.migrationIds.length }} 项已记录迁移</p><p class="snapshot-scope"><strong>恢复时替换：</strong>{{ inspection.snapshot.managedRoots.join('、') || '没有可恢复的受管数据' }}</p><p class="snapshot-notice">此版本记录了 {{ inspection.snapshot.externalAiSources }} 个外部 AI 源文件引用，快照不包含这些原文件，恢复后仍需其原始位置可用。</p>
        <details class="snapshot-files"><summary>核对受管文件与 SHA-256</summary><div class="snapshot-table-scroll"><table><thead><tr><th>文件</th><th>大小 / 校验值</th></tr></thead><tbody><tr v-for="file in visibleFiles" :key="file.path"><td>{{ file.path }}</td><td>{{ formatSize(file.size) }}<details><summary>SHA-256</summary>{{ file.sha256 }}</details></td></tr></tbody></table></div><div class="snapshot-pagination"><span>{{ page }} / {{ filePages }} 页 · {{ inspection.files.length }} 个文件</span><button type="button" :disabled="page <= 1" @click="page--">上一页受管文件</button><button type="button" :disabled="page >= filePages" @click="page++">下一页受管文件</button></div></details>
        <label class="snapshot-checkbox"><input v-model="restoreConfirmed" type="checkbox" aria-label="确认覆盖并重启恢复应用快照" :disabled="blocked || !inspection.verified || inspection.snapshot.state !== 'ready'" />我已核对以上快照和覆盖范围，同意重启并替换当前应用数据</label><button type="button" class="danger" :disabled="blocked || !inspection.verified || inspection.snapshot.state !== 'ready' || !restoreConfirmed" @click="requestRestore">{{ mutation === 'restore' ? '正在安排恢复重启…' : '重启并恢复此快照' }}</button>
      </section>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AppSnapshotInfo, AppSnapshotInspection, PendingAppSnapshotOperation } from '@shared/app-snapshots'
import { formatFileSize } from '@shared/utils'
import { appSnapshotsApi } from '../api/app-snapshots'
const snapshots = ref<AppSnapshotInfo[]>([]), pending = ref<PendingAppSnapshotOperation | null>(null), loading = ref(false), pendingLoading = ref(false), listError = ref(''), pendingError = ref(''), operationError = ref(''), notice = ref('')
const name = ref(''), createConfirmed = ref(false), selectedId = ref(''), inspecting = ref(false), inspectionError = ref(''), inspection = ref<AppSnapshotInspection | null>(null), restoreConfirmed = ref(false), page = ref(1)
const mutation = ref<'' | 'create' | 'restore' | 'cancel'>('')
const blocked = computed(() => !!mutation.value || !!pending.value || pendingLoading.value || !!pendingError.value)
const canCancel = computed(() => pending.value && (pending.value.canCancel ?? pending.value.status === 'requested'))
const filePages = computed(() => Math.max(1, Math.ceil((inspection.value?.files.length || 0) / 50))), visibleFiles = computed(() => inspection.value?.files.slice((page.value - 1) * 50, page.value * 50) || [])
const PENDING_STATUS = { requested: '等待重启执行', running: '正在执行', failed: '未完成' }, formatSize = formatFileSize
let alive = true, listVersion = 0, pendingVersion = 0, inspectionVersion = 0
function formatDate(value: number) { return new Date(value).toLocaleString('zh-CN') }
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : String(cause) }
async function loadSnapshots() {
  const version = ++listVersion; loading.value = true; listError.value = ''
  try { const result = await appSnapshotsApi.listSnapshots(); if (!alive || version !== listVersion) return; if (!result.success) throw new Error(result.error); snapshots.value = result.snapshots; if (selectedId.value && !result.snapshots.some(item => item.id === selectedId.value)) selectedId.value = '' }
  catch (cause) { if (alive && version === listVersion) listError.value = errorText(cause) }
  finally { if (alive && version === listVersion) loading.value = false }
}
async function loadPending() {
  const version = ++pendingVersion; pendingLoading.value = true; pendingError.value = ''
  try { const result = await appSnapshotsApi.getPendingOperation(); if (!alive || version !== pendingVersion) return; if (!result.success) throw new Error(result.error); pending.value = result.pending }
  catch (cause) { if (alive && version === pendingVersion) pendingError.value = errorText(cause) }
  finally { if (alive && version === pendingVersion) pendingLoading.value = false }
}
async function refresh() { await Promise.all([loadSnapshots(), loadPending()]) }
async function inspect() {
  const id = selectedId.value, version = ++inspectionVersion; inspection.value = null; restoreConfirmed.value = false; inspectionError.value = ''; page.value = 1; inspecting.value = !!id; if (!id) return
  try { const result = await appSnapshotsApi.inspectSnapshot(id); if (!alive || version !== inspectionVersion) return; if (!result.success) throw new Error(result.error); inspection.value = { snapshot: result.snapshot, files: result.files, migrationIds: result.migrationIds, schemaVersions: result.schemaVersions, verified: result.verified } }
  catch (cause) { if (alive && version === inspectionVersion) inspectionError.value = errorText(cause) }
  finally { if (alive && version === inspectionVersion) inspecting.value = false }
}
async function requestSnapshot() {
  if (blocked.value || !createConfirmed.value || !name.value.trim()) return
  mutation.value = 'create'; operationError.value = ''; notice.value = ''
  try { const result = await appSnapshotsApi.requestSnapshot(name.value.trim()); if (!alive) return; if (!result.success) throw new Error(result.error); pending.value = result.pending; createConfirmed.value = false; notice.value = '创建请求已保存，应用即将重启并创建一致快照。' }
  catch (cause) { if (alive) { operationError.value = errorText(cause); await loadPending() } }
  finally { if (alive) mutation.value = '' }
}
async function requestRestore() {
  const current = inspection.value; if (blocked.value || inspecting.value || !restoreConfirmed.value || !current?.verified || current.snapshot.state !== 'ready' || current.snapshot.id !== selectedId.value) return
  mutation.value = 'restore'; operationError.value = ''; notice.value = ''
  try { const result = await appSnapshotsApi.requestRestore(current.snapshot.id); if (!alive) return; if (!result.success) throw new Error(result.error); pending.value = result.pending; restoreConfirmed.value = false; notice.value = '恢复请求已保存，应用即将重启并在恢复前保存回滚快照。' }
  catch (cause) { if (alive) { operationError.value = errorText(cause); restoreConfirmed.value = false; inspection.value = null; inspectionError.value = '恢复请求未完成，请重新检查快照后再提交。'; await loadPending() } }
  finally { if (alive) mutation.value = '' }
}
async function cancelPending() {
  if (!canCancel.value || mutation.value) return
  mutation.value = 'cancel'; operationError.value = ''; notice.value = ''
  try { const result = await appSnapshotsApi.cancelPendingOperation(); if (!alive) return; if (!result.success) throw new Error(result.error); pending.value = null; notice.value = '尚未执行的请求已取消。'; await refresh() }
  catch (cause) { if (alive) { operationError.value = errorText(cause); await loadPending() } }
  finally { if (alive) mutation.value = '' }
}
watch(selectedId, () => { void inspect() }, { flush: 'sync' })
watch(name, () => { createConfirmed.value = false })
onMounted(() => { void refresh() })
onBeforeUnmount(() => { alive = false; listVersion++; pendingVersion++; inspectionVersion++ })
</script>

<style scoped>
.app-snapshots-panel { background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); padding: 22px; color: var(--pl-text); min-width: 0; overflow-wrap: anywhere; }.app-snapshots-panel * { box-sizing: border-box; }h2 { margin: 0; font-size: 18px; }h3 { margin: 0; font-size: 14px; }p { font-size: 12px; line-height: 1.7; margin: 7px 0 12px; }.snapshot-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; }.snapshot-heading p { margin-bottom: 0; color: var(--pl-text-secondary); }.snapshot-heading > div { min-width: 0; }.snapshot-muted { color: var(--pl-text-secondary); font-size: 12px; }.snapshot-notice,.snapshot-pending { padding: 12px 14px; border-radius: 9px; border: 1px solid var(--pl-border); background: var(--pl-warning-soft); font-size: 12px; line-height: 1.7; }.snapshot-notice.success { background: var(--pl-success-soft); }.snapshot-pending { margin: 14px 0; background: var(--pl-surface-subtle); }.snapshot-pending .snapshot-heading { margin: 0; }.snapshot-error { color: var(--pl-danger); }.snapshot-create,.snapshot-restore { margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--pl-border); }label { display: grid; gap: 6px; color: var(--pl-text-secondary); font-size: 12px; margin: 13px 0; }input:not([type=checkbox]),select { min-width: 0; width: 100%; padding: 9px 10px; background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: 8px; color: var(--pl-text); font: inherit; }button { padding: 7px 11px; background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: 8px; color: var(--pl-text); font: inherit; font-size: 12px; cursor: pointer; flex-shrink: 0; }button:hover:enabled { background: var(--pl-hover); }button.primary { background: var(--pl-primary); border-color: var(--pl-primary); color: #fff; }button.danger { background: var(--pl-danger-soft); border-color: var(--pl-danger); color: var(--pl-danger); }button:disabled,input:disabled { opacity: .5; cursor: default; }.snapshot-checkbox { display: flex; align-items: flex-start; gap: 7px; line-height: 1.6; }input[type=checkbox] { flex-shrink: 0; accent-color: var(--pl-primary); }.snapshot-empty { padding: 24px; text-align: center; color: var(--pl-text-muted); font-size: 12px; }.snapshot-inspection { border: 1px solid var(--pl-border); border-radius: 10px; background: var(--pl-surface-subtle); padding: 16px; margin-top: 16px; }.snapshot-badge { padding: 4px 8px; border-radius: 6px; font-size: 11px; flex-shrink: 0; }.snapshot-badge.success { background: var(--pl-success-soft); color: var(--pl-success); }.snapshot-badge.warning { background: var(--pl-warning-soft); color: var(--pl-warning); }.snapshot-files { font-size: 12px; color: var(--pl-text-secondary); }summary { cursor: pointer; }.snapshot-table-scroll { max-width: 100%; overflow-x: auto; }table { width: 100%; table-layout: fixed; border-collapse: collapse; margin-top: 12px; font-size: 12px; }th,td { text-align: left; vertical-align: top; padding: 9px; border-bottom: 1px solid var(--pl-border); overflow-wrap: anywhere; }td details { margin-top: 5px; word-break: break-all; font-size: 11px; }.snapshot-pagination { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }.snapshot-pagination span { margin-right: auto; }@media(max-width:700px) { .app-snapshots-panel { padding: 16px; }.snapshot-heading { flex-wrap: wrap; align-items: flex-start; } }
</style>
