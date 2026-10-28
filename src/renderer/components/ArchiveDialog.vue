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
    <div v-if="loadError" class="archive-error" role="alert">{{ loadError }}</div>
    <p v-if="meta" class="archive-note">解压不会覆盖已有同名文件；如有冲突，请选择其他目录或先重命名。失败时请检查目标目录中已写入的新文件。</p>
    <div v-if="loadError || (meta?.isEncrypted && !password)" class="password-section">
      <el-input
        v-model="inputPassword"
        type="password"
        placeholder="压缩包密码（如需要）"
        aria-label="压缩包密码"
        show-password
      >
        <template #prepend>密码</template>
      </el-input>
      <el-button type="primary" @click="loadWithPassword" :loading="loading">
        重新读取
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
          :disabled="!meta || loading || extracting"
          :loading="extracting"
        >
          全部解压
        </el-button>
        <el-button
          type="success"
          @click="onExtractSelected"
          :disabled="selectedFiles.length === 0 || loading || extracting"
          :loading="extracting"
        >
          解压选中 ({{ selectedFiles.length }})
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
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
  initialPassword?: string
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
const loadError = ref('')
const selectedFiles = ref<ArchiveFileInfo[]>([])
let generation = 0
onBeforeUnmount(() => { generation++; password.value = ''; inputPassword.value = '' })

// 监听对话框打开
watch(() => [props.modelValue, props.account?.id, props.fileId, props.fileName, props.initialPassword] as const, (current, previous) => {
  generation++
  meta.value = null
  loadError.value = ''
  selectedFiles.value = []
  loading.value = false
  extracting.value = false
  const scopeChanged = previous && (current[1] !== previous[1] || current[2] !== previous[2] || current[3] !== previous[3])
  password.value = props.modelValue && !(scopeChanged && current[4] === previous[4]) ? props.initialPassword || '' : ''
  inputPassword.value = password.value
  if (props.modelValue && props.account && props.fileId) void loadArchive()
}, { immediate: true })

async function loadArchive() {
  if (!props.account) return
  const attempt = ++generation
  const accountId = props.account.id
  const fileId = props.fileId
  const fileName = props.fileName
  const attemptPassword = password.value || undefined
  loading.value = true
  loadError.value = ''
  try {
    const result = await electronApi.archiveList(
      accountId,
      fileId,
      fileName,
      attemptPassword,
    )
    if (attempt !== generation) return
    if (result.success && result.meta) {
      meta.value = result.meta
    } else {
      meta.value = null
      loadError.value = result.error || '读取压缩包失败'
    }
  } catch (err) {
    if (attempt !== generation) return
    meta.value = null
    loadError.value = '读取压缩包失败: ' + String(err)
  } finally {
    if (attempt === generation) loading.value = false
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
  const attempt = generation
  const accountId = props.account.id
  const fileId = props.fileId
  const fileName = props.fileName
  const attemptPassword = password.value || undefined

  extracting.value = true
  try {
    // 选择目录期间账号或文件可能发生变化。
    const dirResult = await electronApi.selectDownloadDir()
    if (attempt !== generation) return
    if (!dirResult.success || !dirResult.dirPath) return
    const result = await electronApi.archiveExtract(
      accountId,
      fileId,
      fileName,
      {
        password: attemptPassword,
        targetDir: dirResult.dirPath,
        files,
      }
    )

    if (attempt !== generation) return
    if (result.success) {
      ElMessage.success(result.taskId ? '解压任务已创建，可在任务日志查看进度' : '解压完成')
      emit('success')
      onClose()
    } else {
      ElMessage.error(result.error || '解压失败')
    }
  } catch (err) {
    if (attempt !== generation) return
    ElMessage.error('解压失败: ' + String(err))
  } finally {
    if (attempt === generation) extracting.value = false
  }
}


function onClose() {
  generation++
  emit('update:modelValue', false)
  meta.value = null
  password.value = ''
  inputPassword.value = ''
  selectedFiles.value = []
  loadError.value = ''
  loading.value = false
  extracting.value = false
}
</script>

<style scoped>
.archive-error { margin-bottom: 12px; color: var(--pl-danger); overflow-wrap: anywhere; }
.archive-note { margin: 0 0 12px; color: var(--pl-text-secondary); font-size: 12px; line-height: 1.6; }
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
