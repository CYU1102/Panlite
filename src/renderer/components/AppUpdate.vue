<template>
  <div class="app-update" aria-live="polite">
    <span>{{ description }}</span>
    <el-progress v-if="state.phase === 'downloading'" :percentage="state.percent || 0" />
    <div class="update-actions">
      <el-button v-if="['idle', 'current', 'error', 'available', 'checking'].includes(state.phase)"
        :loading="state.phase === 'checking'" :disabled="busy" @click="act('checkAppUpdate')">检查更新</el-button>
      <el-button v-if="state.phase === 'available'" type="primary" :disabled="busy" @click="act('downloadAppUpdate')">下载更新</el-button>
      <el-button v-if="state.phase === 'downloaded'" type="primary" :disabled="busy" @click="act('installAppUpdate')">安装并重启</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { electronApi } from '../api/ipc'
import type { AppUpdateState } from '../../shared/app-update'

const state = ref<AppUpdateState>({ phase: 'disabled', revision: -1 })
const busy = ref(false)
let active = true
let unsubscribe: (() => void) | undefined
const description = computed(() => ({
  disabled: '当前版本暂不支持应用内更新。', idle: '可手动检查新版本。', checking: '正在检查更新…',
  current: '当前已是最新版本。', available: `发现新版本 ${state.value.version || ''}。`,
  downloading: '正在下载并校验更新…', downloaded: `版本 ${state.value.version || ''} 已准备好，安装将重新启动应用。`,
  installing: '正在启动安装程序…', error: state.value.message || '更新失败，请稍后重试。',
}[state.value.phase]))
function receive(next: AppUpdateState) {
  if (active && next.revision >= state.value.revision) state.value = next
}
async function act(method: 'checkAppUpdate' | 'downloadAppUpdate' | 'installAppUpdate') {
  if (busy.value) return
  busy.value = true
  try {
    const result = await electronApi[method]()
    receive(result.state)
    if (active && !result.success) ElMessage.error(result.error || '更新操作失败')
  } catch { if (active) ElMessage.error('无法连接更新服务，请稍后重试') }
  finally { busy.value = false }
}
onMounted(async () => {
  unsubscribe = electronApi.onAppUpdateChanged(receive)
  try { receive(await electronApi.getAppUpdateState()) }
  catch { if (active) ElMessage.error('无法读取更新状态') }
})
onUnmounted(() => { active = false; unsubscribe?.() })
</script>

<style scoped>
.app-update { display: flex; flex-direction: column; gap: 10px; font-size: 13px; color: var(--pl-text-secondary); }
.update-actions { display: flex; gap: 8px; }
.update-actions:empty { display: none; }
</style>
