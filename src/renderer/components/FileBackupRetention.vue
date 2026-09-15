<template>
  <section class="backup-retention">
    <div class="backup-section-heading"><div><h3>预演版本清理</h3><p class="backup-muted">保留最近 {{ plan.keepLast }} 个版本{{ plan.keepDays ? `，以及 ${plan.keepDays} 天内的版本` : '，未启用天数保护' }}。满足任一条件的版本都会保留。</p></div></div>
    <div class="backup-actions"><button class="backup-button" type="button" :disabled="busy || loading || pruning" @click="generate(false)">按保留策略预演清理</button><button class="backup-button" type="button" :disabled="busy || loading || pruning || !selectedSnapshots.length" @click="generate(true)">预演清理所选 {{ selectedSnapshots.length }} 个版本</button></div>
    <p class="backup-muted">只清理本计划的版本对象。被保留版本引用的内容不会计入可删除对象。</p><p v-if="error" class="backup-error" role="alert">{{ error }}</p><div v-if="loading" class="backup-empty" role="status">正在核对版本引用和可释放空间…</div>
    <section v-if="preview" class="backup-subpanel retention-preview">
      <div class="backup-metrics"><div><strong>{{ preview.snapshotIds.length }}</strong><span>待清理版本</span></div><div><strong>{{ preview.retainedSnapshotCount }}</strong><span>清理后保留</span></div><div><strong>{{ preview.objectCount }}</strong><span>待删除对象</span></div><div><strong>{{ formatSize(preview.reclaimBytes) }}</strong><span>预计释放</span></div></div>
      <details class="backup-version-ids"><summary>核对 {{ preview.snapshotIds.length }} 个待清理版本</summary><ul><li v-for="id in preview.snapshotIds" :key="id">{{ describeSnapshot(id) }}</li></ul></details>
      <ul v-if="preview.warnings.length" class="backup-warning-list"><li v-for="warning in preview.warnings" :key="warning">{{ warning }}</li></ul>
      <div v-if="pageLoading" class="backup-empty" role="status">正在读取本页对象…</div><div v-else-if="!objects.length" class="backup-empty">此页没有待删除对象，版本引用变更仍以以上清单为准。</div><div v-else class="backup-table-scroll"><table class="backup-table"><thead><tr><th>备份对象</th><th>大小</th><th>引用 / 校验</th></tr></thead><tbody><tr v-for="object in objects" :key="object.objectId"><td><strong class="backup-path">{{ object.name }}</strong><span class="backup-muted backup-row-line">{{ OBJECT_STATUS[object.state] }}</span></td><td>{{ formatSize(object.size) }}</td><td><span>{{ object.referenceCount }} 个引用</span><details class="backup-hash"><summary>SHA-256</summary>{{ object.sha256 }}</details></td></tr></tbody></table></div>
      <BackupPager :page="page" :total="total" :busy="pageLoading || pruning" label="清理对象" @change="loadPage" />
      <label class="backup-checkbox"><input v-model="confirmed" type="checkbox" aria-label="确认版本清理范围" :disabled="!preview.executable || busy || pageLoading || pruning || stale" />我已核对版本、对象及警告，确认永久清理以上范围</label><button class="backup-button danger" type="button" :disabled="!confirmed || !preview.executable || busy || pageLoading || pruning || stale" @click="prune">{{ pruning ? '正在提交清理…' : '确认清理此预演' }}</button><p v-if="stale" class="backup-error">清理预演已失效，请重新核对保留版本和对象引用。</p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { formatFileSize } from '@shared/utils'
import type { FileBackupJob, FileBackupPlan, FileBackupResult, FileBackupRetentionObject, FileBackupRetentionPreview, FileBackupSnapshot } from '@shared/file-backup'
import { fileBackupsApi } from '../api/file-backups'
import BackupPager from './BackupPager.vue'
const props = defineProps<{ plan: FileBackupPlan; selectedSnapshots: FileBackupSnapshot[]; busy: boolean }>()
const emit = defineEmits<{ job: [job: FileBackupJob] }>()
const preview = ref<FileBackupRetentionPreview | null>(null), objects = ref<FileBackupRetentionObject[]>([]), page = ref(1), total = ref(0)
const loading = ref(false), pageLoading = ref(false), pruning = ref(false), error = ref(''), confirmed = ref(false), stale = ref(false)
const formatSize = formatFileSize
const OBJECT_STATUS: Record<FileBackupRetentionObject['state'], string> = { verified: '已校验', pending: '等待上传', dispatched: '已提交', uncertain: '结果待核对', corrupt: '损坏', deleting: '清理中', deleted: '已删除' }
let alive = true, generation = 0, pageVersion = 0
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : String(cause) }
function success<T extends object>(result: FileBackupResult<T>): asserts result is { success: true } & T { if (!result.success) throw new Error(result.error) }
function describeSnapshot(id: string) { const snapshot = props.selectedSnapshots.find(item => item.id === id); return snapshot ? `${new Date(snapshot.createdAt).toLocaleString('zh-CN')} · ${id}` : id }
function invalidate() { generation++; pageVersion++; preview.value = null; objects.value = []; confirmed.value = false; stale.value = false; loading.value = false; pageLoading.value = false; error.value = '' }
async function generate(explicit: boolean) {
  if (props.busy || loading.value || pruning.value || (explicit && !props.selectedSnapshots.length)) return
  const version = ++generation; pageVersion++; loading.value = true; error.value = ''; preview.value = null; confirmed.value = false
  try { const result = await fileBackupsApi.retentionPreview({ planId: props.plan.id, ...(explicit ? { snapshotIds: props.selectedSnapshots.map(item => item.id) } : {}) }); success(result); if (!alive || version !== generation) return; preview.value = result.preview; stale.value = false; await loadPage(1) }
  catch (cause) { if (alive && version === generation) error.value = errorText(cause) }
  finally { if (alive && version === generation) loading.value = false }
}
async function loadPage(targetPage: number) {
  const current = preview.value; if (!current) return
  const version = ++pageVersion, currentGeneration = generation; pageLoading.value = true; confirmed.value = false
  try { const result = await fileBackupsApi.getRetentionPreview({ previewId: current.id, page: targetPage, pageSize: 50 }); if (!alive || version !== pageVersion || currentGeneration !== generation) return; success(result); preview.value = result.preview; total.value = result.total; const last = Math.max(1, Math.ceil(result.total / 50)); if (targetPage > last) { await loadPage(last); return }; objects.value = result.objects; page.value = result.page; error.value = '' }
  catch (cause) { if (alive && version === pageVersion) { error.value = errorText(cause); objects.value = []; stale.value = true } }
  finally { if (alive && version === pageVersion) pageLoading.value = false }
}
async function prune() {
  const current = preview.value; if (!current?.executable || !confirmed.value || props.busy || pruning.value || pageLoading.value || stale.value) return
  const version = generation; pruning.value = true; error.value = ''
  try { const result = await fileBackupsApi.prune(current.id); success(result); if (!alive || version !== generation) return; confirmed.value = false; emit('job', result.job) }
  catch (cause) { if (alive && version === generation) { error.value = errorText(cause); stale.value = true; confirmed.value = false } }
  finally { if (alive) pruning.value = false }
}
watch(() => props.plan.version, invalidate)
watch(() => props.selectedSnapshots.map(item => item.id).join(','), invalidate)
onBeforeUnmount(() => { alive = false; generation++; pageVersion++ })
</script>
