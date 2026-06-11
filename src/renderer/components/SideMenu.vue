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
      { path: '/batch-share', label: '批量分享', icon: markRaw(Share2) },
      { path: '/batch-transfer', label: '批量转存', icon: markRaw(ArrowDownToLine) },
      { path: '/share-links', label: '分享链接', icon: markRaw(Share2) },
      { path: '/transfer-records', label: '转存记录', icon: markRaw(ArrowDownToLine) },
      { path: '/tasks', label: '任务日志', icon: markRaw(ClipboardList) },
    ],
  },
  {
    label: '系统',
    items: [
      { path: '/dashboard', label: '存储空间', icon: markRaw(BarChart3) },
      { path: '/accounts', label: '账号管理', icon: markRaw(Users) },
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
  padding: 8px 0;
}

.nav-group {
  margin-bottom: 4px;
}

.nav-group-label {
  padding: 12px 20px 6px;
  font-size: 11px;
  font-weight: 600;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  margin: 2px 8px;
  height: 38px;
  border-radius: 8px;
  cursor: pointer;
  color: #6b7280;
  transition: all 0.15s ease;
  position: relative;
}

.nav-item:hover {
  background: #f3f4f6;
  color: #374151;
}

.nav-item.active {
  background: #eff6ff;
  color: #3b82f6;
  font-weight: 500;
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: -8px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  background: #3b82f6;
  border-radius: 0 3px 3px 0;
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
</style>
