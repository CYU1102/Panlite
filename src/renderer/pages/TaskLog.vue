<template>
  <div class="task-log">
    <!-- Page header -->
    <div class="page-header">
      <div class="header-info">
        <div class="header-icon">
          <ListTodo :size="20" :stroke-width="1.5" />
        </div>
        <div>
          <h2>任务日志</h2>
          <p>查看任务执行状态和日志</p>
        </div>
      </div>
      <div class="header-actions">
        <div class="filter-chips">
          <button
            v-for="filter in statusFilters"
            :key="filter.value"
            class="filter-chip"
            :class="{ active: statusFilter === filter.value }"
            @click="statusFilter = filter.value"
          >
            <component :is="filter.icon" :size="12" />
            {{ filter.label }}
            <span v-if="filter.count > 0" class="chip-count">{{ filter.count }}</span>
          </button>
        </div>
        <div class="filter-chips">
          <button
            v-for="filter in typeFilters"
            :key="filter.value"
            class="filter-chip"
            :class="{ active: taskTypeFilter === filter.value }"
            @click="taskTypeFilter = filter.value"
          >
            {{ filter.label }}
          </button>
        </div>
        <el-button size="small" @click="onRefresh">
          <RefreshCw :size="14" style="margin-right: 4px" />
          刷新
        </el-button>
      </div>
    </div>

    <!-- Task cards -->
    <div class="task-card">
      <div v-if="filteredTasks.length > 0" class="task-list">
        <article
          v-for="row in filteredTasks"
          :key="row.id"
          class="task-row"
          :class="row.status"
          @click="onViewLog(row)"
        >
          <div class="task-row-main">
            <div class="task-type-icon" :class="row.taskType">
              <component :is="taskTypeIcon(row.taskType)" :size="17" />
            </div>
            <div class="task-info">
              <div class="task-title-row">
                <span class="task-title">{{ row.title }}</span>
                <span class="task-type-label">{{ TASK_TYPE_LABELS[row.taskType] || row.taskType }}</span>
              </div>
              <div class="task-meta">
                {{ formatTimestamp(row.createdAt) }} · 重试 {{ row.retryCount }} 次
                <span v-if="row.status === 'running'"> · {{ progressMetrics(row) }}</span>
              </div>
            </div>
          </div>

          <div class="task-row-progress">
            <div class="task-status-badge" :class="row.status">
              <component :is="taskStatusIcon(row.status)" :size="12" />
              {{ TASK_STATUS_LABELS[row.status] || row.status }}
            </div>
            <div class="progress-cell">
              <div class="progress-bar-bg">
                <div class="progress-bar-fill" :style="{ width: row.progress + '%' }" :class="row.status"></div>
              </div>
              <span class="progress-text">{{ row.progress }}%</span>
            </div>
          </div>

          <div class="task-row-actions" @click.stop>
            <button
              v-if="row.status === 'failed' || row.status === 'partial_success' || row.status === 'cancelled'"
              class="task-action primary"
              title="重新执行此任务"
              @click="onRetry(row)"
            >
              <RotateCw :size="14" />
              重试
            </button>
            <button
              v-if="row.status === 'pending' || row.status === 'running'"
              class="task-action"
              title="暂停此任务"
              @click="onPause(row)"
            >
              <Pause :size="14" />
              暂停
            </button>
            <button
              v-if="row.status === 'paused'"
              class="task-action primary"
              title="恢复此任务"
              @click="onResume(row)"
            >
              <Play :size="14" />
              恢复
            </button>
            <button
              v-if="row.status === 'pending' || row.status === 'running' || row.status === 'paused'"
              class="task-action danger"
              title="取消此任务"
              @click="onCancel(row)"
            >
              <X :size="14" />
              取消
            </button>
            <button class="task-action ghost" title="查看任务日志" @click="onViewLog(row)">
              <FileText :size="14" />
              日志
            </button>
            <button
              v-if="['success', 'partial_success', 'failed', 'cancelled'].includes(row.status)"
              class="task-action ghost danger"
              title="删除任务记录"
              @click="onDelete(row)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </article>
      </div>
      <div v-else class="table-empty">
        <ListTodo :size="42" :stroke-width="1.2" />
        <strong>暂无任务</strong>
        <p>任务执行后会在这里显示进度和日志</p>
      </div>
    </div>

    <!-- Stats bar -->
    <div class="stats-bar">
      <div class="stat-chip">
        <ListTodo :size="12" />
        共 {{ tasks.length }} 个任务
      </div>
      <div class="stat-chip success" v-if="tasks.filter(t => t.status === 'success').length > 0">
        <CheckCircle2 :size="12" />
        {{ tasks.filter(t => t.status === 'success').length }} 个完成
      </div>
      <div class="stat-chip warn" v-if="tasks.filter(t => t.status === 'running').length > 0">
        <Loader2 :size="12" />
        {{ tasks.filter(t => t.status === 'running').length }} 个执行中
      </div>
      <div class="stat-chip error" v-if="tasks.filter(t => t.status === 'failed').length > 0">
        <XCircle :size="12" />
        {{ tasks.filter(t => t.status === 'failed').length }} 个失败
      </div>
      <div class="stat-spacer"></div>
      <router-link to="/share-links" class="stat-link">
        <Share2 :size="12" />
        分享链接
        <ExternalLink :size="10" />
      </router-link>
      <router-link to="/transfer-records" class="stat-link">
        <ArrowDownToLine :size="12" />
        转存记录
        <ExternalLink :size="10" />
      </router-link>
    </div>

    <!-- Log Detail Dialog -->
    <el-dialog v-model="showLogDialog" width="640px" :show-close="true" class="log-dialog">
      <template #header>
        <div class="dialog-header">
          <h2>任务日志</h2>
          <p>{{ currentTaskTitle }}</p>
        </div>
      </template>
      <div class="log-content">
        <div v-if="currentLogs.length === 0" class="no-log">
          <FileText :size="32" :stroke-width="1" />
          <p>暂无日志记录</p>
        </div>
        <div v-else class="log-list">
          <div v-for="log in currentLogs" :key="log.id" class="log-item" :class="log.level">
            <div class="log-time">{{ formatTimestamp(log.createdAt) }}</div>
            <div class="log-level-badge" :class="log.level">
              {{ log.level.toUpperCase() }}
            </div>
            <div class="log-message">{{ log.message }}</div>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, markRaw } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs'
import {
  ListTodo, RefreshCw, CheckCircle2, XCircle, Loader2, Clock,
  RotateCw, X, FileText, Copy, Trash2, FolderInput, Plus,
  CircleDot, AlertCircle, Share2, ArrowDownToLine, ExternalLink, Pause, Play,
} from 'lucide-vue-next'
import { TASK_TYPE_LABELS, TASK_STATUS_LABELS } from '@shared/constants'
import { formatFileSize, formatTimestamp } from '@shared/utils'
import { electronApi } from '../api/ipc'
import { scheduleUndoableAction } from '../services/undo-feedback'
import type { Task, LogEntry } from '@shared/types'

const tasks = ref<Task[]>([])
const statusFilter = ref('')
const taskTypeFilter = ref('')
const showLogDialog = ref(false)
const currentLogs = ref<LogEntry[]>([])
const currentTaskTitle = ref('')
const nowTick = ref(Date.now())

const statusFilters = computed(() => [
  { value: '', label: '全部', icon: markRaw(ListTodo), count: tasks.value.length },
  { value: 'pending', label: '等待中', icon: markRaw(Clock), count: tasks.value.filter(t => t.status === 'pending').length },
  { value: 'running', label: '执行中', icon: markRaw(Loader2), count: tasks.value.filter(t => t.status === 'running').length },
  { value: 'success', label: '已完成', icon: markRaw(CheckCircle2), count: tasks.value.filter(t => t.status === 'success').length },
  { value: 'partial_success', label: '部分完成', icon: markRaw(AlertCircle), count: tasks.value.filter(t => t.status === 'partial_success').length },
  { value: 'failed', label: '失败', icon: markRaw(XCircle), count: tasks.value.filter(t => t.status === 'failed').length },
  { value: 'paused', label: '已暂停', icon: markRaw(Pause), count: tasks.value.filter(t => t.status === 'paused').length },
  { value: 'cancelled', label: '已取消', icon: markRaw(XCircle), count: tasks.value.filter(t => t.status === 'cancelled').length },
])

const typeFilters = computed(() => [
  { value: '', label: '全部类型' },
  { value: 'share', label: '分享' },
  { value: 'batch_share', label: '批量分享' },
  { value: 'transfer', label: '转存' },
  { value: 'batch_transfer', label: '批量转存' },
  { value: 'rename', label: '重命名' },
  { value: 'move', label: '移动' },
  { value: 'delete', label: '删除' },
  { value: 'upload', label: '上传' },
  { value: 'download', label: '下载' },
  { value: 'archive_extract', label: '解压' },
  { value: 'archive_compress', label: '压缩' },
])

const filteredTasks = computed(() => {
  let result = tasks.value
  if (statusFilter.value) {
    result = result.filter((t) => t.status === statusFilter.value)
  }
  if (taskTypeFilter.value) {
    result = result.filter((t) => t.taskType === taskTypeFilter.value)
  }
  return result
})

function taskTypeIcon(type: string) {
  switch (type) {
    case 'rename': return markRaw(Copy)
    case 'move': return markRaw(FolderInput)
    case 'delete': return markRaw(Trash2)
    case 'copy': return markRaw(Copy)
    case 'share':
    case 'batch_share': return markRaw(Share2)
    case 'transfer':
    case 'batch_transfer': return markRaw(ArrowDownToLine)
    default: return markRaw(Plus)
  }
}

function taskStatusIcon(status: string) {
  switch (status) {
    case 'success': return markRaw(CheckCircle2)
    case 'failed': return markRaw(XCircle)
    case 'running': return markRaw(Loader2)
    case 'pending': return markRaw(Clock)
    case 'paused': return markRaw(Pause)
    case 'partial_success': return markRaw(AlertCircle)
    case 'cancelled': return markRaw(XCircle)
    default: return markRaw(CircleDot)
  }
}

async function onRefresh() {
  const result = await electronApi.listTasks()
  if (result.success) {
    tasks.value = result.tasks
  }
}

async function onRetry(task: Task) {
  const result = await electronApi.retryTask(task.id)
  if (result.success) {
    ElMessage.success('任务已重新排队')
    onRefresh()
  } else {
    ElMessage.error(result.error || '重试失败')
  }
}

async function onCancel(task: Task) {
  const result = await electronApi.cancelTask(task.id)
  if (result.success) {
    ElMessage.success('任务已取消')
    onRefresh()
  }
}

function taskTotalBytes(task: Task): number {
  const payload = task.payload || {}
  const direct = Number(payload.totalBytes || payload.fileSize || payload.size || 0)
  if (Number.isFinite(direct) && direct > 0) return direct
  for (const key of ['files', 'items']) {
    const values = payload[key]
    if (Array.isArray(values)) {
      const total = values.reduce((sum, item) => sum + Number((item as Record<string, unknown>)?.size || (item as Record<string, unknown>)?.fileSize || 0), 0)
      if (total > 0) return total
    }
  }
  return 0
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '估算中'
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`
  return `${(seconds / 3600).toFixed(1)} 小时`
}

function progressMetrics(task: Task): string {
  const currentTime = nowTick.value
  const elapsed = Math.max(1, (currentTime - task.createdAt) / 1000)
  const progress = Math.max(0, Math.min(100, task.progress))
  if (progress <= 0) return '正在准备'
  const totalBytes = taskTotalBytes(task)
  const remainingSeconds = elapsed * (100 - progress) / progress
  if (totalBytes > 0) {
    const bytesPerSecond = totalBytes * progress / 100 / elapsed
    return `${formatFileSize(bytesPerSecond)}/s · 剩余约 ${formatDuration(remainingSeconds)}`
  }
  return `${(progress / elapsed * 60).toFixed(1)}%/分钟 · 剩余约 ${formatDuration(remainingSeconds)}`
}

async function onPause(task: Task) {
  const result = await electronApi.pauseTask(task.id)
  if (result.success) {
    ElMessage.success('任务已暂停')
    onRefresh()
  } else {
    ElMessage.error(result.error || '暂停失败')
  }
}

async function onResume(task: Task) {
  const result = await electronApi.resumeTask(task.id)
  if (result.success) {
    ElMessage.success('任务已恢复')
    onRefresh()
  } else {
    ElMessage.error(result.error || '恢复失败')
  }
}

async function onDelete(task: Task) {
  try {
    await ElMessageBox.confirm('删除这条任务及其日志记录？', '删除任务记录', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch { return }
  tasks.value = tasks.value.filter(item => item.id !== task.id)
  scheduleUndoableAction({
    title: '任务记录已移除',
    message: '将在 5 秒后永久删除任务和日志。',
    onUndo: () => { tasks.value = [...tasks.value, task].sort((left, right) => right.createdAt - left.createdAt) },
    onCommit: async () => {
      const result = await electronApi.deleteTask(task.id)
      if (!result.success) { ElMessage.error(result.error || '删除失败'); await onRefresh() }
    },
  })
}

async function onViewLog(task: Task) {
  currentTaskTitle.value = task.title
  const result = await electronApi.getTaskLogs(task.id)
  if (result.success) {
    currentLogs.value = result.logs
  }
  showLogDialog.value = true
}

let removeTaskListener: (() => void) | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  onRefresh()
  removeTaskListener = electronApi.onTaskUpdated(() => { void onRefresh() })
  clockTimer = setInterval(() => { nowTick.value = Date.now() }, 1000)
})

onUnmounted(() => {
  removeTaskListener?.()
  if (clockTimer) clearInterval(clockTimer)
})
</script>

<style scoped>
.task-log {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--pl-space-4);
}

/* ── Page header ── */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  padding: 16px 20px;
  background: var(--pl-surface);
  border-radius: var(--pl-radius-card);
  border: 1px solid var(--pl-border);
  box-shadow: var(--pl-shadow-card);
}

.header-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--pl-primary-soft);
  color: var(--pl-primary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.header-info h2 {
  font-size: 16px;
  font-weight: 700;
  color: var(--pl-text);
  margin-bottom: 2px;
}

.header-info p {
  font-size: 12px;
  color: var(--pl-text-muted);
}

.header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
  gap: 12px;
}

/* ── Filter chips ── */
.filter-chips {
  display: flex;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: thin;
  padding-bottom: 2px;
}

.filter-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 11px;
  border: 1px solid var(--pl-border);
  background: #ffffff;
  border-radius: var(--pl-radius-sm);
  font-size: 12px;
  white-space: nowrap;
  flex: 0 0 auto;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.15s;
}

.filter-chip:hover {
  background: #f7f9fc;
  border-color: var(--pl-border-strong);
}

.filter-chip.active {
  background: var(--pl-primary-soft);
  border-color: #b9cdfa;
  color: var(--pl-primary-hover);
}

.chip-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 4px;
  background: #f2f4f7;
  font-size: 11px;
  font-weight: 600;
}

.filter-chip.active .chip-count {
  background: #dbe7ff;
  color: var(--pl-primary-hover);
}

/* ── Task card ── */
.task-card {
  flex: 1;
  overflow: auto;
  background: var(--pl-surface);
  border-radius: var(--pl-radius-card);
  border: 1px solid var(--pl-border);
  box-shadow: var(--pl-shadow-card);
  padding: 8px;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.task-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 76px;
  position: relative;
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(190px, 240px) auto;
  align-items: center;
  gap: 18px;
  min-height: 76px;
  padding: 12px 14px;
  border: 1px solid transparent;
  border-radius: 11px;
  background: var(--pl-surface);
  cursor: pointer;
  transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
}

.task-row::before {
  content: '';
  position: absolute;
  left: 0;
  top: 16px;
  bottom: 16px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: #d9e1ec;
}

.task-row.running::before { background: var(--pl-primary); }
.task-row.success::before { background: var(--pl-success); }
.task-row.partial_success::before,
.task-row.paused::before { background: var(--pl-warning); }
.task-row.failed::before { background: var(--pl-danger); }

.task-row:hover {
  transform: translateY(-1px);
  border-color: #cfdcf5;
  background: #fbfdff;
  box-shadow: 0 8px 20px rgba(31, 41, 55, 0.07);
}

.task-row:focus-within {
  border-color: #b9cdfa;
  box-shadow: 0 0 0 3px rgba(52, 120, 246, 0.1);
}

.task-row-main,
.task-title-row,
.task-meta,
.task-row-progress,
.task-row-actions {
  display: flex;
  align-items: center;
}

.task-row-main {
  gap: 12px;
  min-width: 0;
}

.task-title-row {
  gap: 8px;
  min-width: 0;
}

.task-meta {
  margin-top: 5px;
  color: var(--pl-text-muted);
  font-size: 11px;
}

.task-row-progress {
  flex-direction: column;
  align-items: stretch;
  gap: 9px;
}

.task-row-actions {
  justify-content: flex-end;
  gap: 6px;
  opacity: 0.72;
  transform: translateX(4px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.task-row:hover .task-row-actions,
.task-row:focus-within .task-row-actions {
  opacity: 1;
  transform: translateX(0);
}

.task-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--pl-border);
  border-radius: 8px;
  color: var(--pl-text-secondary);
  background: var(--pl-surface);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease, transform 0.15s ease;
}

.task-action:hover {
  border-color: #b9cdfa;
  color: var(--pl-primary-hover);
  background: var(--pl-primary-soft);
  transform: translateY(-1px);
}

.task-action.primary {
  border-color: transparent;
  color: #fff;
  background: var(--pl-primary);
}

.task-action.primary:hover {
  color: #fff;
  background: var(--pl-primary-hover);
}

.task-action.ghost {
  padding-inline: 8px;
  border-color: transparent;
  background: transparent;
}

.task-action.danger:hover {
  border-color: #f3c3cb;
  color: var(--pl-danger);
  background: var(--pl-danger-soft);
}

/* ── Table overrides ── */
:deep(.el-table) {
  --el-table-border-color: #f3f4f6;
  --el-table-row-hover-bg-color: #f9fafb;
}

:deep(.el-table th.el-table__cell) {
  background: #f9fafb !important;
}

:deep(.el-table td.el-table__cell) {
  border-bottom: 1px solid #f3f4f6;
}

/* ── Task name cell ── */
.task-name-cell {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  height: 52px;
}

.task-type-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.task-type-icon.rename {
  background: #eff6ff;
  color: #3b82f6;
}

.task-type-icon.move {
  background: #f0fdf4;
  color: #22c55e;
}

.task-type-icon.delete {
  background: #fef2f2;
  color: #ef4444;
}

.task-type-icon.copy {
  background: #fffbeb;
  color: #f59e0b;
}

.task-type-icon.share,
.task-type-icon.batch_share {
  background: #f0fdf4;
  color: #22c55e;
}

.task-type-icon.transfer,
.task-type-icon.batch_transfer {
  background: #faf5ff;
  color: #a855f7;
}

.task-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.task-title {
  font-size: 14px;
  font-weight: 650;
  color: var(--pl-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-type-label {
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 5px;
  background: #f1f4f8;
  font-size: 10px;
  color: var(--pl-text-secondary);
}

/* ── Status badge ── */
.task-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
}

.task-status-badge.success {
  background: var(--pl-success-soft);
  color: var(--pl-success);
}

.task-status-badge.failed {
  background: var(--pl-danger-soft);
  color: var(--pl-danger);
}

.task-status-badge.partial_success {
  background: var(--pl-warning-soft);
  color: var(--pl-warning);
}

.task-status-badge.cancelled {
  background: #f3f4f6;
  color: var(--pl-text-secondary);
}

.task-status-badge.running {
  background: var(--pl-info-soft);
  color: var(--pl-primary);
}

.task-status-badge.running svg {
  animation: spin 1s linear infinite;
}

.task-status-badge.pending {
  background: #f3f4f6;
  color: #6b7280;
}

.task-status-badge.paused {
  background: var(--pl-warning-soft);
  color: var(--pl-warning);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ── Progress cell ── */
.progress-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  width: 100%;
}

.progress-bar-bg {
  flex: 1;
  height: 6px;
  background: #f3f4f6;
  border-radius: 3px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--pl-primary);
  transition: width 0.3s ease;
}

.progress-bar-fill.success {
  background: var(--pl-success);
}

.progress-bar-fill.failed {
  background: var(--pl-danger);
}

.progress-bar-fill.partial_success {
  background: var(--pl-warning);
}

.progress-text {
  font-size: 12px;
  color: var(--pl-text-secondary);
  min-width: 32px;
  text-align: right;
}

/* ── Cells ── */
.cell-muted {
  font-size: 12px;
  color: #9ca3af;
}

/* ── Action buttons ── */
.action-btns {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn:hover {
  background: #f3f4f6;
  color: #6b7280;
}

.action-btn.danger:hover {
  background: #fef2f2;
  color: #ef4444;
}

/* ── Empty state ── */
.table-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 0;
  color: #d1d5db;
}

.table-empty p {
  font-size: 13px;
  color: #9ca3af;
}

/* ── Stats bar ── */
.stats-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  background: #fbfcfe;
  border-radius: 10px;
  border: 1px solid #e4e9f1;
}

.stat-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #6b7280;
}

.stat-chip.success { color: #22c55e; }
.stat-chip.warn { color: #f59e0b; }
.stat-chip.error { color: #ef4444; }

.stat-spacer { flex: 1; }

.stat-link {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #3b82f6;
  text-decoration: none;
  cursor: pointer;
  transition: color 0.15s;
}

.stat-link:hover {
  color: #2563eb;
}

/* ── Log dialog ── */
.dialog-header h2 {
  font-size: 18px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 4px;
}

.dialog-header p {
  font-size: 13px;
  color: #9ca3af;
}

.log-content {
  max-height: 400px;
  overflow-y: auto;
}

.no-log {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 0;
  color: #d1d5db;
}

.no-log p {
  font-size: 13px;
  color: #9ca3af;
}

.log-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.log-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f9fafb;
}

.log-item.error {
  background: #fef2f2;
}

.log-item.warn {
  background: #fffbeb;
}

.log-time {
  font-size: 12px;
  color: #9ca3af;
  white-space: nowrap;
  min-width: 120px;
}

.log-level-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  background: #f3f4f6;
  color: #6b7280;
  white-space: nowrap;
}

.log-level-badge.error {
  background: #fef2f2;
  color: #ef4444;
}

.log-level-badge.warn {
  background: #fffbeb;
  color: #f59e0b;
}

.log-level-badge.info {
  background: #eff6ff;
  color: #3b82f6;
}

.log-message {
  flex: 1;
  font-size: 13px;
  color: #374151;
  word-break: break-all;
}

@media (max-width: 1120px) {
  .page-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .header-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .task-row {
    grid-template-columns: minmax(220px, 1fr) minmax(170px, 220px);
  }

  .task-row-actions {
    grid-column: 1 / -1;
    justify-content: flex-start;
    padding-left: 48px;
    opacity: 1;
    transform: none;
  }
}

@media (max-width: 760px) {
  .task-log {
    gap: 10px;
  }

  .task-row {
    grid-template-columns: 1fr;
    gap: 12px;
    padding: 13px;
  }

  .task-row-actions {
    grid-column: auto;
    padding-left: 0;
    flex-wrap: wrap;
  }

  .stats-bar {
    flex-wrap: wrap;
  }

  .stat-spacer {
    display: none;
  }
}
</style>
