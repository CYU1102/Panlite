<template>
  <div class="share-links">
    <div class="page-header">
      <div class="header-info">
        <div class="header-icon">
          <Share2 :size="20" :stroke-width="1.5" />
        </div>
        <div>
          <h2>分享链接</h2>
          <p>集中复制、打开和维护已创建的分享链接</p>
        </div>
      </div>
      <div class="header-actions">
        <el-button size="small" type="primary" @click="$router.push('/batch-share')">
          <Plus :size="14" style="margin-right: 4px" />
          创建分享
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
            <span v-if="f.count > 0" class="chip-count">{{ f.count }}</span>
          </button>
        </div>
      </div>
      <div class="filter-search">
        <el-input
          v-model="filters.keyword"
          placeholder="搜索标题 / 链接"
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
        <span>{{ hasActiveFilters ? `筛选到 ${links.length} 条` : `共 ${links.length} 条` }}</span>
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
        :data="links"
        style="width: 100%"
        :header-cell-style="headerStyle"
        :row-style="{ height: '52px' }"
        :row-class-name="rowClassName"
        empty-text="暂无分享记录"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="48" align="center" />
        <el-table-column label="平台" width="90" align="center">
          <template #default="{ row }">
            <span class="platform-badge" :class="row.platform">{{ PLATFORM_LABELS[row.platform] || row.platform }}</span>
          </template>
        </el-table-column>

        <el-table-column label="标题" min-width="180">
          <template #default="{ row }">
            <span class="cell-main">{{ row.title || '-' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="分享链接" min-width="220">
          <template #default="{ row }">
            <span class="cell-link">{{ row.share_url }}</span>
          </template>
        </el-table-column>

        <el-table-column label="提取码" width="80" align="center">
          <template #default="{ row }">
            <span class="cell-muted">{{ row.password || '-' }}</span>
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

        <el-table-column label="创建时间" width="140" align="center">
          <template #default="{ row }">
            <span class="cell-muted">{{ formatTimestamp(row.created_at) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="260" align="center" fixed="right">
          <template #default="{ row }">
            <div class="action-btns">
              <button class="action-btn action-primary" title="复制链接和提取码" :aria-label="`复制 ${row.title || '分享记录'} 的链接和提取码`" @click="onCopy(row, true)">
                <Copy :size="14" />
                <span>复制全部</span>
              </button>
              <button class="action-btn" title="仅复制链接" :aria-label="`仅复制 ${row.title || '分享记录'} 的链接`" @click="onCopy(row, false)">
                <Link :size="14" />
                <span>仅链接</span>
              </button>
              <button class="action-btn" title="在浏览器中打开链接" :aria-label="`打开 ${row.title || '分享记录'} 的链接`" @click="onOpen(row)">
                <ExternalLink :size="14" />
                <span>打开</span>
              </button>
              <span class="action-divider" aria-hidden="true"></span>
              <button class="action-btn action-icon danger" title="删除记录" :aria-label="`删除 ${row.title || '分享记录'}`" @click="onDelete(row)">
                <Trash2 :size="14" />
              </button>
            </div>
          </template>
        </el-table-column>

        <template #empty>
          <div class="table-empty">
            <div class="empty-icon"><Share2 :size="32" :stroke-width="1.4" /></div>
            <strong>{{ hasActiveFilters ? '没有匹配的分享记录' : '还没有分享记录' }}</strong>
            <p>{{ hasActiveFilters ? '尝试调整平台、状态或搜索关键词' : '创建分享后，可在这里复制链接并管理有效期' }}</p>
            <el-button v-if="hasActiveFilters" size="small" @click="resetFilters">
              <RotateCcw :size="14" style="margin-right: 4px" />
              清除筛选
            </el-button>
            <el-button v-else size="small" type="primary" @click="$router.push('/batch-share')">
              <Plus :size="14" style="margin-right: 4px" />
              创建分享
            </el-button>
          </div>
        </template>
      </el-table>
    </div>

    <!-- Stats bar -->
    <div class="stats-bar">
      <div class="stat-chip">
        <Share2 :size="12" />
        共 {{ links.length }} 条记录
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs'
import { Share2, Download, RefreshCw, Search, Copy, Link, ExternalLink, Trash2, CheckCircle2, Plus, RotateCcw } from 'lucide-vue-next'
import { PLATFORM_LABELS } from '@shared/constants'
import { formatTimestamp } from '@shared/utils'
import { electronApi } from '../api/ipc'

interface ShareLinkRow {
  id: string
  account_id: string
  platform: string
  share_url: string
  password: string | null
  title: string | null
  file_ids: string
  expired_at: number | null
  status: string
  created_at: number
  updated_at: number
  account_nickname?: string
}

const links = ref<ShareLinkRow[]>([])
const exporting = ref(false)
const selectedRows = ref<ShareLinkRow[]>([])

function onSelectionChange(rows: ShareLinkRow[]) {
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
    const result = await electronApi.shareDelete(row.id)
    if (result.success) deletedCount++
  }

  if (deletedCount > 0) {
    const ids = new Set(selectedRows.value.map(r => r.id))
    links.value = links.value.filter(l => !ids.has(l.id))
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
  { value: 'uc', label: 'UC' },
  { value: 'xunlei', label: '迅雷' },
]

const statusFilters = [
  { value: '', label: '全部', count: 0 },
  { value: 'active', label: '有效', count: 0 },
  { value: 'expired', label: '已过期', count: 0 },
  { value: 'cancelled', label: '已取消', count: 0 },
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
  const map: Record<string, string> = { active: '有效', expired: '已过期', cancelled: '已取消', failed: '失败' }
  return map[status] || status
}

function rowClassName({ row }: { row: ShareLinkRow }): string {
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
  const result = await electronApi.shareList(f)
  if (result.success) {
    links.value = result.links as ShareLinkRow[]
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

function onCopy(row: ShareLinkRow, withPwd: boolean) {
  let text = row.share_url
  if (withPwd && row.password) {
    text += ` 提取码: ${row.password}`
  }
  copyToClipboard(text)
}

function onOpen(row: ShareLinkRow) {
  window.open(row.share_url, '_blank')
}

async function onDelete(row: ShareLinkRow) {
  try {
    await ElMessageBox.confirm('确定要删除这条分享记录吗？', '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch { return }

  const result = await electronApi.shareDelete(row.id)
  if (result.success) {
    links.value = links.value.filter((l) => l.id !== row.id)
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
    const result = await electronApi.shareExportCsv(f)
    if (result.success && result.csv) {
      const d = new Date()
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const filename = `panlite-share-links-${dateStr}.csv`
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
.share-links {
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

.platform-badge.uc {
  background: #f0f9ff;
  color: #0284c7;
}

.platform-badge.xunlei {
  background: #ede9fe;
  color: #7c3aed;
}

.cell-main {
  font-size: 13px;
  color: #1f2937;
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

.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.status-badge.active {
  background: #f0fdf4;
  color: #22c55e;
}

.status-badge.expired {
  background: #fef2f2;
  color: #ef4444;
}

.status-badge.cancelled {
  background: #f3f4f6;
  color: #6b7280;
}

.status-badge.failed {
  background: #fef2f2;
  color: #ef4444;
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

/* Interactive records workspace */
.share-links {
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

.filter-chip.active .chip-count {
  background: rgba(255, 255, 255, 0.2);
  color: #ffffff;
}

.filter-search {
  width: 210px;
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
.platform-badge.uc { background: #edf8ff; color: #1682b7; }
.platform-badge.xunlei { background: #f3efff; color: #7658d8; }

.cell-main {
  color: var(--pl-text);
  font-weight: 600;
}

.cell-link {
  color: var(--pl-text-secondary);
}

.cell-muted {
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

.status-badge.active { background: var(--pl-success-soft); color: var(--pl-success); }
.status-badge.expired,
.status-badge.failed { background: var(--pl-danger-soft); color: var(--pl-danger); }
.status-badge.cancelled { background: var(--pl-surface-subtle); color: var(--pl-text-secondary); }

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

@media (max-width: 900px) {
  .filter-search {
    width: min(260px, 100%);
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
}
</style>
