<template>
  <div class="status-bar">
    <div class="status-left">
      <div v-if="isFilePage" class="status-chip account-chip" :title="currentAccountName">
        <User :size="12" />
        <span>{{ currentAccountName }}</span>
      </div>
      <div v-if="isFilePage" class="status-chip path-chip" :title="appStore.currentPathName">
        <Folder :size="12" />
        <span>{{ appStore.currentPathName }}</span>
      </div>
      <div v-else class="status-chip page-chip">
        <LayoutGrid :size="12" />
        <span>{{ pageLabel }}</span>
      </div>
      <div v-if="isFilePage && appStore.selectedCount > 0" class="status-chip active" role="status">
        <CheckCircle2 :size="12" />
        <span>已选 {{ appStore.selectedCount }} 项</span>
      </div>
    </div>
    <div class="status-right">
      <div class="status-chip clock-chip" :title="currentDate">
        <Clock :size="12" />
        <span>{{ currentTime }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { User, Folder, CheckCircle2, Clock, LayoutGrid } from 'lucide-vue-next'
import { useRoute } from 'vue-router'
import { useAppStore } from '../stores/app'

const appStore = useAppStore()
const route = useRoute()
const isFilePage = computed(() => route.path === '/files')
const pageLabels: Record<string, string> = {
  '/accounts': '账号管理', '/file-catalog': '统一目录', '/storage-analysis': '空间分析',
  '/file-backups': '文件版本备份', '/automation-rules': '自动化规则', '/tasks': '任务中心',
  '/share-links': '分享管理', '/transfer-records': '转存记录', '/batch-transfer': '批量转存',
  '/cloud-transfer': '云端迁移', '/transfer-plans': '迁移计划', '/batch-share': '批量分享',
  '/resource-search': '资源搜索', '/global-search': '全局搜索', '/ai-workspace': 'AI 控制台',
  '/backup-restore': '备份恢复', '/security': '安全中心', '/dashboard': '存储空间', '/settings': '设置',
}
const pageLabel = computed(() => pageLabels[route.path] || 'PanLite')

const currentAccountName = computed(() => appStore.currentAccount?.nickname || '未选择账号')

const currentTime = ref('')
const currentDate = ref('')
let timer: ReturnType<typeof setInterval>

function updateTime() {
  const now = new Date()
  currentTime.value = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  currentDate.value = now.toLocaleDateString('zh-CN')
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
  min-width: 0;
}

.status-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--pl-font-xs);
  color: var(--pl-text-secondary);
  padding: 3px 8px;
  background: var(--pl-hover);
  border-radius: 6px;
  min-width: 0;
  white-space: nowrap;
}

.status-chip svg { flex-shrink: 0; }
.status-chip span { overflow: hidden; text-overflow: ellipsis; }
.account-chip { max-width: 180px; }
.path-chip { max-width: min(40vw, 400px); }
.status-right { flex-shrink: 0; padding-left: 8px; }
.clock-chip { font-variant-numeric: tabular-nums; background: transparent; color: var(--pl-text-muted); }

.status-chip.active {
  background: var(--pl-primary-soft);
  color: var(--pl-primary);
}
</style>
