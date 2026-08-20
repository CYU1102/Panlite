<template>
  <nav class="side-nav">
    <div v-for="group in menuGroups" :key="group.label" class="nav-group">
      <div class="nav-group-label">{{ group.label }}</div>
      <div
        v-for="item in group.items"
        :key="item.path"
        class="nav-item"
        :class="{ active: activeMenu === item.path }"
        @click="onSelect(item.path)"
      >
        <div class="nav-item-icon">
          <component :is="item.icon" :size="18" :stroke-width="1.8" />
        </div>
        <span class="nav-item-text">{{ item.label }}</span>
      </div>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { computed, markRaw } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  FolderOpen,
  Download,
  ClipboardList,
  Users,
  Settings,
  Share2,
  ArrowDownToLine,
  Search,
  BarChart3,
  ArrowRightLeft,
  Sparkles,
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()

const activeMenu = computed(() => route.path)

const menuGroups = [
  {
    label: '文件',
    items: [
      { path: '/files', label: '文件管理', icon: markRaw(FolderOpen) },
    ],
  },
  {
    label: '工具',
    items: [
      { path: '/resource-search', label: '资源搜索', icon: markRaw(Search) },
      { path: '/global-search', label: '全局搜索', icon: markRaw(Search) },
      { path: '/batch-share', label: '批量分享', icon: markRaw(Share2) },
      { path: '/batch-transfer', label: '批量转存', icon: markRaw(ArrowDownToLine) },
      { path: '/cloud-transfer', label: '云端迁移', icon: markRaw(ArrowRightLeft) },
      { path: '/share-links', label: '分享链接', icon: markRaw(Share2) },
      { path: '/transfer-records', label: '转存记录', icon: markRaw(ArrowDownToLine) },
      { path: '/tasks', label: '任务日志', icon: markRaw(ClipboardList) },
    ],
  },
  {
    label: 'AI',
    items: [
      { path: '/ai-workspace', label: 'AI 工作台', icon: markRaw(Sparkles) },
    ],
  },
  {
    label: '系统',
    items: [
      { path: '/dashboard', label: '存储空间', icon: markRaw(BarChart3) },
      { path: '/accounts', label: '账号管理', icon: markRaw(Users) },
      { path: '/backup-restore', label: '备份恢复', icon: markRaw(Download) },
      { path: '/security', label: '安全中心', icon: markRaw(Settings) },
      { path: '/settings', label: '设置', icon: markRaw(Settings) },
    ],
  },
]

function onSelect(path: string) {
  router.push(path)
}
</script>

<style scoped>
.side-nav {
  flex: 1;
  overflow-y: auto;
  padding: 14px 0 18px;
}

.nav-group {
  margin-bottom: 10px;
}

.nav-group-label {
  padding: 10px 22px 7px;
  font-size: 10px;
  font-weight: 600;
  color: var(--pl-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 13px;
  margin: 3px 10px;
  height: 40px;
  border-radius: 10px;
  cursor: pointer;
  color: var(--pl-text-secondary);
  transition: all 0.15s ease;
  position: relative;
}

.nav-item:hover {
  background: #f1f5fb;
  color: var(--pl-text);
}

.nav-item.active {
  background: linear-gradient(90deg, var(--pl-primary-soft) 0%, #f2f6ff 100%);
  color: var(--pl-primary-hover);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px rgba(52, 120, 246, 0.08);
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: -10px;
  top: 9px;
  bottom: 9px;
  width: 3px;
  background: var(--pl-primary);
  border-radius: 0 4px 4px 0;
}

.nav-item-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  flex-shrink: 0;
}

.nav-item-text {
  font-size: 13px;
  white-space: nowrap;
}

@media (max-width: 820px) {
  .side-nav { padding-top: 8px; }
  .nav-group { margin-bottom: 5px; }
  .nav-group-label { height: 8px; padding: 0; overflow: hidden; color: transparent; }
  .nav-item { justify-content: center; width: 48px; margin: 3px auto; padding: 0; }
  .nav-item-text { display: none; }
  .nav-item.active::before { left: -14px; }
}
</style>
