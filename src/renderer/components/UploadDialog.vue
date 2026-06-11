<template>
  <el-dialog
    :model-value="modelValue"
    width="680px"
    title="上传文件"
    :close-on-click-modal="false"
    @close="onClose"
  >
    <!-- 目标信息 -->
    <div class="target-info">
      <div class="target-item">
        <span class="target-label">上传到:</span>
        <span class="target-value">{{ account?.nickname }} ({{ platformLabel }})</span>
      </div>
      <div class="target-item">
        <span class="target-label">目标目录:</span>
        <span class="target-value">{{ targetDirName || '根目录' }}</span>
      </div>
    </div>

    <!-- 文件选择区域 -->
    <div class="file-select-area">
      <div class="select-buttons">
        <el-button @click="selectFiles">
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
        @dragover.prevent="isDragOver = true"
        @dragleave="isDragOver = false"
        @drop.prevent="handleDrop"
      >
        <Upload :size="48" />
        <p>拖拽文件或文件夹到此处</p>
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
            <span class="file-name">{{ file.fileName }}</span>
            <span class="file-size">{{ formatFileSize(file.fileSize) }}</span>
          </div>
          <el-button text type="danger" @click="removeFile(index)">
            <X :size="14" />
          </el-button>
        </div>
      </el-scrollbar>
    </div>

    <!-- 选项 -->
    <div class="options">
      <el-checkbox v-model="overwrite">覆盖同名文件</el-checkbox>
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
import { ElMessage } from 'element-plus'
import { FolderOpen, Folder, Upload, X } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'
import { PLATFORM_LABELS } from '../../shared/constants'
import type { DriveAccount, UploadFileInfo } from '@shared/types'
import { formatFileSize } from '@shared/utils'

// Simple file icon component
const FileIcon = {
  props: ['name'],
  render() {
    return h('span', { class: 'file-icon' }, '📄')
  },
}

const props = defineProps<{
  modelValue: boolean
  account: DriveAccount | null
  targetDirId: string
  targetDirName: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const fileList = ref<UploadFileInfo[]>([])
const isDragOver = ref(false)
const overwrite = ref(false)
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
  } catch (err) {
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
  } catch (err) {
    ElMessage.error('选择文件夹失败')
  }
}

async function handleDrop(event: DragEvent) {
  isDragOver.value = false

  const files = event.dataTransfer?.files
  if (!files || files.length === 0) return

  // Electron 中 file.path 包含完整路径
  const filePaths: string[] = []
  for (let i = 0; i < files.length; i++) {
    const filePath = (files[i] as any).path
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
  } catch (err) {
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
      overwrite: overwrite.value,
    })

    if (result.success) {
      ElMessage.success('上传任务已创建，可在任务日志中查看进度')
      emit('success')
      onClose()
    } else {
      ElMessage.error(result.error || '创建上传任务失败')
    }
  } catch (err) {
    ElMessage.error('创建上传任务失败')
  } finally {
    uploading.value = false
  }
}


function onClose() {
  emit('update:modelValue', false)
  fileList.value = []
  overwrite.value = false
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
}
</style>
