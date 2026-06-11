<template>
  <div class="transfer-records">
    <div class="page-header">
      <div class="header-info">
        <div class="header-icon">
          <ArrowDownToLine :size="20" :stroke-width="1.5" />
        </div>
        <div>
          <h2>转存记录</h2>
          <p>查看和管理历史转存记录</p>
        </div>
      </div>
      <div class="header-actions">
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
      <div class="filter-chips">
        <button
          v-for="f in platformFilters"
          :key="f.value"
          class="filter-chip"
          :class="{ active: filters.platform === f.value }"
          @click="filters.platform = f.value; loadData()"
        >
          {{ f.label }}
        </button>
      </div>
      <div class="filter-chips">
        <button
          v-for="f in statusFilters"
          :key="f.value"
          class="filter-chip"
          :class="{ active: filters.status === f.value }"
          @click="filters.status = f.value; loadData()"
        >
          {{ f.label }}
        </button>
      </div>
      <el-input
        v-model="filters.keyword"
        placeholder="搜索链接 / 路径 / 错误"
        clearable
        size="small"
        style="width: 200px"
        @clear="loadData()"
        @keyup.enter="loadData()"
      >
        <template #prefix>
          <Search :size="14" />
        </template>
      </el-input>
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
            <span class="cell-muted">{{ row.saved_count }}</span>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="80" align="center">
          <template #default="{ row }">
            <span class="status-badge" :class="row.status">{{ statusLabel(row.status) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="错误原因" min-width="160">
          <template #default="{ row }">
            <span class="cell-error" :title="row.error_message">{{ row.error_message || '-' }}</span>
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

        <el-table-column label="操作" width="80" align="center" fixed="right">
          <template #default="{ row }">
            <div class="action-btns">
              <button class="action-btn" title="复制来源链接" @click="onCopy(row)">
                <Copy :size="14" />
              </button>
              <button
                v-if="row.error_message"
                class="action-btn"
                title="查看错误"
                @click="onViewError(row)"
              >
                <AlertCircle :size="14" />
              </button>
              <button class="action-btn danger" title="删除" @click="onDelete(row)">
                <Trash2 :size="14" />
              </button>
            </div>
          </template>
        </el-table-column>

        <template #empty>
          <div class="table-empty">
            <ArrowDownToLine :size="40" :stroke-width="1" />
            <p>暂无转存记录</p>
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
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDownToLine, Download, RefreshCw, Search, Copy, AlertCircle, Trash2, CheckCircle2 } from 'lucide-vue-next'
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
  background: '#f9fafb',
  color: '#6b7280',
  fontWeight: '600',
  fontSize: '12px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  borderBottom: '1px solid #e5e7eb',
  height: '44px',
}

function statusLabel(status: string): string {
  const map: Record<string, string> = { success: '成功', failed: '失败', running: '执行中', pending: '等待中' }
  return map[status] || status
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
  gap: 12px;
}

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
  background: #faf5ff;
  color: #a855f7;
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
  gap: 8px;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
  flex-wrap: wrap;
}

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

.table-card {
  flex: 1;
  overflow: auto;
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
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
</style>
