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

    <!-- Task table -->
    <div class="task-card">
      <el-table
        :data="filteredTasks"
        style="width: 100%"
        :header-cell-style="headerStyle"
        :row-style="{ height: '52px' }"
        :cell-style="{ padding: '0' }"
        empty-text="暂无任务"
      >
        <el-table-column label="任务" min-width="240">
          <template #default="{ row }">
            <div class="task-name-cell">
              <div class="task-type-icon" :class="row.taskType">
                <component :is="taskTypeIcon(row.taskType)" :size="16" />
              </div>
              <div class="task-info">
                <span class="task-title">{{ row.title }}</span>
                <span class="task-type-label">{{ TASK_TYPE_LABELS[row.taskType] || row.taskType }}</span>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="120" align="center">
          <template #default="{ row }">
            <div class="task-status-badge" :class="row.status">
              <component :is="taskStatusIcon(row.status)" :size="12" />
              {{ TASK_STATUS_LABELS[row.status] || row.status }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="进度" width="140" align="center">
          <template #default="{ row }">
            <div class="progress-cell">
              <el-progress
                v-if="row.status === 'running'"
                :percentage="row.progress"
                :stroke-width="6"
                :show-text="false"
                color="#3b82f6"
              />
              <div v-else class="progress-bar-bg">
                <div class="progress-bar-fill" :style="{ width: row.progress + '%' }" :class="row.status"></div>
              </div>
              <span class="progress-text">{{ row.progress }}%</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="重试" width="70" align="center">
          <template #default="{ row }">
            <span class="cell-muted">{{ row.retryCount }}</span>
          </template>
        </el-table-column>

        <el-table-column label="创建时间" width="140" align="center">
          <template #default="{ row }">
            <span class="cell-muted">{{ formatTimestamp(row.createdAt) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="120" align="center" fixed="right">
          <template #default="{ row }">
            <div class="action-btns">
              <button
                v-if="row.status === 'failed'"
                class="action-btn"
                title="重试"
                @click="onRetry(row)"
              >
                <RotateCw :size="14" />
              </button>
              <button
                v-if="row.status === 'pending' || row.status === 'running'"
                class="action-btn danger"
                title="取消"
                @click="onCancel(row)"
              >
                <X :size="14" />
              </button>
              <button class="action-btn" title="查看日志" @click="onViewLog(row)">
                <FileText :size="14" />
              </button>
            </div>
          </template>
        </el-table-column>

        <template #empty>
          <div class="table-empty">
            <ListTodo :size="40" :stroke-width="1" />
            <p>暂无任务记录</p>
          </div>
        </template>
      </el-table>
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
import { ref, computed, onMounted, markRaw } from 'vue'
import { ElMessage } from 'element-plus'
import {
  ListTodo, RefreshCw, CheckCircle2, XCircle, Loader2, Clock,
  RotateCw, X, FileText, Copy, Trash2, FolderInput, Plus,
  CircleDot, AlertCircle, Share2, ArrowDownToLine, ExternalLink, Pause,
} from 'lucide-vue-next'
import { TASK_TYPE_LABELS, TASK_STATUS_LABELS } from '@shared/constants'
import { formatTimestamp } from '@shared/utils'
import { electronApi } from '../api/ipc'
import type { Task, LogEntry } from '@shared/types'

const tasks = ref<Task[]>([])
const statusFilter = ref('')
const taskTypeFilter = ref('')
const showLogDialog = ref(false)
const currentLogs = ref<LogEntry[]>([])
const currentTaskTitle = ref('')

const headerStyle = {
  background: '#f9fafb',
  color: '#6b7280',
  fontWeight: '600',
  fontSize: '12px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  borderBottom: '1px solid #e5e7eb',
  height: '44px',
}

const statusFilters = computed(() => [
  { value: '', label: '全部', icon: markRaw(ListTodo), count: tasks.value.length },
  { value: 'pending', label: '等待中', icon: markRaw(Clock), count: tasks.value.filter(t => t.status === 'pending').length },
  { value: 'running', label: '执行中', icon: markRaw(Loader2), count: tasks.value.filter(t => t.status === 'running').length },
  { value: 'success', label: '已完成', icon: markRaw(CheckCircle2), count: tasks.value.filter(t => t.status === 'success').length },
  { value: 'failed', label: '失败', icon: markRaw(XCircle), count: tasks.value.filter(t => t.status === 'failed').length },
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

async function onViewLog(task: Task) {
  currentTaskTitle.value = task.title
  const result = await electronApi.getTaskLogs(task.id)
  if (result.success) {
    currentLogs.value = result.logs
  }
  showLogDialog.value = true
}

onMounted(() => {
  onRefresh()
})
</script>

<style scoped>
.task-log {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── Page header ── */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 20px 24px;
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
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
  background: #eff6ff;
  color: #3b82f6;
  display: flex;
  align-items: center;
  justify-content: center;
}

.header-info h2 {
  font-size: 16px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 2px;
}

.header-info p {
  font-size: 12px;
  color: #9ca3af;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* ── Filter chips ── */
.filter-chips {
  display: flex;
  gap: 4px;
}

.filter-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: 1px solid #e5e7eb;
  background: #ffffff;
  border-radius: 6px;
  font-size: 12px;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.15s;
}

.filter-chip:hover {
  background: #f9fafb;
  border-color: #d1d5db;
}

.filter-chip.active {
  background: #eff6ff;
  border-color: #93c5fd;
  color: #3b82f6;
}

.chip-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 4px;
  background: #f3f4f6;
  font-size: 11px;
  font-weight: 600;
}

.filter-chip.active .chip-count {
  background: #dbeafe;
  color: #3b82f6;
}

/* ── Task card ── */
.task-card {
  flex: 1;
  overflow: hidden;
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
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
  font-size: 13px;
  font-weight: 500;
  color: #1f2937;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-type-label {
  font-size: 11px;
  color: #9ca3af;
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
  background: #f0fdf4;
  color: #22c55e;
}

.task-status-badge.failed {
  background: #fef2f2;
  color: #ef4444;
}

.task-status-badge.running {
  background: #fffbeb;
  color: #f59e0b;
}

.task-status-badge.running svg {
  animation: spin 1s linear infinite;
}

.task-status-badge.pending {
  background: #f3f4f6;
  color: #6b7280;
}

.task-status-badge.paused {
  background: #fef3c7;
  color: #d97706;
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
  padding: 0 8px;
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
  background: #3b82f6;
  transition: width 0.3s ease;
}

.progress-bar-fill.success {
  background: #22c55e;
}

.progress-bar-fill.failed {
  background: #ef4444;
}

.progress-text {
  font-size: 12px;
  color: #6b7280;
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
  background: #f9fafb;
  border-radius: 8px;
  border: 1px solid #f3f4f6;
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
</style>
