<template>
  <section class="backup-jobs">
    <div class="backup-section-heading"><div><h3>作业报告</h3><p class="backup-muted">暂停、恢复和取消请进入任务日志。结果待核对表示远端操作结果尚未确认。</p></div><button class="backup-text-button" type="button" :disabled="loading" @click="$emit('refresh')">刷新作业</button></div>
    <p v-if="error" class="backup-error" role="alert">{{ error }}</p><div v-if="loading && !jobs.length" class="backup-empty" role="status">正在读取作业…</div><div v-else-if="!jobs.length && !error" class="backup-empty">还没有备份、恢复或清理作业。</div>
    <label v-if="jobs.length" class="backup-field">选择作业<select :value="selectedId" aria-label="选择备份作业" @change="selectJob(($event.target as HTMLSelectElement).value)"><option v-for="job in jobs" :key="job.id" :value="job.id">{{ formatDate(job.createdAt) }} · {{ KIND[job.kind] }} · {{ statusLabel(job) }}</option></select></label>
    <div v-if="current" class="backup-subpanel">
      <div class="backup-section-heading"><div><h3>{{ KIND[current.kind] }} · {{ statusLabel(current) }}</h3><p class="backup-muted">已处理 {{ current.completedItems }} / {{ current.totalItems }} 项 · {{ formatDate(current.updatedAt) }}</p></div><button v-if="current.taskId" class="backup-button" type="button" @click="openTask(current.taskId)">查看作业任务</button></div>
      <p v-if="current.error" class="backup-error" role="alert">{{ current.error }}</p><p v-if="reportError" class="backup-error" role="alert">{{ reportError }}</p><button class="backup-text-button" type="button" :disabled="reportLoading" @click="loadReport(page)">刷新本页报告</button>
      <div v-if="reportLoading" class="backup-empty" role="status">正在读取逐项结果…</div><div v-else-if="!items.length && !reportError" class="backup-empty">此页尚无已处理结果。进行中的作业会持续更新。</div><div v-else-if="items.length" class="backup-table-scroll"><table class="backup-table"><thead><tr><th>文件或对象</th><th>结果</th></tr></thead><tbody><tr v-for="item in items" :key="item.itemId"><td class="backup-path">{{ item.path }}</td><td><span class="backup-badge" :class="item.status === 'success' ? 'success' : 'warning'">{{ ITEM_STATUS[item.status] }}</span><span v-if="item.error" class="backup-row-line backup-error">{{ item.error }}</span></td></tr></tbody></table></div>
      <BackupPager :page="page" :total="total" :busy="reportLoading" label="作业报告" @change="loadReport" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { FileBackupJob, FileBackupJobItem } from '@shared/file-backup'
import { fileBackupsApi } from '../api/file-backups'
import BackupPager from './BackupPager.vue'
const props = defineProps<{ jobs: FileBackupJob[]; loading: boolean; error: string; requestedJobId?: string; refreshKey: number }>()
const emit = defineEmits<{ refresh: []; updated: [job: FileBackupJob] }>()
const router = useRouter(), selectedId = ref(''), current = ref<FileBackupJob | null>(null), items = ref<FileBackupJobItem[]>([])
const page = ref(1), total = ref(0), reportLoading = ref(false), reportError = ref('')
const KIND = { backup: '备份', restore: '恢复', prune: '清理' }, STATUS = { queued: '等待执行', running: '执行中', completed: '已完成', failed: '失败', uncertain: '结果待核对' }, ITEM_STATUS = { success: '成功', failed: '失败', uncertain: '结果待核对' }
let alive = true, requestVersion = 0
function formatDate(value: number) { return new Date(value).toLocaleString('zh-CN') }
function statusLabel(job: FileBackupJob) { return job.taskStatus === 'paused' ? '已暂停' : job.taskStatus === 'cancelled' ? '已取消' : STATUS[job.status] }
function selectJob(id: string) { requestVersion++; selectedId.value = id; current.value = props.jobs.find(job => job.id === id) || null; items.value = []; total.value = 0; page.value = 1; void loadReport(1) }
async function loadReport(targetPage = page.value) {
  if (!selectedId.value) return
  const version = ++requestVersion, id = selectedId.value; reportLoading.value = true; reportError.value = ''
  const observedJob = props.jobs.find(job => job.id === id)
  try { const result = await fileBackupsApi.getJob({ jobId: id, page: targetPage, pageSize: 50 }); if (!alive || version !== requestVersion) return; if (!result.success) throw new Error(result.error); total.value = result.total; const last = Math.max(1, Math.ceil(result.total / 50)); if (targetPage > last) { await loadReport(last); return }; items.value = result.items; page.value = result.page; if (props.jobs.find(job => job.id === id) === observedJob) { current.value = result.job; emit('updated', result.job) } }
  catch (cause) { if (alive && version === requestVersion) { items.value = []; reportError.value = cause instanceof Error ? cause.message : String(cause) } }
  finally { if (alive && version === requestVersion) reportLoading.value = false }
}
function openTask(id: string) { void router.push({ path: '/tasks', query: { taskId: id, from: 'file-backups' } }) }
watch(() => props.jobs, jobs => { if (!selectedId.value || !jobs.some(job => job.id === selectedId.value)) { if (jobs.length) selectJob(jobs[0].id); else { requestVersion++; selectedId.value = ''; current.value = null; items.value = []; reportLoading.value = false } } }, { immediate: true })
watch(() => props.jobs.find(job => job.id === selectedId.value), job => { if (job) current.value = job })
watch(() => props.requestedJobId, id => { if (id && id !== selectedId.value) selectJob(id) }, { immediate: true })
watch(() => props.refreshKey, () => { if (!reportLoading.value) void loadReport() })
onBeforeUnmount(() => { alive = false; requestVersion++ })
</script>
