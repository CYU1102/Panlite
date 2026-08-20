<template>
  <el-dialog
    :model-value="modelValue"
    width="700px"
    title="压缩包内容"
    :close-on-click-modal="false"
    @close="onClose"
  >
    <!-- 压缩包信息 -->
    <div v-if="meta" class="archive-info">
      <div class="info-item">
        <span class="info-label">格式：</span>
        <span class="info-value">{{ meta.format.toUpperCase() }}</span>
      </div>
      <div class="info-item">
        <span class="info-label">文件数：</span>
        <span class="info-value">{{ meta.fileCount }}</span>
      </div>
      <div class="info-item">
        <span class="info-label">总大小：</span>
        <span class="info-value">{{ formatFileSize(meta.totalSize) }}</span>
      </div>
    </div>

    <!-- 密码输入（如果需要） -->
    <div v-if="meta?.isEncrypted && !password" class="password-section">
      <el-input
        v-model="inputPassword"
        type="password"
        placeholder="请输入压缩包密码"
        show-password
      >
        <template #prepend>密码</template>
      </el-input>
      <el-button type="primary" @click="loadWithPassword" :loading="loading">
        确认
      </el-button>
    </div>

    <!-- 文件列表 -->
    <div v-if="meta" class="file-list">
      <el-table
        :data="meta.files"
        style="width: 100%"
        max-height="400"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="50" />
        <el-table-column label="文件名" min-width="300">
          <template #default="{ row }">
            <div class="file-name-cell">
              <span class="file-icon">{{ row.isDir ? '📁' : '📄' }}</span>
              <span>{{ row.name }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="100" align="right">
          <template #default="{ row }">
            <span class="cell-muted">{{ row.isDir ? '-' : formatFileSize(row.size) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="loading-state">
      <el-icon class="is-loading"><Loader2 /></el-icon>
      <span>正在读取压缩包内容...</span>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="onClose">关闭</el-button>
        <el-button
          type="primary"
          @click="onExtractAll"
          :disabled="!meta"
          :loading="extracting"
        >
          全部解压
        </el-button>
        <el-button
          type="success"
          @click="onExtractSelected"
          :disabled="selectedFiles.length === 0"
          :loading="extracting"
        >
          解压选中 ({{ selectedFiles.length }})
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { Loader2 } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'
import type { DriveAccount, ArchiveMeta, ArchiveFileInfo } from '@shared/types'
import { formatFileSize } from '@shared/utils'

const props = defineProps<{
  modelValue: boolean
  account: Omit<DriveAccount, 'credential'> | null
  fileId: string
  fileName: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const loading = ref(false)
const extracting = ref(false)
const meta = ref<ArchiveMeta | null>(null)
const password = ref('')
const inputPassword = ref('')
const selectedFiles = ref<ArchiveFileInfo[]>([])

// 监听对话框打开
watch(() => props.modelValue, async (newVal) => {
  if (newVal && props.account && props.fileId) {
    await loadArchive()
  }
})

async function loadArchive() {
  if (!props.account) return

  loading.value = true
  try {
    const result = await electronApi.archiveList(
      props.account.id,
      props.fileId,
      props.fileName,
      password.value || undefined
    )

    if (result.success && result.meta) {
      meta.value = result.meta
    } else {
      ElMessage.error(result.error || '读取压缩包失败')
    }
  } catch (err) {
    ElMessage.error('读取压缩包失败: ' + String(err))
  } finally {
    loading.value = false
  }
}

async function loadWithPassword() {
  password.value = inputPassword.value
  await loadArchive()
}

function onSelectionChange(files: ArchiveFileInfo[]) {
  selectedFiles.value = files
}

async function onExtractAll() {
  await extractFiles()
}

async function onExtractSelected() {
  await extractFiles(selectedFiles.value.map(f => f.path))
}

async function extractFiles(files?: string[]) {
  if (!props.account) return

  // 选择本地目标目录
  const dirResult = await electronApi.selectDownloadDir()
  if (!dirResult.success || !dirResult.dirPath) return

  extracting.value = true
  try {
    const result = await electronApi.archiveExtract(
      props.account.id,
      props.fileId,
      props.fileName,
      {
        password: password.value || undefined,
        targetDir: dirResult.dirPath,
        files,
      }
    )

    if (result.success) {
      ElMessage.success(result.taskId ? '解压任务已创建，可在任务日志查看进度' : '解压完成')
      emit('success')
      onClose()
    } else {
      ElMessage.error(result.error || '解压失败')
    }
  } catch (err) {
    ElMessage.error('解压失败: ' + String(err))
  } finally {
    extracting.value = false
  }
}


function onClose() {
  emit('update:modelValue', false)
  meta.value = null
  password.value = ''
  inputPassword.value = ''
  selectedFiles.value = []
}
</script>

<style scoped>
.archive-info {
  display: flex;
  gap: 24px;
  padding: 12px 16px;
  background: #f5f7fa;
  border-radius: 8px;
  margin-bottom: 16px;
}

.info-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.info-label {
  font-size: 13px;
  color: #909399;
}

.info-value {
  font-size: 13px;
  color: #303133;
  font-weight: 500;
}

.password-section {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.file-list {
  margin-bottom: 16px;
}

.file-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.file-icon {
  font-size: 16px;
}

.cell-muted {
  color: #909399;
  font-size: 12px;
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px;
  color: #909399;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
