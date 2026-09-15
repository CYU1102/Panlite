<template>
  <main class="file-backups-page">
    <header class="backup-page-heading"><div><h1>文件版本备份</h1><p>将本地目录备份到 WebDAV，按版本找回文件，并在清理前核对引用。</p></div><button class="backup-button primary" type="button" @click="selectPlan(null)">新建备份计划</button></header>
    <div class="backup-notice">文件版本保存于所选 WebDAV 目录，应用数据库保存版本清单。请同时保留应用快照；仅保留远端对象不能在此界面重建版本。</div>
    <p v-if="listError" class="backup-error" role="alert">{{ listError }} <button class="backup-text-button" type="button" @click="loadPlans">重试计划列表</button></p>
    <div class="backup-layout">
      <aside class="backup-plan-list" aria-label="备份计划列表"><div class="backup-section-heading"><h2>计划 <span>{{ plans.length }}</span></h2><button class="backup-text-button" type="button" :disabled="listLoading" @click="loadPlans">刷新</button></div><div v-if="listLoading && !plans.length" class="backup-empty" role="status">正在读取计划…</div><div v-else-if="!plans.length" class="backup-empty">创建第一个备份计划，先预演，再执行。</div><button v-for="plan in plans" :key="plan.id" type="button" class="backup-plan-item" :class="{ active: selectedId === plan.id }" @click="selectPlan(plan)"><strong>{{ plan.name }}</strong><span>{{ plan.sourcePath }}</span><small>配置 v{{ plan.version }} · {{ formatDate(plan.updatedAt) }}</small></button></aside>
      <section class="backup-workspace">
        <div v-if="notice" class="backup-notice success" role="status">{{ notice }} <button v-if="reusedSnapshotId" class="backup-text-button" type="button" @click="showSnapshot(reusedSnapshotId)">查看复用版本</button></div>
        <form class="backup-plan-form backup-panel" @submit.prevent="savePlan">
          <div class="backup-section-heading"><h2>{{ selectedId ? '备份计划配置' : '新建备份计划' }}</h2><span v-if="savedPlan" class="backup-muted">配置 v{{ savedPlan.version }}{{ dirty ? ' · 有未保存更改' : '' }}</span></div>
          <p v-if="jobsError && selectedId" class="backup-error" role="alert">暂时无法确认运行状态：{{ jobsError }} <button class="backup-text-button" type="button" @click="loadJobs()">重试</button></p><p v-if="running" class="backup-notice">本计划有等待、运行或暂停中的任务。请在任务日志完成或取消后修改配置。</p>
          <label class="backup-field">计划名称<input v-model="draft.name" aria-label="备份计划名称" maxlength="120" :disabled="configurationLocked" placeholder="例如：工作文档每周备份" /></label>
          <div class="backup-location-grid"><div class="backup-location-card"><h3>本地源目录</h3><p class="backup-path">{{ draft.sourcePath || '尚未选择目录' }}</p><button class="backup-button" type="button" :disabled="configurationLocked || pickingSource" @click="pickSource">{{ pickingSource ? '正在选择…' : '选择本地源目录' }}</button></div><div class="backup-location-card"><h3>WebDAV 备份目录</h3><p class="backup-path">{{ draft.target ? `${accountLabel(draft.target.accountId)} · ${draft.target.rootPath}` : '尚未选择目录' }}</p><button class="backup-button" type="button" :disabled="configurationLocked || accountsLoading" @click="pickerOpen = !pickerOpen">选择 WebDAV 目录</button></div></div>
          <p v-if="accountsError" class="backup-error" role="alert">{{ accountsError }} <button class="backup-text-button" type="button" @click="loadAccounts">重试账号</button></p><div v-if="pickerOpen && !configurationLocked" class="backup-picker"><p v-if="!webdavAccounts.length" class="backup-notice">请先在账号管理中添加 WebDAV 账号。</p><CatalogScopePicker :accounts="webdavAccounts" :saving="saving" mode="transfer" @cancel="pickerOpen = false" @select="selectTarget" /></div>
          <label class="backup-field">排除规则，每行一条<textarea v-model="draft.excludeText" aria-label="备份排除规则" rows="3" :disabled="configurationLocked" placeholder="*.tmp&#10;**/缓存/**" /><span class="backup-muted">支持 *、**、?；排除目录会同时排除其子项。</span></label>
          <div class="backup-retention-fields"><label class="backup-field">至少保留最近版本数<input v-model.number="draft.keepLast" aria-label="保留版本数" type="number" min="1" max="10000" step="1" :disabled="configurationLocked" /></label><label class="backup-field">同时保留最近天数<input v-model.number="draft.keepDays" aria-label="保留天数" type="number" min="0" max="36500" step="1" :disabled="configurationLocked" /><span class="backup-muted">0 表示不按天数保护；满足任一条件即保留。</span></label></div>
          <p v-if="formError" class="backup-error" role="alert">{{ formError }}</p><div class="backup-actions"><button class="backup-button primary" type="submit" :disabled="configurationLocked || !dirty">{{ saving ? '正在保存…' : '保存备份计划' }}</button><button v-if="savedPlan && dirty" class="backup-text-button" type="button" :disabled="configurationLocked" @click="discardChanges">放弃修改，读取最新配置</button><button v-if="savedPlan" class="backup-text-button danger" type="button" :disabled="configurationLocked" @click="deleteConfirm = !deleteConfirm">删除计划</button></div>
          <div v-if="deleteConfirm && savedPlan" class="backup-notice"><p>删除“{{ savedPlan.name }}”的计划配置。必须先在版本清理中清理全部版本。</p><button class="backup-button danger" type="button" :disabled="configurationLocked" @click="removePlan">确认删除计划</button><button class="backup-text-button" type="button" @click="deleteConfirm = false">取消</button></div>
        </form>
        <template v-if="savedPlan">
          <nav class="backup-tabs" aria-label="备份工作区"><button v-for="item in tabs" :key="item.key" type="button" :aria-pressed="activeTab === item.key" :class="{ active: activeTab === item.key }" @click="activeTab = item.key">{{ item.label }}</button></nav>
          <section v-show="activeTab === 'backup'" class="backup-panel backup-preview-panel">
            <div class="backup-section-heading"><div><h2>备份预演</h2><p class="backup-muted">读取本地内容并计算 SHA-256。相同内容复用已校验对象，空目录也会保留。</p></div><button class="backup-button" type="button" :disabled="actionLocked || dirty || previewLoading" @click="generatePreview">{{ previewLoading ? '正在核对源文件…' : '生成备份预演' }}</button></div>
            <p v-if="dirty" class="backup-notice">请先保存配置，再生成备份预演。</p><p v-if="backupError" class="backup-error" role="alert">{{ backupError }}</p><div v-if="!preview && !previewLoading" class="backup-empty">预演会列出新增上传、复用内容、空目录、排除项和无法读取的范围。</div>
            <template v-if="preview"><div class="backup-section-heading"><span class="backup-muted">配置 v{{ preview.planVersion }} · {{ formatDate(preview.createdAt) }}</span><span class="backup-badge" :class="preview.complete && preview.executable ? 'success' : 'warning'">{{ !preview.complete ? '范围不完整' : preview.executable ? '可执行' : '不可执行' }}</span></div><div class="backup-metrics"><div><strong>{{ preview.fileCount }}</strong><span>文件 · {{ preview.directoryCount }} 目录</span></div><div><strong>{{ preview.uploadFiles }}</strong><span>上传 · {{ formatSize(preview.uploadBytes) }}</span></div><div><strong>{{ preview.reusedFiles }}</strong><span>复用文件</span></div><div><strong>{{ preview.excludedCount }}</strong><span>排除项</span></div></div>
              <p v-if="preview.unchanged" class="backup-notice success">源内容无变化，执行后复用已有已校验版本，0 上传。</p><ul v-if="preview.failures.length" class="backup-warning-list"><li v-for="(failure, index) in preview.failures.slice(0, 100)" :key="index">{{ failure.path }}：{{ failure.error }}</li></ul><p v-if="preview.failures.length > 100" class="backup-muted">以上显示前 100 / {{ preview.failures.length }} 项错误，请先处理读取失败的范围后重试。</p>
              <div v-if="previewPageLoading" class="backup-empty" role="status">正在读取本页备份清单…</div><BackupFileTable v-else-if="previewItems.length" :items="previewItems" preview /><BackupPager :page="previewPage" :total="previewTotal" :busy="previewPageLoading || executing" label="备份清单" @change="loadPreviewPage" />
              <label class="backup-checkbox"><input v-model="backupConfirmed" type="checkbox" aria-label="确认备份预演" :disabled="actionLocked || dirty || !preview.executable || previewStale || previewPageLoading" />我已核对以上配置和文件范围，提交此预演版本</label><button class="backup-button primary" type="button" :disabled="actionLocked || dirty || !preview.executable || previewStale || previewPageLoading || !backupConfirmed" @click="executeBackup">{{ executing ? '正在提交备份…' : '确认执行备份' }}</button><p v-if="previewStale" class="backup-error">源内容或版本状态已变化，请重新生成备份预演。</p>
            </template>
          </section>
          <FileBackupVersions v-show="activeTab === 'versions'" :key="`versions:${savedPlan.id}`" class="backup-panel" :plan-id="savedPlan.id" :busy="actionLocked" :refresh-key="refreshKey" :requested-snapshot-id="requestedSnapshotId" :selected-snapshots="selectedSnapshots" @selection="selectedSnapshots = $event" @job="acceptJob" />
          <FileBackupRetention v-show="activeTab === 'retention'" :key="`retention:${savedPlan.id}`" class="backup-panel" :plan="savedPlan" :busy="actionLocked || dirty" :selected-snapshots="selectedSnapshots" @job="acceptJob" />
          <FileBackupJobs v-show="activeTab === 'jobs'" :key="`jobs:${savedPlan.id}`" class="backup-panel" :jobs="jobs" :loading="jobsLoading" :error="jobsError" :requested-job-id="requestedJobId" :refresh-key="jobRefreshKey" @refresh="refreshJobs" @updated="updateJob" />
        </template>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { DriveAccount } from '@shared/types'
import type { FileBackupJob, FileBackupPlan, FileBackupPlanInput, FileBackupPreview, FileBackupPreviewItem, FileBackupSnapshot, FileBackupTarget } from '@shared/file-backup'
import { formatFileSize } from '@shared/utils'
import { fileBackupsApi } from '../api/file-backups'
import { electronApi } from '../api/ipc'
import CatalogScopePicker from '../components/CatalogScopePicker.vue'
import BackupPager from '../components/BackupPager.vue'
import BackupFileTable from '../components/BackupFileTable.vue'
import FileBackupVersions from '../components/FileBackupVersions.vue'
import FileBackupRetention from '../components/FileBackupRetention.vue'
import FileBackupJobs from '../components/FileBackupJobs.vue'

const plans = ref<FileBackupPlan[]>([]), selectedId = ref(''), savedPlan = ref<FileBackupPlan | null>(null), listLoading = ref(false), listError = ref('')
const accounts = ref<Omit<DriveAccount, 'credential'>[]>([]), accountsLoading = ref(false), accountsError = ref('')
const draft = reactive({ name: '', sourcePath: '', target: null as FileBackupTarget | null, excludeText: '', keepLast: 5, keepDays: 30 })
const saving = ref(false), pickingSource = ref(false), pickerOpen = ref(false), formError = ref(''), deleteConfirm = ref(false), notice = ref(''), reusedSnapshotId = ref('')
const jobs = ref<FileBackupJob[]>([]), jobsLoading = ref(false), jobsError = ref(''), refreshKey = ref(0), jobRefreshKey = ref(0), selectedSnapshots = ref<FileBackupSnapshot[]>([]), requestedSnapshotId = ref(''), requestedJobId = ref('')
const preview = ref<FileBackupPreview | null>(null), previewItems = ref<FileBackupPreviewItem[]>([]), previewPage = ref(1), previewTotal = ref(0), previewLoading = ref(false), previewPageLoading = ref(false), backupError = ref(''), backupConfirmed = ref(false), previewStale = ref(false), executing = ref(false)
const tabs = [{ key: 'backup', label: '备份预演' }, { key: 'versions', label: '版本与恢复' }, { key: 'retention', label: '版本清理' }, { key: 'jobs', label: '作业报告' }] as const
const activeTab = ref<(typeof tabs)[number]['key']>('backup'), operations = reactive(new Set<string>())
const webdavAccounts = computed(() => accounts.value.filter(account => account.platform === 'webdav'))
const running = computed(() => jobs.value.some(job => ['pending', 'running', 'paused'].includes(job.taskStatus || '') || (!job.taskStatus && ['queued', 'running'].includes(job.status))))
const actionLocked = computed(() => !!selectedId.value && (running.value || jobsLoading.value || !!jobsError.value || operations.has(selectedId.value)))
const configurationLocked = computed(() => actionLocked.value || saving.value || executing.value || previewLoading.value)
const fingerprint = () => JSON.stringify({ name: draft.name, sourcePath: draft.sourcePath, target: draft.target, exclude: draft.excludeText, keepLast: draft.keepLast, keepDays: draft.keepDays })
const savedFingerprint = ref(''), dirty = computed(() => fingerprint() !== savedFingerprint.value)
const formatSize = formatFileSize
let alive = true, selectionVersion = 0, listVersion = 0, accountVersion = 0, jobsVersion = 0, previewVersion = 0, previewPageVersion = 0, sourceVersion = 0
let poll: ReturnType<typeof setInterval> | undefined
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : String(cause) }
function formatDate(value: number) { return new Date(value).toLocaleString('zh-CN') }
function accountLabel(id: string) { return accounts.value.find(account => account.id === id)?.nickname || '账号不可用' }
function resetPreview() { previewVersion++; previewPageVersion++; preview.value = null; previewItems.value = []; previewTotal.value = 0; previewPage.value = 1; previewLoading.value = false; previewPageLoading.value = false; backupConfirmed.value = false; previewStale.value = false; backupError.value = '' }
function applyDraft(plan: FileBackupPlan | null) { Object.assign(draft, { name: plan?.name || '', sourcePath: plan?.sourcePath || '', target: plan ? { ...plan.target } : null, excludeText: plan?.exclude.join('\n') || '', keepLast: plan?.keepLast ?? 5, keepDays: plan?.keepDays ?? 30 }); savedFingerprint.value = plan ? fingerprint() : '' }
function selectPlan(plan: FileBackupPlan | null) {
  selectionVersion++; jobsVersion++; sourceVersion++; selectedId.value = plan?.id || ''; savedPlan.value = plan; applyDraft(plan); resetPreview(); jobs.value = []; jobsError.value = ''; jobsLoading.value = false; formError.value = ''; notice.value = ''; reusedSnapshotId.value = ''; selectedSnapshots.value = []; requestedSnapshotId.value = ''; requestedJobId.value = ''; pickerOpen.value = false; deleteConfirm.value = false; saving.value = false; pickingSource.value = false; executing.value = false; activeTab.value = 'backup'; if (plan) void loadJobs()
}
async function loadPlans() {
  const version = ++listVersion; listLoading.value = true; listError.value = ''
  try { const result = await fileBackupsApi.listPlans(); if (!alive || version !== listVersion) return; if (!result.success) throw new Error(result.error); plans.value = result.plans }
  catch (cause) { if (alive && version === listVersion) listError.value = errorText(cause) }
  finally { if (alive && version === listVersion) listLoading.value = false }
}
async function loadAccounts() {
  const version = ++accountVersion; accountsLoading.value = true; accountsError.value = ''
  try { const result = await electronApi.listAccounts(); if (!alive || version !== accountVersion) return; if (!result.success) throw new Error(result.error || '读取账号失败'); accounts.value = result.accounts }
  catch (cause) { if (alive && version === accountVersion) accountsError.value = errorText(cause) }
  finally { if (alive && version === accountVersion) accountsLoading.value = false }
}
async function pickSource() {
  if (configurationLocked.value || pickingSource.value) return
  const version = ++sourceVersion, selection = selectionVersion; pickingSource.value = true; formError.value = ''
  try { const result = await electronApi.showOpenDialog({ title: '选择要备份的本地目录', properties: ['openDirectory'] }); if (!alive || version !== sourceVersion || selection !== selectionVersion) return; if (!result.canceled && result.filePaths?.[0]) draft.sourcePath = result.filePaths[0] }
  catch (cause) { if (alive && version === sourceVersion) formError.value = errorText(cause) }
  finally { if (alive && version === sourceVersion) pickingSource.value = false }
}
function selectTarget(selection: FileBackupTarget) { if (configurationLocked.value || !webdavAccounts.value.some(account => account.id === selection.accountId)) return; draft.target = { accountId: selection.accountId, rootId: selection.rootId, rootPath: selection.rootPath }; pickerOpen.value = false }
async function savePlan() {
  if (configurationLocked.value || !dirty.value) return
  formError.value = ''; const exclude = draft.excludeText.split(/\r?\n/).map(rule => rule.trim()).filter(Boolean)
  if (!draft.name.trim() || !draft.sourcePath || !draft.target) { formError.value = '请填写计划名称，并选择本地源目录和 WebDAV 目标目录。'; return }
  if (!Number.isInteger(draft.keepLast) || draft.keepLast < 1 || draft.keepLast > 10000 || !Number.isInteger(draft.keepDays) || draft.keepDays < 0 || draft.keepDays > 36500) { formError.value = '保留版本数应为 1–10000 的整数，保留天数应为 0–36500 的整数。'; return }
  if (exclude.length > 100 || exclude.some(rule => rule.length > 512)) { formError.value = '排除规则最多 100 条，每条不超过 512 个字符。'; return }
  const selection = selectionVersion, id = selectedId.value, key = id || '__new__'; saving.value = true; operations.add(key)
  const input: FileBackupPlanInput = { ...(savedPlan.value ? { id, expectedVersion: savedPlan.value.version } : {}), name: draft.name.trim(), sourcePath: draft.sourcePath, target: { ...draft.target }, exclude, keepLast: draft.keepLast, keepDays: draft.keepDays }
  try { const result = await fileBackupsApi.savePlan(input); if (!result.success) throw new Error(result.error); if (!alive) return; listVersion++; listLoading.value = false; const index = plans.value.findIndex(plan => plan.id === result.plan.id); if (index >= 0) plans.value.splice(index, 1, result.plan); else plans.value.unshift(result.plan); if (selection !== selectionVersion) return; selectPlan(result.plan); notice.value = '备份计划已保存，可以生成预演。' }
  catch (cause) { if (alive && selection === selectionVersion) formError.value = errorText(cause) }
  finally { operations.delete(key); if (alive && selection === selectionVersion) saving.value = false }
}
async function discardChanges() { const id = selectedId.value, selection = selectionVersion; await loadPlans(); if (!alive || selection !== selectionVersion || listError.value) return; const plan = plans.value.find(item => item.id === id); if (plan) selectPlan(plan); else formError.value = '此计划已不存在，请刷新列表或新建计划。' }
async function removePlan() {
  if (!savedPlan.value || configurationLocked.value || !deleteConfirm.value) return
  const id = savedPlan.value.id, selection = selectionVersion; operations.add(id); formError.value = ''
  try { const result = await fileBackupsApi.removePlan(id); if (!result.success) throw new Error(result.error); if (!alive) return; listVersion++; listLoading.value = false; plans.value = plans.value.filter(plan => plan.id !== id); if (selection === selectionVersion) selectPlan(plans.value[0] || null) }
  catch (cause) { if (alive && selection === selectionVersion) formError.value = errorText(cause) }
  finally { operations.delete(id) }
}
async function loadJobs(quiet = false) {
  const id = selectedId.value; if (!id) return
  const version = ++jobsVersion, selection = selectionVersion; if (!quiet) jobsLoading.value = true
  const observedJobs = new Map(jobs.value.map(job => [job.id, job]))
  try {
    const result = await fileBackupsApi.listJobs(id); if (!alive || selection !== selectionVersion || version !== jobsVersion) return; if (!result.success) throw new Error(result.error)
    // A report or submission may have supplied newer state while this list was in flight.
    const latestJobs = new Map(jobs.value.map(job => [job.id, job]))
    const merged = result.jobs.map(job => { const latest = latestJobs.get(job.id); return latest && latest !== observedJobs.get(job.id) ? latest : job })
    for (const job of jobs.value) if (!observedJobs.has(job.id) && !merged.some(item => item.id === job.id)) merged.unshift(job)
    const changed = merged.some(job => { const previous = latestJobs.get(job.id); return previous && (previous.status !== job.status || previous.taskStatus !== job.taskStatus) })
    jobs.value = merged; jobsError.value = ''; if (changed) refreshKey.value++
  }
  catch (cause) { if (alive && selection === selectionVersion && version === jobsVersion) jobsError.value = errorText(cause) }
  finally { if (alive && version === jobsVersion) jobsLoading.value = false }
}
async function refreshJobs() { await loadJobs(); if (alive) jobRefreshKey.value++ }
function updateJob(job: FileBackupJob) { if (job.planId !== selectedId.value) return; const index = jobs.value.findIndex(item => item.id === job.id); if (index >= 0) { const previous = jobs.value[index]; const changed = previous.status !== job.status || previous.taskStatus !== job.taskStatus; jobs.value.splice(index, 1, job); if (changed) refreshKey.value++ } }
function acceptJob(job: FileBackupJob) { if (job.planId !== selectedId.value) return; const index = jobs.value.findIndex(item => item.id === job.id); if (index >= 0) jobs.value.splice(index, 1, job); else jobs.value.unshift(job); requestedJobId.value = job.id; activeTab.value = 'jobs'; refreshKey.value++; resetPreview(); notice.value = '作业已提交，可在任务日志中暂停、恢复或取消。'; void loadJobs(true) }
async function generatePreview() {
  if (!savedPlan.value || actionLocked.value || dirty.value || previewLoading.value) return
  resetPreview(); const version = ++previewVersion, id = savedPlan.value.id; previewLoading.value = true; operations.add(id); notice.value = ''
  try { const result = await fileBackupsApi.previewBackup(id); if (!alive || version !== previewVersion) return; if (!result.success) throw new Error(result.error); preview.value = result.preview; await loadPreviewPage(1) }
  catch (cause) { if (alive && version === previewVersion) backupError.value = errorText(cause) }
  finally { operations.delete(id); if (alive && version === previewVersion) previewLoading.value = false }
}
async function loadPreviewPage(targetPage: number) {
  const current = preview.value; if (!current) return
  const version = ++previewPageVersion, generation = previewVersion; previewPageLoading.value = true; backupConfirmed.value = false
  try { const result = await fileBackupsApi.getBackupPreview({ previewId: current.id, page: targetPage, pageSize: 50 }); if (!alive || version !== previewPageVersion || generation !== previewVersion) return; if (!result.success) throw new Error(result.error); preview.value = result.preview; previewTotal.value = result.total; const last = Math.max(1, Math.ceil(result.total / 50)); if (targetPage > last) { await loadPreviewPage(last); return }; previewItems.value = result.items; previewPage.value = result.page; backupError.value = '' }
  catch (cause) { if (alive && version === previewPageVersion) { backupError.value = errorText(cause); previewItems.value = []; previewStale.value = true } }
  finally { if (alive && version === previewPageVersion) previewPageLoading.value = false }
}
async function executeBackup() {
  const current = preview.value; if (!current?.executable || !backupConfirmed.value || actionLocked.value || dirty.value || previewStale.value || previewPageLoading.value) return
  const selection = selectionVersion, id = current.planId; operations.add(id); executing.value = true; backupError.value = ''
  try { const result = await fileBackupsApi.executeBackup({ planId: id, previewId: current.id }); if (!result.success) throw new Error(result.error); if (!alive || selection !== selectionVersion) return; resetPreview(); refreshKey.value++; if (result.unchanged) { notice.value = '源内容无变化，复用已有已校验版本，0 上传。'; reusedSnapshotId.value = result.snapshot.id } else { notice.value = '备份已提交，请在作业报告中查看校验结果。'; await loadJobs(); if (!alive || selection !== selectionVersion) return; requestedJobId.value = jobs.value.find(job => job.snapshotId === result.snapshot.id)?.id || ''; activeTab.value = 'jobs' }; void loadPlans() }
  catch (cause) { if (alive && selection === selectionVersion) { backupError.value = errorText(cause); previewStale.value = true; backupConfirmed.value = false } }
  finally { operations.delete(id); if (alive && selection === selectionVersion) executing.value = false }
}
function showSnapshot(id: string) { requestedSnapshotId.value = id; activeTab.value = 'versions' }
watch(fingerprint, () => { backupConfirmed.value = false; if (preview.value && dirty.value) previewStale.value = true })
onMounted(async () => { const initialDraft = fingerprint(), initialSelection = selectionVersion; await Promise.all([loadPlans(), loadAccounts()]); if (!alive) return; if (plans.value.length && selectionVersion === initialSelection && fingerprint() === initialDraft) selectPlan(plans.value[0]); poll = setInterval(() => { if (selectedId.value && !jobsLoading.value) { void loadJobs(true); jobRefreshKey.value++ } }, 5000) })
onBeforeUnmount(() => { alive = false; selectionVersion++; listVersion++; accountVersion++; jobsVersion++; previewVersion++; previewPageVersion++; sourceVersion++; if (poll) clearInterval(poll) })
</script>

<style src="../styles/file-backups.css"></style>
