<template>
  <div class="transfer-records">
    <div class="page-header">
      <div class="header-info">
        <div class="header-icon">
          <ArrowDownToLine :size="20" :stroke-width="1.5" />
        </div>
        <div>
          <h2>转存记录</h2>
          <p>追踪网盘转存结果，快速定位失败原因</p>
        </div>
      </div>
      <div class="header-actions">
        <el-button size="small" type="primary" @click="$router.push('/batch-transfer')">
          <Plus :size="14" style="margin-right: 4px" />
          新建转存
        </el-button>
        <el-button size="small" @click="onExport" :loading="exporting">
          <Download :size="14" style="margin-right: 4px" />
          导出 CSV
        </el-button>
        <el-button size="small" @click="loadData">
          <RefreshCw :size="14" style="margin-right: 4px" />
          刷新
        </el-button>
      </div>
    </div>

    <!-- Filters -->
    <div class="filter-bar">
      <div class="filter-group">
        <span class="filter-label">平台</span>
        <div class="filter-chips">
          <button
            v-for="f in platformFilters"
            :key="f.value"
            class="filter-chip"
            :class="{ active: filters.platform === f.value }"
            :aria-pressed="filters.platform === f.value"
            @click="filters.platform = f.value; loadData()"
          >
            {{ f.label }}
          </button>
        </div>
      </div>
      <div class="filter-group">
        <span class="filter-label">状态</span>
        <div class="filter-chips">
          <button
            v-for="f in statusFilters"
            :key="f.value"
            class="filter-chip"
            :class="{ active: filters.status === f.value }"
            :aria-pressed="filters.status === f.value"
            @click="filters.status = f.value; loadData()"
          >
            {{ f.label }}
          </button>
        </div>
      </div>
      <div class="filter-search">
        <el-input
          v-model="filters.keyword"
          placeholder="搜索链接 / 路径 / 错误"
          clearable
          size="small"
          @clear="loadData()"
          @keyup.enter="loadData()"
        >
          <template #prefix>
            <Search :size="14" />
          </template>
        </el-input>
      </div>
      <div class="filter-feedback" aria-live="polite">
        <span>{{ hasActiveFilters ? `筛选到 ${records.length} 条` : `共 ${records.length} 条` }}</span>
        <button v-if="hasActiveFilters" class="clear-filter" @click="resetFilters">
          <RotateCcw :size="12" />
          清除筛选
        </button>
      </div>
    </div>

    <!-- Batch action bar -->
    <transition name="slide-fade">
      <div v-if="selectedRows.length > 0" class="batch-bar">
        <div class="batch-info">
          <CheckCircle2 :size="16" />
          已选择 <strong>{{ selectedRows.length }}</strong> 条记录
        </div>
        <div class="batch-actions">
          <el-button size="small" type="danger" plain @click="onBatchDelete">
            <Trash2 :size="14" style="margin-right: 4px" />
            批量删除
          </el-button>
        </div>
      </div>
    </transition>

    <!-- Table -->
    <div class="table-card">
      <el-table
        :data="records"
        style="width: 100%"
        :header-cell-style="headerStyle"
        :row-style="{ height: '52px' }"
        :row-class-name="rowClassName"
        empty-text="暂无转存记录"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="48" align="center" />
        <el-table-column label="平台" width="90" align="center">
          <template #default="{ row }">
            <span class="platform-badge" :class="row.platform">{{ PLATFORM_LABELS[row.platform] || row.platform }}</span>
          </template>
        </el-table-column>

        <el-table-column label="来源链接" min-width="200">
          <template #default="{ row }">
            <span class="cell-link">{{ row.source_url }}</span>
          </template>
        </el-table-column>

        <el-table-column label="目标目录" width="120" align="center">
          <template #default="{ row }">
            <span class="cell-muted">{{ row.target_path || row.target_dir_id || '/' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="保存数量" width="80" align="center">
          <template #default="{ row }">
            <span class="saved-count">{{ row.saved_count }}</span>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="80" align="center">
          <template #default="{ row }">
            <span class="status-badge" :class="row.status">
              <span class="status-dot"></span>
              {{ statusLabel(row.status) }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="错误原因" min-width="160">
          <template #default="{ row }">
            <span class="cell-error" :class="{ 'is-empty': !row.error_message }" :title="row.error_message || '无错误'">{{ row.error_message || '-' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="创建时间" width="140" align="center">
          <template #default="{ row }">
            <span class="cell-muted">{{ formatTimestamp(row.created_at) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="完成时间" width="140" align="center">
          <template #default="{ row }">
            <span class="cell-muted">{{ row.finished_at ? formatTimestamp(row.finished_at) : '-' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="190" align="center" fixed="right">
          <template #default="{ row }">
            <div class="action-btns">
              <button class="action-btn action-primary" title="复制来源链接" aria-label="复制来源链接" @click="onCopy(row)">
                <Copy :size="14" />
                <span>复制</span>
              </button>
              <button
                v-if="row.error_message"
                class="action-btn"
                title="查看错误"
                aria-label="查看转存错误详情"
                @click="onViewError(row)"
              >
                <AlertCircle :size="14" />
                <span>详情</span>
              </button>
              <span class="action-divider" aria-hidden="true"></span>
              <button class="action-btn action-icon danger" title="删除记录" aria-label="删除转存记录" @click="onDelete(row)">
                <Trash2 :size="14" />
              </button>
            </div>
          </template>
        </el-table-column>

        <template #empty>
          <div class="table-empty">
            <div class="empty-icon"><ArrowDownToLine :size="32" :stroke-width="1.4" /></div>
            <strong>{{ hasActiveFilters ? '没有匹配的转存记录' : '还没有转存记录' }}</strong>
            <p>{{ hasActiveFilters ? '尝试调整平台、状态或搜索关键词' : '发起转存后，可在这里查看结果和失败原因' }}</p>
            <el-button v-if="hasActiveFilters" size="small" @click="resetFilters">
              <RotateCcw :size="14" style="margin-right: 4px" />
              清除筛选
            </el-button>
            <el-button v-else size="small" type="primary" @click="$router.push('/batch-transfer')">
              <Plus :size="14" style="margin-right: 4px" />
              新建转存
            </el-button>
          </div>
        </template>
      </el-table>
    </div>

    <!-- Stats bar -->
    <div class="stats-bar">
      <div class="stat-chip">
        <ArrowDownToLine :size="12" />
        共 {{ records.length }} 条记录
      </div>
    </div>

    <!-- Error Detail Dialog -->
    <el-dialog v-model="showErrorDialog" title="错误详情" width="480px">
      <div class="error-detail">
        <p>{{ currentError }}</p>
      </div>
      <template #footer>
        <el-button @click="showErrorDialog = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs'
import { ArrowDownToLine, Download, RefreshCw, Search, Copy, AlertCircle, Trash2, CheckCircle2, Plus, RotateCcw } from 'lucide-vue-next'
import { PLATFORM_LABELS } from '@shared/constants'
import { formatTimestamp } from '@shared/utils'
import { electronApi } from '../api/ipc'

interface TransferRecordRow {
  id: string
  account_id: string
  platform: string
  source_url: string
  password: string | null
  target_dir_id: string | null
  target_path: string | null
  saved_count: number
  status: string
  error_message: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
  account_nickname?: string
}

const records = ref<TransferRecordRow[]>([])
const exporting = ref(false)
const showErrorDialog = ref(false)
const currentError = ref('')
const selectedRows = ref<TransferRecordRow[]>([])

function onSelectionChange(rows: TransferRecordRow[]) {
  selectedRows.value = rows
}

async function onBatchDelete() {
  if (selectedRows.value.length === 0) return
  try {
    await ElMessageBox.confirm(
      `确定要删除选中的 ${selectedRows.value.length} 条记录吗？`,
      '批量删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch { return }

  let deletedCount = 0
  for (const row of selectedRows.value) {
    const result = await electronApi.transferDelete(row.id)
    if (result.success) deletedCount++
  }

  if (deletedCount > 0) {
    const ids = new Set(selectedRows.value.map(r => r.id))
    records.value = records.value.filter(r => !ids.has(r.id))
    selectedRows.value = []
    ElMessage.success(`已删除 ${deletedCount} 条记录`)
  }
}

const filters = reactive({
  platform: '',
  status: '',
  keyword: '',
})

const hasActiveFilters = computed(() => Boolean(filters.platform || filters.status || filters.keyword.trim()))

const platformFilters = [
  { value: '', label: '全部' },
  { value: 'quark', label: '夸克' },
  { value: 'baidu', label: '百度' },
]

const statusFilters = [
  { value: '', label: '全部' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'running', label: '执行中' },
  { value: 'pending', label: '等待中' },
]

const headerStyle = {
  background: 'var(--pl-surface-subtle)',
  color: 'var(--pl-text-secondary)',
  fontWeight: '600',
  fontSize: '12px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  borderBottom: '1px solid var(--pl-border)',
  height: '44px',
}

function statusLabel(status: string): string {
  const map: Record<string, string> = { success: '成功', failed: '失败', running: '执行中', pending: '等待中' }
  return map[status] || status
}

function rowClassName({ row }: { row: TransferRecordRow }): string {
  return selectedRows.value.some((selected) => selected.id === row.id) ? 'is-row-selected' : ''
}

function resetFilters() {
  filters.platform = ''
  filters.status = ''
  filters.keyword = ''
  loadData()
}

async function loadData() {
  const f: Record<string, string> = {}
  if (filters.platform) f.platform = filters.platform
  if (filters.status) f.status = filters.status
  if (filters.keyword) f.keyword = filters.keyword
  const result = await electronApi.transferList(f)
  if (result.success) {
    records.value = result.records as TransferRecordRow[]
  } else {
    ElMessage.error(result.error || '加载失败')
  }
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(
    () => ElMessage.success('已复制到剪贴板'),
    () => ElMessage.error('复制失败'),
  )
}

function onCopy(row: TransferRecordRow) {
  copyToClipboard(row.source_url)
}

function onViewError(row: TransferRecordRow) {
  currentError.value = row.error_message || '无错误信息'
  showErrorDialog.value = true
}

async function onDelete(row: TransferRecordRow) {
  try {
    await ElMessageBox.confirm('确定要删除这条转存记录吗？', '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch { return }

  const result = await electronApi.transferDelete(row.id)
  if (result.success) {
    records.value = records.value.filter((r) => r.id !== row.id)
    ElMessage.success('已删除')
  } else {
    ElMessage.error(result.error || '删除失败')
  }
}

async function onExport() {
  exporting.value = true
  try {
    const f: Record<string, string> = {}
    if (filters.platform) f.platform = filters.platform
    if (filters.status) f.status = filters.status
    const result = await electronApi.transferExportCsv(f)
    if (result.success && result.csv) {
      const d = new Date()
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const filename = `panlite-transfer-records-${dateStr}.csv`
      const blob = new Blob(['﻿' + result.csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      ElMessage.success('导出成功')
    } else {
      ElMessage.error(result.error || '导出失败')
    }
  } catch (err) {
    ElMessage.error('导出失败: ' + String(err))
  } finally {
    exporting.value = false
  }
}

onMounted(() => loadData())
</script>

<style scoped>
.transfer-records {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--pl-space-3);
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
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
  gap: 8px;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--pl-surface);
  border-radius: var(--pl-radius-card);
  border: 1px solid var(--pl-border);
  box-shadow: var(--pl-shadow-card);
  flex-wrap: wrap;
}

.filter-chips {
  display: flex;
  gap: 6px;
}

.filter-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 11px;
  border: 1px solid var(--pl-border);
  background: var(--pl-surface);
  border-radius: var(--pl-radius-sm);
  font-size: 12px;
  color: var(--pl-text-secondary);
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

.table-card {
  flex: 1;
  overflow: auto;
  background: #ffffff;
  border-radius: var(--pl-radius-card);
  border: 1px solid var(--pl-border);
  box-shadow: var(--pl-shadow-card);
}

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

.platform-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.platform-badge.quark {
  background: #eff6ff;
  color: #3b82f6;
}

.platform-badge.baidu {
  background: #fef2f2;
  color: #ef4444;
}

.cell-link {
  font-size: 12px;
  color: #6b7280;
  word-break: break-all;
}

.cell-muted {
  font-size: 12px;
  color: #9ca3af;
}

.cell-error {
  font-size: 12px;
  color: #ef4444;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
  display: inline-block;
}

.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.status-badge.success {
  background: #f0fdf4;
  color: #22c55e;
}

.status-badge.failed {
  background: #fef2f2;
  color: #ef4444;
}

.status-badge.running {
  background: #fffbeb;
  color: #f59e0b;
}

.status-badge.pending {
  background: #f3f4f6;
  color: #6b7280;
}

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

/* ── Batch bar ── */
.batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 12px;
}
.batch-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #3b82f6;
}
.batch-actions {
  display: flex;
  gap: 6px;
}
.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: all 0.2s ease;
}
.slide-fade-enter-from,
.slide-fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

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

.error-detail {
  padding: 12px;
  background: #fef2f2;
  border-radius: 8px;
  font-size: 13px;
  color: #374151;
  word-break: break-all;
  white-space: pre-wrap;
}

/* Interactive records workspace */
.transfer-records {
  min-width: 0;
  gap: var(--pl-space-3);
}

.page-header {
  padding: var(--pl-space-5) var(--pl-space-6);
  align-items: center;
  background: linear-gradient(135deg, var(--pl-surface) 0%, var(--pl-surface-subtle) 100%);
}

.header-icon {
  box-shadow: inset 0 0 0 1px rgba(52, 120, 246, 0.08);
}

.header-info p {
  color: var(--pl-text-secondary);
}

.filter-bar {
  padding: var(--pl-space-3) var(--pl-space-4);
  gap: var(--pl-space-3);
}

.filter-group {
  display: flex;
  align-items: center;
  gap: var(--pl-space-2);
  min-width: 0;
}

.filter-label {
  flex-shrink: 0;
  color: var(--pl-text-muted);
  font-size: 11px;
  font-weight: 600;
}

.filter-chips {
  overflow-x: auto;
  scrollbar-width: none;
}

.filter-chips::-webkit-scrollbar {
  display: none;
}

.filter-chip {
  flex-shrink: 0;
  border-color: transparent;
  background: var(--pl-surface-subtle);
  border-radius: 999px;
  transition: transform 150ms ease, color 150ms ease, background 150ms ease, border-color 150ms ease;
}

.filter-chip:hover {
  background: var(--pl-primary-soft);
  border-color: rgba(52, 120, 246, 0.18);
  color: var(--pl-primary);
  transform: translateY(-1px);
}

.filter-chip:active {
  transform: translateY(0) scale(0.97);
}

.filter-chip.active {
  background: var(--pl-primary);
  border-color: var(--pl-primary);
  color: #ffffff;
  box-shadow: 0 3px 8px rgba(52, 120, 246, 0.18);
}

.filter-search {
  width: 220px;
  margin-left: auto;
}

.filter-feedback {
  min-width: 84px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  color: var(--pl-text-muted);
  font-size: 11px;
}

.clear-filter {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--pl-primary);
  font-size: 11px;
  cursor: pointer;
}

.clear-filter:hover {
  color: var(--pl-primary-hover);
  text-decoration: underline;
}

.batch-bar {
  background: var(--pl-primary-soft);
  border-color: rgba(52, 120, 246, 0.22);
  border-radius: var(--pl-radius-control);
}

.batch-info {
  color: var(--pl-primary);
}

.table-card {
  min-width: 0;
  background: var(--pl-surface);
}

:deep(.el-table) {
  --el-table-border-color: var(--pl-border);
  --el-table-row-hover-bg-color: var(--pl-primary-soft);
  --el-table-current-row-bg-color: var(--pl-primary-soft);
}

:deep(.el-table th.el-table__cell) {
  background: var(--pl-surface-subtle) !important;
}

:deep(.el-table td.el-table__cell) {
  border-bottom-color: #eef1f5;
  transition: background 150ms ease, box-shadow 150ms ease;
}

:deep(.el-table__row:hover > td.el-table__cell) {
  background: #f3f7ff !important;
}

:deep(.el-table__row.is-row-selected > td.el-table__cell) {
  background: var(--pl-primary-soft) !important;
}

:deep(.el-table__row.is-row-selected > td.el-table__cell:first-child) {
  box-shadow: inset 3px 0 0 var(--pl-primary);
}

.platform-badge {
  border-radius: 999px;
  font-weight: 600;
}

.platform-badge.quark { background: var(--pl-primary-soft); color: var(--pl-primary); }
.platform-badge.baidu { background: var(--pl-danger-soft); color: var(--pl-danger); }

.cell-link {
  color: var(--pl-text-secondary);
}

.cell-muted {
  color: var(--pl-text-muted);
}

.saved-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 24px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--pl-primary-soft);
  color: var(--pl-primary);
  font-size: 11px;
  font-weight: 700;
}

.cell-error {
  color: var(--pl-danger);
}

.cell-error.is-empty {
  color: var(--pl-text-muted);
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  font-weight: 600;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.status-badge.success { background: var(--pl-success-soft); color: var(--pl-success); }
.status-badge.failed { background: var(--pl-danger-soft); color: var(--pl-danger); }
.status-badge.running { background: var(--pl-primary-soft); color: var(--pl-primary); }
.status-badge.pending { background: var(--pl-warning-soft); color: var(--pl-warning); }

.status-badge.running .status-dot {
  animation: status-pulse 1.4s ease-in-out infinite;
}

@keyframes status-pulse {
  50% { opacity: 0.35; transform: scale(0.75); }
}

.action-btns {
  gap: 4px;
}

.action-btn {
  width: auto;
  min-width: 52px;
  height: 30px;
  padding: 0 8px;
  gap: 5px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--pl-text-secondary);
  border-radius: var(--pl-radius-sm);
  font-size: 11px;
  font-weight: 600;
}

.action-btn:hover,
.action-btn:focus-visible {
  background: var(--pl-surface);
  border-color: var(--pl-border-strong);
  color: var(--pl-primary);
  box-shadow: var(--pl-shadow-card);
  transform: translateY(-1px);
}

.action-btn:active {
  transform: translateY(0) scale(0.97);
}

.action-primary {
  background: var(--pl-primary-soft);
  color: var(--pl-primary);
}

.action-icon {
  min-width: 30px;
  width: 30px;
  padding: 0;
}

.action-divider {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: var(--pl-border);
}

.action-btn.danger:hover,
.action-btn.danger:focus-visible {
  background: var(--pl-danger-soft);
  border-color: rgba(217, 83, 104, 0.25);
  color: var(--pl-danger);
}

.table-empty {
  min-height: 300px;
  justify-content: center;
  gap: var(--pl-space-2);
  padding: 52px var(--pl-space-5);
  color: var(--pl-text-muted);
}

.empty-icon {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--pl-space-1);
  border-radius: 18px;
  background: var(--pl-primary-soft);
  color: #8fb2f4;
}

.table-empty strong {
  color: var(--pl-text);
  font-size: 14px;
}

.table-empty p {
  margin-bottom: var(--pl-space-2);
  color: var(--pl-text-secondary);
  text-align: center;
}

.stats-bar {
  background: var(--pl-surface);
  border-color: var(--pl-border);
  border-radius: var(--pl-radius-control);
}

.stat-chip {
  color: var(--pl-text-secondary);
}

.error-detail {
  background: var(--pl-danger-soft);
  color: var(--pl-text);
  border: 1px solid rgba(217, 83, 104, 0.18);
  border-radius: var(--pl-radius-control);
}

@media (max-width: 900px) {
  .filter-search {
    width: min(270px, 100%);
    margin-left: 0;
  }

  .filter-feedback {
    margin-left: auto;
  }
}

@media (max-width: 680px) {
  .page-header {
    align-items: flex-start;
    padding: var(--pl-space-4);
  }

  .header-info p {
    display: none;
  }

  .header-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .filter-bar,
  .filter-group {
    align-items: flex-start;
  }

  .filter-group {
    width: 100%;
  }

  .filter-chips {
    padding-bottom: 2px;
  }

  .filter-search {
    flex: 1;
  }
}

@media (max-width: 500px) {
  .page-header {
    flex-direction: column;
    gap: var(--pl-space-3);
  }

  .header-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .filter-search {
    width: 100%;
    flex-basis: 100%;
  }

  .filter-feedback {
    margin-left: 0;
    align-items: flex-start;
  }

  .batch-bar {
    gap: var(--pl-space-3);
  }
}

@media (prefers-reduced-motion: reduce) {
  .filter-chip,
  .action-btn,
  .slide-fade-enter-active,
  .slide-fade-leave-active {
    transition: none;
  }

  .status-badge.running .status-dot {
    animation: none;
  }
}
</style>
