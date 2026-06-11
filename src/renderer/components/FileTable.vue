<template>
  <div class="file-table-wrapper">
    <el-table
      :data="files"
      style="width: 100%; height: 100%"
      :header-cell-style="headerStyle"
      :row-style="{ height: '52px' }"
      :cell-style="{ padding: '0' }"
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

      <el-table-column label="操作" width="220" align="center" fixed="right">
        <template #default="{ row }">
          <div class="action-btns">
            <button v-if="isSupportedArchive(row.name)" class="action-btn" title="浏览压缩包" @click.stop="onArchive(row)">
              <Archive :size="14" />
            </button>
            <button v-else-if="isArchiveFile(row.name)" class="action-btn" title="暂不支持此格式" disabled>
              <Archive :size="14" />
            </button>
            <button v-if="!isArchiveFile(row.name)" class="action-btn" title="压缩" @click.stop="onCompress(row)">
              <FolderArchive :size="14" />
            </button>
            <button class="action-btn" title="复制" @click.stop="onCopy(row)">
              <Copy :size="14" />
            </button>
            <button class="action-btn" title="重命名" @click.stop="onRename(row)">
              <PenSquare :size="14" />
            </button>
            <button class="action-btn danger" title="删除" @click.stop="onDelete(row)">
              <Trash2 :size="14" />
            </button>
          </div>
        </template>
      </el-table-column>

      <template #empty>
        <div class="table-empty">
          <FolderOpen :size="40" :stroke-width="1" />
          <p>此文件夹为空</p>
        </div>
      </template>
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { FolderOpen, File, PenSquare, Trash2, Copy, Archive, FolderArchive } from 'lucide-vue-next'
import type { FileItem } from '@shared/types'
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

defineProps<{
  files: FileItem[]
  loading?: boolean
}>()

const emit = defineEmits<{
  enter: [file: FileItem]
  rename: [file: FileItem]
  delete: [file: FileItem]
  copy: [file: FileItem]
  archive: [file: FileItem]
  compress: [file: FileItem]
  selectionChange: [files: FileItem[]]
}>()

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

function getFileExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx === -1) return '文件'
  return name.substring(idx + 1).toUpperCase()
}

function onRowDblClick(row: FileItem) {
  if (row.isDir) emit('enter', row)
}

function onRename(row: FileItem) { emit('rename', row) }
function onDelete(row: FileItem) { emit('delete', row) }
function onCopy(row: FileItem) { emit('copy', row) }
function onArchive(row: FileItem) { emit('archive', row) }
function onCompress(row: FileItem) { emit('compress', row) }
function onSelectionChange(rows: FileItem[]) {
  // 转为纯对象，避免 Vue 响应式包装导致 IPC 克隆失败
  emit('selectionChange', JSON.parse(JSON.stringify(rows)))
}
</script>

<style scoped>
.file-table-wrapper {
  height: 100%;
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

:deep(.el-table--enable-row-hover .el-table__body tr:hover > td) {
  background: #f9fafb;
}

:deep(.el-table .el-table__cell.gutter) {
  background: #f9fafb;
}

/* ── File name cell ── */
.file-name-cell {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  cursor: pointer;
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
}

.file-icon.folder {
  background: #eff6ff;
  color: #3b82f6;
}

.file-icon.file {
  background: #f3f4f6;
  color: #9ca3af;
}

.file-name {
  font-size: 13px;
  color: #1f2937;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

.file-name-cell:hover .file-name {
  color: #3b82f6;
}

/* ── Cells ── */
.cell-muted {
  font-size: 12px;
  color: #9ca3af;
}

.type-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
}

.folder-badge {
  background: #eff6ff;
  color: #3b82f6;
}

.file-badge {
  background: #f3f4f6;
  color: #6b7280;
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
</style>
