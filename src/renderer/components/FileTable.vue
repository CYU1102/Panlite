<template>
  <div class="file-table-wrapper">
    <el-table
      :data="files"
      style="width: 100%; height: 100%"
      :header-cell-style="headerStyle"
      :row-style="{ height: '52px' }"
      :cell-style="{ padding: '0' }"
      :row-class-name="rowClassName"
      @selection-change="onSelectionChange"
      @row-dblclick="onRowDblClick"
      row-key="id"
      v-loading="loading"
      element-loading-background="rgba(255,255,255,0.8)"
    >
      <el-table-column type="selection" width="48" align="center" />

      <el-table-column label="文件名" min-width="340">
        <template #default="{ row }">
          <div class="file-name-cell">
            <div class="file-icon" :class="row.isDir ? 'folder' : 'file'">
              <FolderOpen v-if="row.isDir" :size="20" :stroke-width="1.5" />
              <File v-else :size="20" :stroke-width="1.5" />
            </div>
            <span class="file-name">{{ row.name }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="大小" width="100" align="right">
        <template #default="{ row }">
          <span class="cell-muted">{{ row.isDir ? '-' : formatFileSize(row.size) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="类型" width="90" align="center">
        <template #default="{ row }">
          <span class="type-badge" :class="row.isDir ? 'folder-badge' : 'file-badge'">
            {{ row.isDir ? '文件夹' : getFileExtension(row.name) }}
          </span>
        </template>
      </el-table-column>

      <el-table-column label="创建时间" width="160" align="center">
        <template #default="{ row }">
          <span class="cell-muted">{{ formatTimestamp(row.createdAt) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="修改时间" width="160" align="center">
        <template #default="{ row }">
          <span class="cell-muted">{{ formatTimestamp(row.updatedAt) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="236" align="center" fixed="right">
        <template #default="{ row }">
          <div class="action-btns">
            <button v-if="!row.isDir" class="action-btn" title="预览" aria-label="预览" @click.stop="onPreview(row)">
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
          <strong>此文件夹为空</strong>
          <p>上传文件或新建文件夹后，内容会显示在这里</p>
        </div>
      </template>
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { FolderOpen, File, PenSquare, Trash2, Copy, Archive, FolderArchive, Eye } from 'lucide-vue-next'
import { ref } from 'vue'
import type { FileItem } from '@shared/types'
import type { PlatformCapabilities } from '@shared/capabilities'
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

const props = defineProps<{
  files: FileItem[]
  loading?: boolean
  capabilities: PlatformCapabilities
}>()

const selectedIds = ref(new Set<string>())

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

const headerStyle = {
  background: '#f7f9fc',
  color: '#667085',
  fontWeight: '600',
  fontSize: '12px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  borderBottom: '1px solid #e5e7eb',
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
}

function onRename(row: FileItem) { emit('rename', row) }
function onDelete(row: FileItem) { emit('delete', row) }
function onCopy(row: FileItem) { emit('copy', row) }
function onArchive(row: FileItem) { emit('archive', row) }
function onCompress(row: FileItem) { emit('compress', row) }
function onPreview(row: FileItem) { emit('preview', row) }
function onSelectionChange(rows: FileItem[]) {
  selectedIds.value = new Set(rows.map(row => row.id))
  // 转为纯对象，避免 Vue 响应式包装导致 IPC 克隆失败
  emit('selectionChange', JSON.parse(JSON.stringify(rows)))
}

function rowClassName({ row }: { row: FileItem }): string {
  return selectedIds.value.has(row.id) ? 'is-selected-row' : ''
}
</script>

<style scoped>
.file-table-wrapper {
  height: 100%;
  background: var(--pl-surface);
}

/* ── Table overrides ── */
:deep(.el-table) {
  --el-table-border-color: var(--pl-border);
  --el-table-row-hover-bg-color: #f5f8ff;
  --el-table-current-row-bg-color: var(--pl-primary-soft);
}

:deep(.el-table th.el-table__cell) {
  background: #f7f9fc !important;
}

:deep(.el-table td.el-table__cell) {
  border-bottom: 1px solid #eef2f7;
  transition: background-color 0.18s ease;
}

:deep(.el-table--enable-row-hover .el-table__body tr:hover > td) {
  background: #f5f8ff;
}

:deep(.el-table__body tr.is-selected-row > td.el-table__cell) {
  background: var(--pl-primary-soft) !important;
}

:deep(.el-table__body tr.is-selected-row > td:first-child) {
  box-shadow: inset 3px 0 0 var(--pl-primary);
}

:deep(.el-table .el-table__cell.gutter) {
  background: #f9fafb;
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
  font-size: 11px;
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
  border: 1px solid #d7e5ff;
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
</style>
