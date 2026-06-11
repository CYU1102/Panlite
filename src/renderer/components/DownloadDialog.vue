<template>
  <el-dialog
    :model-value="modelValue"
    width="600px"
    title="下载文件"
    :close-on-click-modal="false"
    @close="onClose"
  >
    <!-- 文件列表 -->
    <div class="file-list">
      <div class="file-list-header">
        <span>已选择 {{ files.length }} 个文件 ({{ formatFileSize(totalSize) }})</span>
      </div>

      <el-scrollbar max-height="200px">
        <div v-for="file in files" :key="file.fileId" class="file-item">
          <span class="file-icon">📄</span>
          <div class="file-info">
            <span class="file-name">{{ file.fileName }}</span>
            <span class="file-size">{{ formatFileSize(file.fileSize) }}</span>
          </div>
        </div>
      </el-scrollbar>
    </div>

    <!-- 下载目录选择 -->
    <div class="dir-select">
      <div class="dir-label">下载到：</div>
      <div class="dir-input">
        <el-input v-model="targetDirPath" placeholder="请选择下载目录" readonly>
          <template #append>
            <el-button @click="selectDir">
              <FolderOpen :size="14" />
            </el-button>
          </template>
        </el-input>
      </div>
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
import { ElMessage } from 'element-plus'
import { FolderOpen } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'
import type { DriveAccount, DownloadFileInfo } from '@shared/types'
import { formatFileSize } from '@shared/utils'

const props = defineProps<{
  modelValue: boolean
  account: DriveAccount | null
  files: DownloadFileInfo[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const targetDirPath = ref('')
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
  } catch (err) {
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
    })

    if (result.success) {
      ElMessage.success('下载任务已创建，可在任务日志中查看进度')
      emit('success')
      onClose()
    } else {
      ElMessage.error(result.error || '创建下载任务失败')
    }
  } catch (err) {
    ElMessage.error('创建下载任务失败')
  } finally {
    downloading.value = false
  }
}


function onClose() {
  emit('update:modelValue', false)
  targetDirPath.value = ''
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
</style>
