<template>
  <div class="file-table-wrapper" :class="`density-${density}`">
    <el-table
      :data="displayedFiles"
      :default-sort="sortState || undefined"
      style="width: 100%; flex: 1; min-height: 0"
      height="100%"
      :aria-describedby="selectionDescriptionId"
      :header-cell-style="headerStyle"
      :row-style="{ height: density === 'compact' ? '40px' : '52px' }"
      :cell-style="{ padding: '0' }"
      :row-class-name="rowClassName"
      @row-dblclick="onRowDblClick"
      @sort-change="onSortChange"
      @header-dragend="onColumnResize"
      row-key="id"
      v-loading="loading"
      element-loading-background="var(--pl-surface)"
    >
      <el-table-column width="48" align="center" column-key="selection" :resizable="false" label="仅选择本页">
        <template #header>
          <el-checkbox :model-value="allPageSelected" :indeterminate="somePageSelected && !allPageSelected" :disabled="loading || !displayedFiles.length" aria-label="仅选择本页文件" title="仅选择本页文件，其他页选择保留" @change="toggleCurrentPage" />
        </template>
        <template #default="{ row }">
          <el-checkbox :model-value="selectedRows.has(row.id)" :disabled="loading" :aria-label="`选择文件：${row.name}`" @change="(checked: unknown) => toggleFile(row, checked)" @click.stop />
        </template>
      </el-table-column>

      <el-table-column label="文件名" prop="name" column-key="name" sortable="custom" :width="columnWidths.name" :min-width="columnWidths.name ? 180 : 260">
        <template #default="{ row }">
          <div class="file-name-cell">
            <div class="file-icon" :class="row.isDir ? 'folder' : 'file'">
              <FolderOpen v-if="row.isDir" :size="20" :stroke-width="1.5" />
              <File v-else :size="20" :stroke-width="1.5" />
            </div>
            <button v-if="row.isDir || canPreview(row)" class="file-name file-name-open" :title="row.name" :aria-label="`${row.isDir ? '打开文件夹' : previewTitle(row)}：${row.name}`" @click.stop="onRowDblClick(row)" @dblclick.stop>{{ row.name }}</button>
            <span v-else class="file-name" :title="row.name">{{ row.name }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="大小" prop="size" column-key="size" sortable="custom" :width="columnWidths.size || 100" align="right">
        <template #default="{ row }">
          <span class="cell-muted">{{ row.isDir ? '-' : formatFileSize(row.size) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="类型" column-key="type" :width="columnWidths.type || 90" align="center">
        <template #default="{ row }">
          <span class="type-badge" :class="row.isDir ? 'folder-badge' : 'file-badge'">
            {{ row.isDir ? '文件夹' : getFileExtension(row.name) }}
          </span>
        </template>
      </el-table-column>

      <el-table-column label="创建时间" prop="createdAt" column-key="createdAt" sortable="custom" :width="columnWidths.createdAt || 150" align="center">
        <template #default="{ row }">
          <span class="cell-muted">{{ formatTimestamp(row.createdAt) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="修改时间" prop="updatedAt" column-key="updatedAt" sortable="custom" :width="columnWidths.updatedAt || 150" align="center">
        <template #default="{ row }">
          <span class="cell-muted">{{ formatTimestamp(row.updatedAt) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="236" align="center" fixed="right">
        <template #default="{ row }">
          <div class="action-btns">
            <button v-if="!row.isDir" class="action-btn" :title="previewTitle(row)" :aria-label="previewTitle(row)" :disabled="!canPreview(row)" @click.stop="onPreview(row)">
              <Eye :size="14" />
            </button>
            <button
              v-if="isSupportedArchive(row.name)"
              class="action-btn"
              :title="capabilities.browseArchive ? '浏览压缩包' : '当前网盘暂不支持浏览压缩包'"
              :aria-label="capabilities.browseArchive ? '浏览压缩包' : '当前网盘暂不支持浏览压缩包'"
              :disabled="!capabilities.browseArchive"
              @click.stop="onArchive(row)"
            >
              <Archive :size="14" />
            </button>
            <button v-else-if="isArchiveFile(row.name)" class="action-btn" title="暂不支持此格式" aria-label="暂不支持此格式" disabled>
              <Archive :size="14" />
            </button>
            <button
              v-if="!isArchiveFile(row.name)"
              class="action-btn"
              :title="compressTitle(row)"
              :aria-label="compressTitle(row)"
              :disabled="!canCompress(row)"
              @click.stop="onCompress(row)"
            >
              <FolderArchive :size="14" />
            </button>
            <button
              class="action-btn"
              :title="capabilities.copy ? '复制' : '当前网盘暂不支持服务端复制'"
              :aria-label="capabilities.copy ? '复制' : '当前网盘暂不支持服务端复制'"
              :disabled="!capabilities.copy"
              @click.stop="onCopy(row)"
            >
              <Copy :size="14" />
            </button>
            <button
              class="action-btn"
              :title="capabilities.rename ? '重命名' : '当前网盘暂不支持重命名'"
              :aria-label="capabilities.rename ? '重命名' : '当前网盘暂不支持重命名'"
              :disabled="!capabilities.rename"
              @click.stop="onRename(row)"
            >
              <PenSquare :size="14" />
            </button>
            <button
              class="action-btn danger"
              :title="capabilities.delete ? '删除' : '当前网盘暂不支持删除'"
              :aria-label="capabilities.delete ? '删除' : '当前网盘暂不支持删除'"
              :disabled="!capabilities.delete"
              @click.stop="onDelete(row)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </template>
      </el-table-column>

      <template #empty>
        <div class="table-empty">
          <span class="empty-illustration">
            <FolderOpen :size="34" :stroke-width="1.35" />
          </span>
          <strong>{{ emptyTitle }}</strong>
          <p>{{ emptyDescription }}</p>
        </div>
      </template>
    </el-table>
    <div class="file-table-pagination">
      <div :id="selectionDescriptionId" class="page-selection-scope">
        <span>表头勾选仅选本页 · 已选 {{ selectedRows.size }} 项（跨页保留）</span>
        <button type="button" :disabled="loading || !files.length || selectedRows.size === files.length" @click="selectAllFiles">选择全部 {{ files.length }} 项</button>
        <button type="button" :disabled="loading || !selectedRows.size" @click="clearSelectedFiles">清空选择</button>
      </div>
      <nav class="file-page-controls" aria-label="文件列表分页">
        <span class="page-range" role="status">显示 {{ pageStart }}–{{ pageEnd }} / 共 {{ files.length }} 项</span>
        <label class="page-size-label">每页
          <select :value="pageSize" aria-label="每页文件数量" :disabled="loading" @change="onPageSizeChange"><option :value="100">100</option><option :value="200">200</option></select>
        </label>
        <button type="button" aria-label="文件首页" :disabled="loading || currentPage <= 1" @click="goToPage(1)">首页</button>
        <button type="button" aria-label="文件上一页" :disabled="loading || currentPage <= 1" @click="goToPage(currentPage - 1)">上一页</button>
        <label class="page-number-label">第 <input :value="currentPage" aria-label="文件页码" type="number" min="1" :max="pageCount" :disabled="loading" @change="onPageInput" /> / {{ pageCount }} 页</label>
        <button type="button" aria-label="文件下一页" :disabled="loading || currentPage >= pageCount" @click="goToPage(currentPage + 1)">下一页</button>
        <button type="button" aria-label="文件末页" :disabled="loading || currentPage >= pageCount" @click="goToPage(pageCount)">末页</button>
      </nav>
    </div>
  </div>
</template>

<script setup lang="ts">
import { FolderOpen, File, PenSquare, Trash2, Copy, Archive, FolderArchive, Eye } from 'lucide-vue-next'
import { computed, ref, shallowRef, useId, watch } from 'vue'
import type { FileItem } from '@shared/types'
import type { PlatformCapabilities } from '@shared/capabilities'
import { detectFilePreviewType } from '@shared/file-preview'
import { formatFileSize, formatTimestamp } from '@shared/utils'

// 支持的压缩包格式
const SUPPORTED_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz'])
// 所有压缩包格式
const ALL_ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'iso'])

function isArchiveFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return ALL_ARCHIVE_EXTENSIONS.has(ext)
}

function isSupportedArchive(filename: string): boolean {
  const lower = filename.toLowerCase()
  // 处理复合扩展名
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return true
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return SUPPORTED_EXTENSIONS.has(ext)
}

const props = withDefaults(defineProps<{
  files: FileItem[]
  loading?: boolean
  capabilities: PlatformCapabilities
  density?: 'comfortable' | 'compact'
  emptyTitle?: string
  emptyDescription?: string
  selectedFiles?: FileItem[]
  selectionContext?: string
}>(), { density: 'comfortable', emptyTitle: '此文件夹为空', emptyDescription: '上传文件或新建文件夹后，内容会显示在这里' })

const emit = defineEmits<{
  enter: [file: FileItem]
  rename: [file: FileItem]
  delete: [file: FileItem]
  copy: [file: FileItem]
  archive: [file: FileItem]
  compress: [file: FileItem]
  preview: [file: FileItem]
  selectionChange: [files: FileItem[]]
}>()

const selectedRows = shallowRef(new Map<string, FileItem>())
const selectionDescriptionId = useId()
const currentPage = ref(1)
const pageSize = ref(100)
const fileIndex = computed(() => new Map(props.files.map(file => [file.id, file])))

type SortColumn = 'name' | 'size' | 'createdAt' | 'updatedAt'
type ResizableColumn = SortColumn | 'type'
type SortState = { prop: SortColumn; order: 'ascending' | 'descending' }
const layoutStorageKey = 'panlite:file-table-layout:v1'
const sortColumns: SortColumn[] = ['name', 'size', 'createdAt', 'updatedAt']
const minimumWidths: Record<ResizableColumn, number> = { name: 180, size: 80, type: 70, createdAt: 120, updatedAt: 120 }
function readLayout(): { sort: SortState | null; widths: Partial<Record<ResizableColumn, number>> } {
  const layout: { sort: SortState | null; widths: Partial<Record<ResizableColumn, number>> } = { sort: null, widths: {} }
  try {
    const saved = JSON.parse(localStorage.getItem(layoutStorageKey) || 'null')
    if (!saved || typeof saved !== 'object') return layout
    if (sortColumns.includes(saved.sort?.prop) && ['ascending', 'descending'].includes(saved.sort?.order)) layout.sort = { prop: saved.sort.prop, order: saved.sort.order }
    if (saved.widths && typeof saved.widths === 'object') {
      for (const column of Object.keys(minimumWidths) as ResizableColumn[]) {
        const width = saved.widths[column]
        if (typeof width === 'number' && Number.isFinite(width) && width >= minimumWidths[column] && width <= 600) layout.widths[column] = Math.round(width)
      }
    }
  } catch { /* 无效或不可用的本地存储不影响文件列表 */ }
  return layout
}
const initialLayout = readLayout()
const sortState = ref<SortState | null>(initialLayout.sort)
const columnWidths = ref(initialLayout.widths)
const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const sortedFiles = computed(() => {
  const sort = sortState.value
  if (!sort) return props.files
  return [...props.files].sort((left, right) => {
    // Keep directories together even when descending, without mutating provider data.
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1
    const difference = sort.prop === 'name'
      ? nameCollator.compare(left.name, right.name)
      : (Number(left[sort.prop]) || 0) - (Number(right[sort.prop]) || 0)
    return sort.order === 'descending' ? -difference : difference
  })
})
const pageCount = computed(() => Math.max(1, Math.ceil(sortedFiles.value.length / pageSize.value)))
const displayedFiles = computed(() => sortedFiles.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value))
const pageStart = computed(() => displayedFiles.value.length ? (currentPage.value - 1) * pageSize.value + 1 : 0)
const pageEnd = computed(() => Math.min(currentPage.value * pageSize.value, sortedFiles.value.length))
const somePageSelected = computed(() => displayedFiles.value.some(row => selectedRows.value.has(row.id)))
const allPageSelected = computed(() => displayedFiles.value.length > 0 && displayedFiles.value.every(row => selectedRows.value.has(row.id)))

function goToPage(page: number): void {
  currentPage.value = Math.min(pageCount.value, Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1))
}
function onPageInput(event: Event): void {
  const input = event.target as HTMLInputElement
  goToPage(Number(input.value))
  input.value = String(currentPage.value)
}
function onPageSizeChange(event: Event): void {
  pageSize.value = Number((event.target as HTMLSelectElement).value) === 200 ? 200 : 100
  currentPage.value = 1
}
watch(pageCount, () => goToPage(currentPage.value))

// The selection column uses controlled checkboxes. Replacing the displayed
// page must never let the table's internal selection store clear other pages.
watch([fileIndex, () => props.selectedFiles, () => props.selectionContext], ([index, requested, context], previous) => {
  const contextChanged = previous.length > 0 && context !== previous[2]
  if (contextChanged) {
    currentPage.value = 1
    const hadSelection = selectedRows.value.size > 0
    selectedRows.value = new Map()
    if (hadSelection) emitSelection()
    return
  }
  const wanted = requested || [...selectedRows.value.values()]
  const next = new Map<string, FileItem>()
  for (const row of wanted) {
    const canonical = index.get(row.id)
    if (canonical && canonical.accountId === row.accountId) next.set(canonical.id, canonical)
  }
  selectedRows.value = next
  if (next.size !== wanted.length) emitSelection()
  // Refreshes may empty the listing before new data arrives.
  if (!index.size) currentPage.value = 1
}, { immediate: true })
watch([sortState, columnWidths], () => {
  try { localStorage.setItem(layoutStorageKey, JSON.stringify({ sort: sortState.value, widths: columnWidths.value })) } catch { /* 当前会话仍可使用排序和列宽 */ }
}, { deep: true })
function onSortChange(input: { prop?: string; order?: string | null }): void {
  currentPage.value = 1
  sortState.value = sortColumns.includes(input.prop as SortColumn) && ['ascending', 'descending'].includes(input.order || '')
    ? { prop: input.prop as SortColumn, order: input.order as SortState['order'] }
    : null
}
function onColumnResize(width: number, _oldWidth: number, column: { columnKey?: string; property?: string }): void {
  const key = column.columnKey || column.property
  if (!key || !Object.prototype.hasOwnProperty.call(minimumWidths, key) || !Number.isFinite(width)) return
  const columnKey = key as ResizableColumn
  columnWidths.value = { ...columnWidths.value, [columnKey]: Math.round(Math.max(minimumWidths[columnKey], Math.min(600, width))) }
}

const headerStyle = {
  background: 'var(--pl-surface-subtle)',
  color: 'var(--pl-text-secondary)',
  fontWeight: '600',
  fontSize: '12px',
  borderBottom: '1px solid var(--pl-border)',
  height: '44px',
}

function getFileExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx === -1) return '文件'
  return name.substring(idx + 1).toUpperCase()
}

function canCompress(file: FileItem): boolean {
  if (!props.capabilities.createArchive) return false
  return !file.isDir || props.capabilities.createArchiveFromFolder
}

function compressTitle(file: FileItem): string {
  if (!props.capabilities.createArchive) return '当前网盘暂不支持创建压缩包'
  if (file.isDir && !props.capabilities.createArchiveFromFolder) return '暂不支持直接压缩网盘文件夹'
  return '创建压缩包'
}

function onRowDblClick(row: FileItem) {
  if (row.isDir) emit('enter', row)
  else onPreview(row)
}

function canPreview(row: FileItem): boolean {
  return !row.isDir && props.capabilities.downloadFile && detectFilePreviewType(row.name).supported
}

function previewTitle(row: FileItem): string {
  if (!props.capabilities.downloadFile) return '当前网盘暂不支持文件预览'
  if (!detectFilePreviewType(row.name).supported) return '暂不支持此文件格式的预览'
  return ['video', 'audio'].includes(detectFilePreviewType(row.name).kind) ? '在线播放' : '在线预览'
}

function onRename(row: FileItem) { emit('rename', row) }
function onDelete(row: FileItem) { emit('delete', row) }
function onCopy(row: FileItem) { emit('copy', row) }
function onArchive(row: FileItem) { emit('archive', row) }
function onCompress(row: FileItem) { emit('compress', row) }
function onPreview(row: FileItem) { if (canPreview(row)) emit('preview', row) }
function emitSelection(): void {
  // 转为纯对象，避免 Vue 响应式包装导致 IPC 克隆失败
  emit('selectionChange', JSON.parse(JSON.stringify([...selectedRows.value.values()])))
}
function onPageSelectionChange(rows: FileItem[]): void {
  if (props.loading) return
  const next = new Map(selectedRows.value)
  for (const row of displayedFiles.value) next.delete(row.id)
  const visibleIds = new Set(displayedFiles.value.map(row => row.id))
  for (const row of rows) {
    const canonical = fileIndex.value.get(row.id)
    if (visibleIds.has(row.id) && canonical && canonical.accountId === row.accountId) next.set(canonical.id, canonical)
  }
  selectedRows.value = next
  emitSelection()
}
function toggleCurrentPage(checked: unknown): void {
  onPageSelectionChange(checked === true ? displayedFiles.value : [])
}
function toggleFile(row: FileItem, checked: unknown): void {
  if (props.loading) return
  const canonical = fileIndex.value.get(row.id)
  if (!canonical || canonical.accountId !== row.accountId) return
  const next = new Map(selectedRows.value)
  if (checked === true) next.set(canonical.id, canonical)
  else next.delete(canonical.id)
  selectedRows.value = next
  emitSelection()
}
function selectAllFiles(): void {
  if (props.loading) return
  selectedRows.value = new Map(fileIndex.value)
  emitSelection()
}
function clearSelectedFiles(): void {
  if (props.loading) return
  selectedRows.value = new Map()
  emitSelection()
}

function rowClassName({ row }: { row: FileItem }): string {
  return selectedRows.value.has(row.id) ? 'is-selected-row' : ''
}
</script>

<style scoped>
.file-table-wrapper {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--pl-surface);
}
.file-table-pagination { flex: 0 0 auto; padding: 9px 12px; border-top: 1px solid var(--pl-border); color: var(--pl-text-secondary); font-size: 12px; }
.page-selection-scope, .file-page-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.page-selection-scope { margin-bottom: 8px; }
.file-table-pagination button, .file-table-pagination select, .file-table-pagination input { border: 1px solid var(--pl-border); border-radius: 6px; color: var(--pl-text-secondary); background: var(--pl-surface); min-height: 28px; font: inherit; }
.file-table-pagination button { padding: 3px 8px; cursor: pointer; }
.file-table-pagination button:hover:not(:disabled) { color: var(--pl-primary); border-color: var(--pl-primary); background: var(--pl-primary-soft); }
.file-table-pagination button:disabled { opacity: 0.45; cursor: not-allowed; }
.file-table-pagination input { width: 62px; padding: 2px 6px; }
.file-table-pagination select { padding: 2px 5px; }
.file-table-pagination :is(button, select, input):focus-visible { outline: 2px solid var(--pl-primary); outline-offset: 2px; }
.page-number-label, .page-size-label { display: inline-flex; align-items: center; gap: 5px; }
.page-range { margin-right: auto; }

/* ── Table overrides ── */
:deep(.el-table) {
  --el-table-border-color: var(--pl-border);
  --el-table-row-hover-bg-color: var(--pl-hover);
  --el-table-current-row-bg-color: var(--pl-primary-soft);
}

:deep(.el-table th.el-table__cell) {
  background: var(--pl-surface-subtle) !important;
}

:deep(.el-table td.el-table__cell) {
  border-bottom: 1px solid var(--pl-border);
  transition: background-color 0.18s ease;
}

:deep(.el-table--enable-row-hover .el-table__body tr:hover > td) {
  background: var(--pl-hover);
}

:deep(.el-table__body tr.is-selected-row > td.el-table__cell) {
  background: var(--pl-primary-soft) !important;
}

:deep(.el-table__body tr.is-selected-row > td:first-child) {
  box-shadow: inset 3px 0 0 var(--pl-primary);
}

:deep(.el-table .el-table__cell.gutter) {
  background: var(--pl-surface-subtle);
}

/* ── File name cell ── */
.file-name-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  cursor: default;
  height: 52px;
}

.file-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: transform 0.18s ease, background-color 0.18s ease, color 0.18s ease;
}

.file-icon.folder {
  background: var(--pl-primary-soft);
  color: var(--pl-primary);
}

.file-icon.file {
  background: var(--pl-surface-subtle);
  color: var(--pl-text-muted);
  border: 1px solid var(--pl-border);
}

.file-name {
  font-size: 13px;
  color: var(--pl-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

.file-name-cell:hover .file-name {
  color: var(--pl-primary-hover);
}

:deep(.el-table__body tr:hover) .file-icon {
  transform: translateY(-1px) scale(1.03);
}

/* ── Cells ── */
.cell-muted {
  font-size: 12px;
  color: var(--pl-text-muted);
}

.type-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: var(--pl-font-xs);
  font-weight: 500;
}

.folder-badge {
  background: var(--pl-primary-soft);
  color: var(--pl-primary);
}

.file-badge {
  background: var(--pl-surface-subtle);
  color: var(--pl-text-secondary);
  border: 1px solid var(--pl-border);
}

/* ── Action buttons ── */
.action-btns {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  opacity: 0;
  transform: translateX(6px);
  transition: opacity 0.16s ease, transform 0.16s ease;
}

:deep(.el-table__body tr:hover) .action-btns,
:deep(.el-table__body tr.is-selected-row) .action-btns,
.action-btns:focus-within {
  opacity: 1;
  transform: translateX(0);
}

.action-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: 8px;
  color: var(--pl-text-secondary);
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease, transform 0.15s ease;
}

.action-btn:hover {
  background: var(--pl-primary-soft);
  color: var(--pl-primary-hover);
  transform: translateY(-1px);
}

.action-btn:active:not(:disabled) {
  transform: translateY(0) scale(0.94);
}

.action-btn:disabled {
  opacity: 0.34;
  cursor: not-allowed;
}

.action-btn:disabled:hover {
  background: transparent;
  color: var(--pl-text-muted);
}

.action-btn.danger:hover {
  background: var(--pl-danger-soft);
  color: var(--pl-danger);
}

/* ── Empty state ── */
.table-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 58px 0;
  color: var(--pl-text-muted);
}

.empty-illustration {
  width: 72px;
  height: 72px;
  display: grid;
  place-items: center;
  margin-bottom: 6px;
  color: var(--pl-primary);
  background: var(--pl-primary-soft);
  border: 1px solid var(--pl-border-strong);
  border-radius: 22px;
}

.table-empty strong {
  color: var(--pl-text);
  font-size: 14px;
  font-weight: 650;
}

.table-empty p {
  margin: 0;
  font-size: 13px;
  color: var(--pl-text-muted);
}

.file-name-open { border: 0; background: transparent; padding: 5px 0; text-align: left; cursor: pointer; font-family: inherit; }
.file-name-open:focus-visible, .action-btn:focus-visible { outline: 2px solid var(--pl-primary); outline-offset: 2px; }
.action-btns { opacity: 0.6; transform: none; }
.density-compact .file-name-cell { height: 40px; gap: 8px; }
.density-compact .file-icon { width: 28px; height: 28px; border-radius: 7px; }
.density-compact .file-icon :deep(svg) { width: 17px; height: 17px; }
.density-compact .action-btn { width: 28px; height: 28px; }
:deep(.el-table__header-wrapper) { position: sticky; top: 0; z-index: 2; }
.table-empty { padding: 40px 12px; }
</style>
