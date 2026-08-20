<template>
  <el-dialog
    :model-value="modelValue"
    width="680px"
    title="上传文件"
    class="upload-dialog"
    :close-on-click-modal="false"
    @close="onClose"
  >
    <!-- 目标信息 -->
    <div class="target-info">
      <div class="target-item">
        <span class="target-label">上传账号</span>
        <span class="target-value">{{ account?.nickname }} ({{ platformLabel }})</span>
      </div>
      <div class="target-item">
        <span class="target-label">目标目录</span>
        <span class="target-value">{{ targetDirName || '根目录' }}</span>
      </div>
    </div>

    <!-- 文件选择区域 -->
    <div class="file-select-area">
      <div class="section-heading">
        <div>
          <strong>选择内容</strong>
          <span>可同时添加文件和整个文件夹</span>
        </div>
      </div>
      <div class="select-buttons">
        <el-button type="primary" plain @click="selectFiles">
          <FolderOpen :size="16" style="margin-right: 6px" />
          选择文件
        </el-button>
        <el-button @click="selectFolder">
          <Folder :size="16" style="margin-right: 6px" />
          选择文件夹
        </el-button>
      </div>

      <!-- 拖拽区域 -->
      <div
        class="drop-zone"
        :class="{ 'drag-over': isDragOver }"
        role="button"
        tabindex="0"
        aria-label="选择或拖拽要上传的文件"
        @click="selectFiles"
        @keydown.enter="selectFiles"
        @keydown.space.prevent="selectFiles"
        @dragover.prevent="isDragOver = true"
        @dragleave="isDragOver = false"
        @drop.prevent="handleDrop"
      >
        <span class="drop-icon"><Upload :size="28" /></span>
        <p>将文件拖到这里，或<strong>点击浏览</strong></p>
        <span>支持一次选择多个文件</span>
      </div>
    </div>

    <!-- 文件列表 -->
    <div v-if="fileList.length > 0" class="file-list">
      <div class="file-list-header">
        <span>已选择 {{ fileList.length }} 个文件 ({{ formatFileSize(totalSize) }})</span>
        <el-button text type="danger" @click="clearFiles">清空</el-button>
      </div>

      <el-scrollbar max-height="300px">
        <div v-for="(file, index) in fileList" :key="index" class="file-item">
          <FileIcon :name="file.fileName" />
          <div class="file-info">
            <span class="file-name" :title="file.relativePath || file.fileName">{{ file.relativePath || file.fileName }}</span>
            <span class="file-size">{{ formatFileSize(file.fileSize) }}</span>
          </div>
          <el-button text type="danger" aria-label="移除此文件" title="移除此文件" @click="removeFile(index)">
            <X :size="14" />
          </el-button>
        </div>
      </el-scrollbar>
    </div>

    <!-- 选项 -->
    <div class="options">
      <div>
        <span class="option-label">同名文件处理</span>
        <span class="option-hint">目标目录已存在同名内容时</span>
      </div>
      <el-select v-model="conflictPolicy" style="width: 180px">
        <el-option label="自动重命名（推荐）" value="rename" />
        <el-option label="跳过" value="skip" />
        <el-option label="覆盖" value="overwrite" />
      </el-select>
    </div>

    <template #footer>
      <el-button @click="onClose">取消</el-button>
      <el-button
        type="primary"
        @click="startUpload"
        :disabled="fileList.length === 0"
        :loading="uploading"
      >
        开始上传
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, h } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { FolderOpen, Folder, Upload, X, FileText } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'
import { PLATFORM_LABELS } from '../../shared/constants'
import type { DriveAccount, FileConflictPolicy, UploadFileInfo } from '@shared/types'
import { formatFileSize } from '@shared/utils'

// Simple file icon component
const FileIcon = {
  props: ['name'],
  render() {
    return h('span', { class: 'file-icon' }, [h(FileText, { size: 17, strokeWidth: 1.7 })])
  },
}

const props = defineProps<{
  modelValue: boolean
  account: Omit<DriveAccount, 'credential'> | null
  targetDirId: string
  targetDirName: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const fileList = ref<UploadFileInfo[]>([])
const isDragOver = ref(false)
const conflictPolicy = ref<FileConflictPolicy>('rename')
const uploading = ref(false)

const platformLabel = computed(() =>
  props.account ? PLATFORM_LABELS[props.account.platform] || props.account.platform : ''
)

const totalSize = computed(() =>
  fileList.value.reduce((sum, f) => sum + f.fileSize, 0)
)

async function selectFiles() {
  try {
    const result = await electronApi.selectUploadFiles()
    if (result.success && result.files) {
      fileList.value.push(...result.files)
    }
  } catch {
    ElMessage.error('选择文件失败')
  }
}

async function selectFolder() {
  try {
    const result = await electronApi.selectUploadFolder()
    if (result.success && result.files) {
      fileList.value.push(...result.files)
      if (result.folderName) {
        ElMessage.success(`已选择文件夹: ${result.folderName} (${result.files.length} 个文件)`)
      }
    }
  } catch {
    ElMessage.error('选择文件夹失败')
  }
}

async function handleDrop(event: DragEvent) {
  isDragOver.value = false

  const files = event.dataTransfer?.files
  if (!files || files.length === 0) return

  const filePaths: string[] = []
  for (let i = 0; i < files.length; i++) {
    const filePath = electronApi.getPathForFile(files[i])
    if (filePath) {
      filePaths.push(filePath)
    }
  }

  if (filePaths.length === 0) return

  try {
    const result = await electronApi.handleDragUpload(filePaths)
    if (result.success && result.files) {
      fileList.value.push(...result.files)
      ElMessage.success(`已添加 ${result.files.length} 个文件`)
    }
  } catch {
    ElMessage.error('处理拖拽文件失败')
  }
}

function removeFile(index: number) {
  fileList.value.splice(index, 1)
}

function clearFiles() {
  fileList.value = []
}

async function startUpload() {
  if (!props.account) {
    ElMessage.error('请先选择账号')
    return
  }

  if (fileList.value.length === 0) {
    ElMessage.warning('请先选择要上传的文件')
    return
  }

  uploading.value = true
  try {
    const result = await electronApi.uploadFiles({
      accountId: props.account.id,
      files: fileList.value,
      targetDirId: props.targetDirId,
      conflictPolicy: conflictPolicy.value,
    })

    if (result.success) {
      ElMessage.success('上传任务已创建，可在任务日志中查看进度')
      emit('success')
      onClose()
    } else {
      ElMessage.error(result.error || '创建上传任务失败')
    }
  } catch {
    ElMessage.error('创建上传任务失败')
  } finally {
    uploading.value = false
  }
}


function onClose() {
  emit('update:modelValue', false)
  fileList.value = []
  conflictPolicy.value = 'rename'
}
</script>

<style scoped>
.target-info {
  padding: 12px 16px;
  background: #f5f7fa;
  border-radius: 8px;
  margin-bottom: 16px;
}

.target-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #606266;
}

.target-item + .target-item {
  margin-top: 4px;
}

.target-label {
  color: #909399;
}

.target-value {
  color: #303133;
  font-weight: 500;
}

.file-select-area {
  margin-bottom: 16px;
}

.select-buttons {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.drop-zone {
  border: 2px dashed #dcdfe6;
  border-radius: 12px;
  padding: 40px;
  text-align: center;
  color: #909399;
  transition: all 0.3s;
  cursor: pointer;
}

.drop-zone:hover {
  border-color: #c0c4cc;
  background: #fafafa;
}

.drop-zone.drag-over {
  border-color: #409eff;
  background: #ecf5ff;
  color: #409eff;
}

.drop-zone svg {
  margin-bottom: 12px;
}

.drop-zone p {
  margin: 0;
  font-size: 14px;
}

.file-list {
  margin-bottom: 16px;
}

.file-list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-size: 13px;
  color: #606266;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}

.file-icon {
  font-size: 20px;
  flex-shrink: 0;
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  display: block;
  font-size: 13px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  font-size: 12px;
  color: #909399;
}

.options {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.option-label {
  font-size: 13px;
  color: #606266;
}
/* Light workflow layout */
.target-info {
  display: grid;
  gap: 8px;
  padding: 13px 15px;
  margin-bottom: 20px;
  background: var(--pl-surface-subtle);
  border: 1px solid var(--pl-border);
  border-radius: 12px;
}
.target-item { gap: 12px; color: var(--pl-text-secondary); }
.target-label { min-width: 58px; color: var(--pl-text-muted); font-size: 11px; font-weight: 600; }
.target-value { color: var(--pl-text); font-size: 13px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.section-heading div { display: flex; flex-direction: column; gap: 2px; }
.section-heading strong { color: var(--pl-text); font-size: 13px; }
.section-heading span { color: var(--pl-text-muted); font-size: 11px; }
.select-buttons { gap: 8px; margin-bottom: 12px; }
.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 30px 20px;
  background: var(--pl-surface-subtle);
  border: 1.5px dashed var(--pl-border-strong);
  border-radius: 14px;
  color: var(--pl-text-muted);
  transition: border-color .18s ease, background-color .18s ease, transform .18s ease, color .18s ease;
}
.drop-zone:hover,
.drop-zone:focus-visible {
  color: var(--pl-primary);
  background: #f7faff;
  border-color: #9dbfff;
  outline: none;
  transform: translateY(-1px);
}
.drop-zone.drag-over {
  color: var(--pl-primary-hover);
  background: var(--pl-primary-soft);
  border-color: var(--pl-primary);
  border-style: solid;
  box-shadow: 0 0 0 4px rgba(52, 120, 246, .1);
}
.drop-icon {
  width: 50px;
  height: 50px;
  display: grid;
  place-items: center;
  color: var(--pl-primary);
  background: var(--pl-primary-soft);
  border-radius: 16px;
}
.drop-icon svg { margin: 0; }
.drop-zone p { margin: 2px 0 0; color: var(--pl-text-secondary); font-size: 13px; }
.drop-zone p strong { color: var(--pl-primary); font-weight: 600; }
.drop-zone > span:last-child { color: var(--pl-text-muted); font-size: 11px; }
.file-list { padding: 12px; margin-bottom: 18px; background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); border-radius: 12px; }
.file-list-header { margin-bottom: 9px; color: var(--pl-text-secondary); font-size: 12px; font-weight: 600; }
.file-item { gap: 10px; padding: 9px 4px; border-bottom-color: var(--pl-border); }
.file-icon { width: 30px; height: 30px; display: grid; place-items: center; color: var(--pl-primary); background: var(--pl-primary-soft); border-radius: 9px; }
.file-name { color: var(--pl-text); font-size: 12px; }
.file-size { color: var(--pl-text-muted); font-size: 11px; }
.options { align-items: flex-start; gap: 14px; margin-top: 2px; }
.options > div { display: flex; flex-direction: column; gap: 2px; min-width: 100px; }
.option-label { color: var(--pl-text); font-size: 12px; font-weight: 600; }
.option-hint { color: var(--pl-text-muted); font-size: 11px; }
</style>
