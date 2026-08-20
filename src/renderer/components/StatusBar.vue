<template>
  <div class="status-bar">
    <div class="status-left">
      <div class="status-chip">
        <User :size="12" />
        <span>{{ currentAccountName }}</span>
      </div>
      <div class="status-chip">
        <Folder :size="12" />
        <span>{{ appStore.currentPathName }}</span>
      </div>
      <div v-if="appStore.selectedCount > 0" class="status-chip active">
        <CheckCircle2 :size="12" />
        <span>已选 {{ appStore.selectedCount }} 项</span>
      </div>
    </div>
    <div class="status-right">
      <div class="status-chip">
        <Clock :size="12" />
        <span>{{ currentTime }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { User, Folder, CheckCircle2, Clock } from 'lucide-vue-next'
import { useAppStore } from '../stores/app'

const appStore = useAppStore()

const currentAccountName = computed(() => appStore.currentAccount?.nickname || '未选择账号')

const currentTime = ref('')
let timer: ReturnType<typeof setInterval>

function updateTime() {
  const now = new Date()
  currentTime.value = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

onMounted(() => {
  updateTime()
  timer = setInterval(updateTime, 30000)
})

onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.status-bar {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.status-left,
.status-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #8a96a8;
  padding: 3px 8px;
  background: #f3f6fa;
  border-radius: 6px;
}

.status-chip.active {
  background: #eff6ff;
  color: #3b82f6;
}
</style>
