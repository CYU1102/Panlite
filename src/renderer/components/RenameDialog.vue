<template>
  <el-dialog
    :title="files.length === 1 ? '重命名' : '批量重命名'"
    :model-value="modelValue"
    width="500px"
    @close="emit('update:modelValue', false)"
  >
    <div class="rename-content">
      <p class="info">已选择 {{ files.length }} 个文件</p>
      <el-form label-width="100px">
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
        <el-form-item v-if="mode === 'replace' && useRegex && regexError" label="正则错误">
          <span class="regex-error">{{ regexError }}</span>
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
      </el-form>
      <div class="preview" v-if="files.length > 0">
        <p class="preview-title">预览：</p>
        <div v-for="file in files.slice(0, 5)" :key="file.id" class="preview-item">
          <span class="old-name">{{ file.name }}</span>
          <ArrowRight :size="14" />
          <span class="new-name">{{ getNewName(file) }}</span>
        </div>
        <p v-if="files.length > 5" class="more">...还有 {{ files.length - 5 }} 个文件</p>
      </div>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="onConfirm" :loading="loading" :disabled="!!regexError">执行重命名</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowRight } from 'lucide-vue-next'
import type { FileItem } from '@shared/types'
import { escapeRegExp } from '@shared/utils'
import { electronApi } from '../api/ipc'

const props = defineProps<{
  modelValue: boolean
  files: FileItem[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const mode = ref('replace')
const replaceFrom = ref('')
const replaceTo = ref('')
const prefix = ref('')
const suffix = ref('')
const seqStart = ref(1)
const seqDigits = ref(3)
const loading = ref(false)
const useRegex = ref(false)

const regexError = computed(() => {
  if (mode.value !== 'replace' || !useRegex.value || !replaceFrom.value) return null
  try {
    new RegExp(replaceFrom.value, 'g')
    return null
  } catch (err) {
    return (err as Error).message || '无效的正则表达式'
  }
})

function getNewName(file: FileItem): string {
  const name = file.name
  switch (mode.value) {
    case 'replace': {
      if (!replaceFrom.value) return name
      if (useRegex.value) {
        if (regexError.value) return name
        try {
          return name.replace(new RegExp(replaceFrom.value, 'g'), replaceTo.value)
        } catch {
          return name
        }
      }
      // Plain text replace (safe, no regex)
      return name.split(replaceFrom.value).join(replaceTo.value)
    }
    case 'prefix':
      return prefix.value + name
    case 'suffix': {
      const dotIdx = name.lastIndexOf('.')
      if (dotIdx === -1) return name + suffix.value
      return name.substring(0, dotIdx) + suffix.value + name.substring(dotIdx)
    }
    case 'sequence': {
      const idx = props.files.indexOf(file)
      const num = String(seqStart.value + idx).padStart(seqDigits.value, '0')
      const dotIdx = name.lastIndexOf('.')
      if (dotIdx === -1) return `${num}_${name}`
      return `${num}_${name.substring(0, dotIdx)}${name.substring(dotIdx)}`
    }
    default:
      return name
  }
}

async function onConfirm() {
  if (mode.value === 'replace' && useRegex.value && regexError.value) {
    ElMessage.error('正则表达式无效: ' + regexError.value)
    return
  }

  loading.value = true
  try {
    for (const file of props.files) {
      const newName = getNewName(file)
      if (newName !== file.name) {
        await electronApi.renameFile(file.accountId, file.id, newName)
      }
    }
    ElMessage.success('重命名完成')
    emit('update:modelValue', false)
    emit('success')
  } catch (err) {
    ElMessage.error('重命名失败')
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
</style>
