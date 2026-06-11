<template>
  <el-dialog
    :model-value="modelValue"
    width="500px"
    title="高级筛选"
    :close-on-click-modal="false"
    @close="onClose"
  >
    <el-form label-width="100px">
      <!-- 文件类型筛选 -->
      <el-form-item label="文件类型">
        <el-checkbox-group v-model="selectedTypes">
          <el-checkbox value="video">视频</el-checkbox>
          <el-checkbox value="audio">音频</el-checkbox>
          <el-checkbox value="image">图片</el-checkbox>
          <el-checkbox value="document">文档</el-checkbox>
          <el-checkbox value="archive">压缩包</el-checkbox>
          <el-checkbox value="folder">文件夹</el-checkbox>
        </el-checkbox-group>
      </el-form-item>

      <!-- 文件大小筛选 -->
      <el-form-item label="文件大小">
        <div class="size-filter">
          <el-input-number
            v-model="minSizeMB"
            :min="0"
            :max="99999"
            placeholder="最小"
            size="small"
          />
          <span class="size-sep">-</span>
          <el-input-number
            v-model="maxSizeMB"
            :min="0"
            :max="99999"
            placeholder="最大"
            size="small"
          />
          <span class="size-unit">MB</span>
        </div>
      </el-form-item>

      <!-- 修改时间筛选 -->
      <el-form-item label="修改时间">
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          size="default"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="onReset">重置</el-button>
        <el-button @click="onClose">取消</el-button>
        <el-button type="primary" @click="onApply">应用筛选</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

export interface SearchFilterOptions {
  fileTypes?: string[]
  minSize?: number
  maxSize?: number
  dateFrom?: number
  dateTo?: number
}

const props = defineProps<{
  modelValue: boolean
  filters: SearchFilterOptions
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  apply: [filters: SearchFilterOptions]
}>()

const selectedTypes = ref<string[]>(props.filters.fileTypes || [])
const minSizeMB = ref<number | undefined>(props.filters.minSize ? props.filters.minSize / (1024 * 1024) : undefined)
const maxSizeMB = ref<number | undefined>(props.filters.maxSize ? props.filters.maxSize / (1024 * 1024) : undefined)
const dateRange = ref<Date[] | null>(
  props.filters.dateFrom && props.filters.dateTo
    ? [new Date(props.filters.dateFrom), new Date(props.filters.dateTo)]
    : null
)

// 监听 props.filters 变化，同步到本地状态
watch(() => props.filters, (newFilters) => {
  selectedTypes.value = newFilters.fileTypes || []
  minSizeMB.value = newFilters.minSize ? newFilters.minSize / (1024 * 1024) : undefined
  maxSizeMB.value = newFilters.maxSize ? newFilters.maxSize / (1024 * 1024) : undefined
  dateRange.value = newFilters.dateFrom && newFilters.dateTo
    ? [new Date(newFilters.dateFrom), new Date(newFilters.dateTo)]
    : null
}, { deep: true })

function onApply() {
  const filters: SearchFilterOptions = {}

  if (selectedTypes.value.length > 0) {
    filters.fileTypes = selectedTypes.value
  }

  if (minSizeMB.value !== undefined && minSizeMB.value > 0) {
    filters.minSize = minSizeMB.value * 1024 * 1024
  }

  if (maxSizeMB.value !== undefined && maxSizeMB.value > 0) {
    filters.maxSize = maxSizeMB.value * 1024 * 1024
  }

  if (dateRange.value && dateRange.value.length === 2) {
    filters.dateFrom = dateRange.value[0].getTime()
    filters.dateTo = dateRange.value[1].getTime() + 24 * 60 * 60 * 1000 - 1 // 包含结束日期
  }

  emit('apply', filters)
  onClose()
}

function onReset() {
  selectedTypes.value = []
  minSizeMB.value = undefined
  maxSizeMB.value = undefined
  dateRange.value = null
}

function onClose() {
  emit('update:modelValue', false)
}
</script>

<style scoped>
.size-filter {
  display: flex;
  align-items: center;
  gap: 8px;
}

.size-sep {
  color: #909399;
}

.size-unit {
  color: #909399;
  font-size: 13px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
