<template>
  <el-dialog :model-value="Boolean(task)" title="任务调度" width="460px" @close="emit('close')">
    <form class="schedule-form" @submit.prevent="save">
      <p>{{ task?.title }}</p>
      <label>优先级<select v-model="priority" aria-label="任务优先级"><option value="high">优先处理</option><option value="normal">普通</option><option value="low">后台处理</option></select></label>
      <label>传输时段<select v-model="windowMode" aria-label="任务时段模式"><option value="inherit">跟随全局设置</option><option value="any">不限时段</option><option value="custom">指定时段</option></select></label>
      <label v-if="windowMode === 'custom'">指定时段<input v-model="window" placeholder="02:00-08:00" aria-label="任务传输时段" /></label>
      <label>最早开始时间<input v-model="notBefore" type="datetime-local" aria-label="最早开始时间" /></label>
      <p class="schedule-note">留空即可立即排队。优先级作用于等待中的任务，长期等待的后台任务会逐渐提升顺序。</p>
      <p v-if="error" role="alert" class="schedule-error">{{ error }}</p>
      <div class="schedule-actions"><el-button @click="emit('close')">取消</el-button><el-button type="primary" native-type="submit" :loading="saving">保存调度</el-button></div>
    </form>
  </el-dialog>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Task } from '@shared/types'
import { normalizeTaskSchedule, type TaskPriority } from '@shared/task-scheduling'
import { electronApi } from '../api/ipc'
const props = defineProps<{ task: Task | null }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const priority = ref<TaskPriority>('normal')
const windowMode = ref('inherit')
const window = ref('')
const notBefore = ref('')
const error = ref('')
const saving = ref(false)
let generation = 0
watch(() => props.task, task => {
  generation++; error.value = ''; saving.value = false
  priority.value = task?.schedule?.priority ?? 'normal'
  const storedWindow = task?.schedule?.window
  windowMode.value = storedWindow == null ? 'inherit' : storedWindow === '' ? 'any' : 'custom'
  window.value = storedWindow ?? ''
  const date = task?.schedule?.notBefore ? new Date(task.schedule.notBefore) : null
  notBefore.value = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''
}, { immediate: true })
async function save() {
  if (!props.task || saving.value) return
  const version = generation
  try {
    const schedule = normalizeTaskSchedule({ priority: priority.value, window: windowMode.value === 'inherit' ? null : windowMode.value === 'any' ? '' : window.value,
      notBefore: notBefore.value ? new Date(notBefore.value).getTime() : null })
    saving.value = true; error.value = ''
    const result = await electronApi.setTaskSchedule(props.task.id, schedule)
    if (version !== generation) return
    if (!result.success) throw new Error(result.error || '调度未保存')
    emit('changed'); emit('close')
  } catch (cause) { if (version === generation) error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (version === generation) saving.value = false }
}
</script>
<style scoped>
.schedule-form{display:flex;flex-direction:column;gap:16px;color:var(--pl-text)}
.schedule-form label{display:flex;flex-direction:column;gap:6px}.schedule-form input,.schedule-form select{padding:9px;border:1px solid var(--pl-border);border-radius:8px;background:var(--pl-surface);color:var(--pl-text)}
.schedule-note{font-size:12px;color:var(--pl-text-muted);line-height:1.6}.schedule-error{color:var(--pl-danger,#d14343)}.schedule-actions{display:flex;justify-content:flex-end;gap:8px}
</style>
