<template>
  <el-dialog
    :model-value="modelValue"
    width="500px"
    title="创建压缩包"
    :close-on-click-modal="false"
    @close="onClose"
  >
    <!-- 文件信息 -->
    <div class="file-info">
      <div class="info-label">将压缩：</div>
      <div class="info-files">
        <span v-for="file in files" :key="file.id" class="info-file">
          {{ file.isDir ? '📁' : '📄' }} {{ file.name }}
        </span>
      </div>
    </div>

    <!-- 压缩选项 -->
    <el-form label-width="100px">
      <el-form-item label="压缩包名称">
        <el-input v-model="archiveName" placeholder="请输入压缩包名称（不含扩展名）" />
      </el-form-item>

      <el-form-item label="压缩格式">
        <el-radio-group v-model="archiveFormat">
          <el-radio value="zip">ZIP</el-radio>
          <el-radio value="tar">TAR.GZ</el-radio>
        </el-radio-group>
      </el-form-item>

      <el-form-item label="保存位置">
        <div class="dir-info">
          <span>压缩包将保存到当前目录</span>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="onClose">取消</el-button>
      <el-button
        type="primary"
        @click="startCompress"
        :disabled="!archiveName || !props.currentDirId"
        :loading="compressing"
      >
        开始压缩
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { electronApi } from '../api/ipc'
import type { DriveAccount, FileItem } from '@shared/types'

const props = defineProps<{
  modelValue: boolean
  account: DriveAccount | null
  files: FileItem[]
  currentDirId: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const archiveName = ref('')
const archiveFormat = ref('zip')
const compressing = ref(false)

async function startCompress() {
  if (!props.account) return
  if (!archiveName.value) {
    ElMessage.warning('请输入压缩包名称')
    return
  }

  compressing.value = true
  try {
    const result = await electronApi.archiveCompress(
      props.account.id,
      props.files.map(f => f.id),
      {
        format: archiveFormat.value,
        targetDir: props.currentDirId,
        archiveName: archiveName.value,
      }
    )

    if (result.success) {
      ElMessage.success('压缩完成')
      emit('success')
      onClose()
    } else {
      ElMessage.error(result.error || '压缩失败')
    }
  } catch (err) {
    ElMessage.error('压缩失败: ' + String(err))
  } finally {
    compressing.value = false
  }
}

function onClose() {
  emit('update:modelValue', false)
  archiveName.value = ''
  archiveFormat.value = 'zip'
}
</script>

<style scoped>
.file-info {
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  background: #f5f7fa;
  border-radius: 8px;
  margin-bottom: 16px;
}

.info-label {
  font-size: 13px;
  color: #909399;
  white-space: nowrap;
}

.info-files {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.info-file {
  font-size: 13px;
  color: #303133;
}

.dir-select {
  width: 100%;
}
</style>
