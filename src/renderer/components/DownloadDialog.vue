<template>
  <el-dialog
    :model-value="modelValue"
    width="600px"
    title="下载文件"
    class="download-dialog"
    :close-on-click-modal="false"
    @close="onClose"
  >
    <!-- 文件列表 -->
    <div class="file-list">
      <div class="file-list-header">
        <div>
          <strong>下载内容</strong>
          <span>已选择 {{ files.length }} 个项目 · {{ formatFileSize(totalSize) }}</span>
        </div>
      </div>

      <el-scrollbar max-height="200px">
        <div v-for="file in files" :key="file.fileId" class="file-item">
          <span class="file-icon"><FolderOpen v-if="file.isDir" :size="16" /><FileText v-else :size="16" /></span>
          <div class="file-info">
            <span class="file-name">{{ file.fileName }}</span>
            <span class="file-size">{{ formatFileSize(file.fileSize) }}</span>
          </div>
        </div>
      </el-scrollbar>
    </div>

    <!-- 下载目录选择 -->
    <div class="dir-select">
      <div class="dir-label">
        <strong>保存位置</strong>
        <span>选择本机文件夹</span>
      </div>
      <div class="dir-input">
        <el-input v-model="targetDirPath" placeholder="请选择下载目录" readonly>
          <template #append>
            <el-button aria-label="选择下载目录" title="选择下载目录" @click="selectDir">
              <FolderOpen :size="14" />
              <span>浏览</span>
            </el-button>
          </template>
        </el-input>
      </div>
    </div>

    <div class="conflict-select">
      <div class="dir-label"><strong>同名文件处理</strong><span>目标位置已存在同名内容时</span></div>
      <el-select v-model="conflictPolicy" style="width: 200px">
        <el-option label="自动重命名（推荐）" value="rename" />
        <el-option label="跳过" value="skip" />
        <el-option label="覆盖" value="overwrite" />
      </el-select>
    </div>

    <template #footer>
      <el-button @click="onClose">取消</el-button>
      <el-button
        type="primary"
        @click="startDownload"
        :disabled="!targetDirPath"
        :loading="downloading"
      >
        开始下载
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { FolderOpen, FileText } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'
import type { DriveAccount, DownloadFileInfo, FileConflictPolicy } from '@shared/types'
import { formatFileSize } from '@shared/utils'

const props = defineProps<{
  modelValue: boolean
  account: Omit<DriveAccount, 'credential'> | null
  files: DownloadFileInfo[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const targetDirPath = ref('')
const conflictPolicy = ref<FileConflictPolicy>('rename')
const downloading = ref(false)

const totalSize = computed(() =>
  props.files.reduce((sum, f) => sum + f.fileSize, 0)
)

async function selectDir() {
  try {
    const result = await electronApi.selectDownloadDir()
    if (result.success && result.dirPath) {
      targetDirPath.value = result.dirPath
    }
  } catch {
    ElMessage.error('选择目录失败')
  }
}

async function startDownload() {
  if (!props.account) {
    ElMessage.error('请先选择账号')
    return
  }

  if (props.files.length === 0) {
    ElMessage.warning('请先选择要下载的文件')
    return
  }

  if (!targetDirPath.value) {
    ElMessage.warning('请选择下载目录')
    return
  }

  downloading.value = true
  try {
    const result = await electronApi.downloadFiles({
      accountId: props.account.id,
      files: props.files,
      targetDirPath: targetDirPath.value,
      conflictPolicy: conflictPolicy.value,
    })

    if (result.success) {
      ElMessage.success('下载任务已创建，可在任务日志中查看进度')
      emit('success')
      onClose()
    } else {
      ElMessage.error(result.error || '创建下载任务失败')
    }
  } catch {
    ElMessage.error('创建下载任务失败')
  } finally {
    downloading.value = false
  }
}


function onClose() {
  emit('update:modelValue', false)
  targetDirPath.value = ''
  conflictPolicy.value = 'rename'
}
</script>

<style scoped>
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

.dir-select {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dir-label {
  font-size: 13px;
  color: #606266;
  white-space: nowrap;
}

.dir-input {
  flex: 1;
}

.conflict-select {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}
.file-list {
  padding: 12px;
  background: var(--pl-surface-subtle);
  border: 1px solid var(--pl-border);
  border-radius: 12px;
}
.file-list-header { margin-bottom: 9px; color: var(--pl-text-secondary); }
.file-list-header > div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.file-list-header strong { color: var(--pl-text); font-size: 13px; }
.file-list-header span { color: var(--pl-text-muted); font-size: 11px; }
.file-item { padding: 9px 4px; border-bottom-color: var(--pl-border); }
.file-icon { width: 30px; height: 30px; display: grid; place-items: center; color: var(--pl-primary); background: var(--pl-primary-soft); border-radius: 9px; }
.file-info { gap: 2px; }
.file-name { color: var(--pl-text); font-size: 12px; }
.file-size { color: var(--pl-text-muted); font-size: 11px; }
.dir-select, .conflict-select { gap: 14px; padding: 12px; background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); border-radius: 12px; }
.conflict-select { margin-top: 10px; }
.dir-label { display: flex; min-width: 88px; flex-direction: column; gap: 2px; }
.dir-label strong { color: var(--pl-text); font-size: 12px; font-weight: 600; }
.dir-label span { color: var(--pl-text-muted); font-size: 11px; }
.dir-input :deep(.el-input-group__append) { padding: 0 5px; background: var(--pl-surface); border-color: var(--pl-border); }
.dir-input :deep(.el-button) { height: 30px; color: var(--pl-primary); }
</style>
