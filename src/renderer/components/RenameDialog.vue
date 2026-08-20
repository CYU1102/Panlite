<template>
  <el-dialog
    :title="files.length === 1 ? '重命名' : '批量重命名'"
    :model-value="modelValue"
    width="560px"
    class="rename-dialog"
    @close="emit('update:modelValue', false)"
  >
    <div class="rename-content">
      <div class="info"><FilePenLine :size="16" /><span>将重命名 <strong>{{ files.length }}</strong> 个项目</span></div>
      <el-form label-position="top" class="rename-form">
        <el-form-item label="重命名模式">
          <el-select v-model="mode" style="width: 100%">
            <el-option label="替换文本" value="replace" />
            <el-option label="添加前缀" value="prefix" />
            <el-option label="添加后缀" value="suffix" />
            <el-option label="序号重命名" value="sequence" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="mode === 'replace'" label="查找文本">
          <el-input v-model="replaceFrom" placeholder="要替换的文本" />
        </el-form-item>
        <el-form-item v-if="mode === 'replace'">
          <el-checkbox v-model="useRegex">使用正则表达式</el-checkbox>
        </el-form-item>
        <el-form-item v-if="mode === 'replace'" label="替换为">
          <el-input v-model="replaceTo" placeholder="替换后的文本" />
        </el-form-item>
        <el-form-item v-if="mode === 'prefix'" label="前缀">
          <el-input v-model="prefix" placeholder="添加的前缀" />
        </el-form-item>
        <el-form-item v-if="mode === 'suffix'" label="后缀">
          <el-input v-model="suffix" placeholder="添加的后缀" />
        </el-form-item>
        <el-form-item v-if="mode === 'sequence'" label="起始序号">
          <el-input-number v-model="seqStart" :min="1" />
        </el-form-item>
        <el-form-item v-if="mode === 'sequence'" label="序号位数">
          <el-input-number v-model="seqDigits" :min="1" :max="10" />
        </el-form-item>
        <el-form-item v-if="mode === 'sequence'" label="序号分隔符">
          <el-input v-model="seqSeparator" maxlength="8" placeholder="例如：_ 或 -" />
        </el-form-item>
      </el-form>
      <div class="preview" v-if="files.length > 0">
        <div class="preview-title">
          <span>名称预览</span>
          <small>{{ preview.changedCount }} 项将更改 · 最多显示 8 项</small>
        </div>
        <div
          v-for="item in preview.items.slice(0, 8)"
          :key="`${item.file.accountId}:${item.file.id}`"
          class="preview-item"
          :class="{ invalid: item.errors.length > 0 }"
          :title="item.errors.join('；')"
        >
          <span class="old-name">{{ item.oldName }}</span>
          <span class="preview-arrow"><ArrowRight :size="13" /></span>
          <span class="new-name">{{ item.newName }}</span>
        </div>
        <p v-if="files.length > 8" class="more">...还有 {{ files.length - 8 }} 个项目</p>
        <div v-if="preview.errors.length" class="validation-errors">
          <div v-for="error in preview.errors" :key="error">{{ error }}</div>
        </div>
      </div>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="onConfirm" :loading="loading" :disabled="!canSubmit">执行重命名</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { ArrowRight, FilePenLine } from 'lucide-vue-next'
import type { FileItem } from '@shared/types'
import {
  buildBatchRenamePreview,
  toBatchRenameItems,
  type BatchRenameMode,
} from '@shared/batch-rename'
import { electronApi } from '../api/ipc'

const props = defineProps<{
  modelValue: boolean
  files: FileItem[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const mode = ref<BatchRenameMode>('replace')
const replaceFrom = ref('')
const replaceTo = ref('')
const prefix = ref('')
const suffix = ref('')
const seqStart = ref(1)
const seqDigits = ref(3)
const seqSeparator = ref('_')
const loading = ref(false)
const useRegex = ref(false)

const preview = computed(() => buildBatchRenamePreview(props.files, {
  mode: mode.value,
  replaceFrom: replaceFrom.value,
  replaceTo: replaceTo.value,
  useRegex: useRegex.value,
  prefix: prefix.value,
  suffix: suffix.value,
  sequenceStart: seqStart.value,
  sequenceDigits: seqDigits.value,
  sequenceSeparator: seqSeparator.value,
}))

const canSubmit = computed(() => preview.value.valid && preview.value.changedCount > 0 && !loading.value)

async function onConfirm() {
  if (!preview.value.valid) {
    ElMessage.error(preview.value.errors[0] || '请修正重命名规则')
    return
  }
  const items = toBatchRenameItems(preview.value)
  if (items.length === 0) {
    ElMessage.warning('当前规则不会更改任何名称')
    return
  }

  loading.value = true
  try {
    for (const item of items) {
      const file = props.files.find((candidate) => candidate.id === item.fileId)
      if (!file) continue
      const result = await electronApi.renameFile(file.accountId, file.id, item.newName)
      if (!result.success) throw new Error(result.error || `重命名 ${file.name} 失败`)
    }
    ElMessage.success('重命名完成')
    emit('update:modelValue', false)
    emit('success')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重命名失败')
  } finally {
    loading.value = false
  }
}

// Reset regex mode when dialog opens
watch(() => props.modelValue, (open) => {
  if (open) {
    useRegex.value = false
    replaceFrom.value = ''
    replaceTo.value = ''
    prefix.value = ''
    suffix.value = ''
    seqStart.value = 1
    seqDigits.value = 3
    seqSeparator.value = '_'
  }
})
</script>

<style scoped>
.rename-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info {
  color: #606266;
  font-size: 14px;
}

.regex-error {
  color: #ef4444;
  font-size: 12px;
}

.preview {
  background: #f5f7fa;
  border-radius: 4px;
  padding: 12px;
}

.preview-title {
  font-size: 13px;
  color: #909399;
  margin-bottom: 8px;
}

.preview-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.old-name {
  color: #909399;
  text-decoration: line-through;
}

.new-name {
  color: #409eff;
}

.more {
  color: #909399;
  font-size: 12px;
  margin-top: 8px;
}
.rename-content { gap: 15px; }
.info {
  display: flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  padding: 6px 10px;
  color: var(--pl-primary-hover);
  background: var(--pl-primary-soft);
  border-radius: 8px;
  font-size: 12px;
}
.rename-form { padding: 13px 14px 2px; background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); border-radius: 12px; }
.rename-form :deep(.el-form-item) { margin-bottom: 14px; }
.rename-form :deep(.el-form-item__label) { height: auto; margin-bottom: 6px; color: var(--pl-text-secondary); font-size: 12px; font-weight: 600; line-height: 1.35; }
.regex-error { display: block; width: 100%; padding: 7px 9px; color: var(--pl-danger); background: var(--pl-danger-soft); border-radius: 8px; }
.preview { padding: 12px; background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: 12px; }
.preview-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.preview-title span { color: var(--pl-text); font-size: 12px; font-weight: 650; }
.preview-title small { color: var(--pl-text-muted); font-size: 10px; }
.preview-item { min-height: 34px; padding: 5px 7px; background: var(--pl-surface-subtle); border-radius: 8px; }
.preview-item.invalid { background: var(--pl-danger-soft); }
.old-name, .new-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.old-name { color: var(--pl-text-muted); }
.new-name { color: var(--pl-primary-hover); font-weight: 600; }
.preview-arrow { width: 23px; height: 23px; display: grid; place-items: center; flex: 0 0 auto; color: var(--pl-primary); background: var(--pl-primary-soft); border-radius: 7px; }
.more { color: var(--pl-text-muted); }
.validation-errors { display: grid; gap: 4px; margin-top: 9px; padding: 8px 10px; color: var(--pl-danger); background: var(--pl-danger-soft); border-radius: 8px; font-size: 11px; }
</style>
