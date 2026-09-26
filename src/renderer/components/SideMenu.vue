<template>
  <nav class="side-nav">
    <div v-for="group in menuGroups" :key="group.label" class="nav-group">
      <div class="nav-group-label">{{ group.label }}</div>
      <button
        v-for="item in group.items"
        :key="item.path"
        type="button"
        class="nav-item"
        :class="{ active: activeMenu === item.path }"
        :aria-current="activeMenu === item.path ? 'page' : undefined"
        :title="item.label"
        @click="onSelect(item.path)"
      >
        <div class="nav-item-icon">
          <component :is="item.icon" :size="18" :stroke-width="1.8" />
        </div>
        <span class="nav-item-text">{{ item.label }}</span>
      </button>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { computed, markRaw } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  FolderOpen,
  Library,
  ArchiveRestore,
  Download,
  ClipboardList,
  ClipboardCheck,
  Users,
  Settings,
  Share2,
  ArrowDownToLine,
  Search,
  BarChart3,
  ArrowRightLeft,
  Sparkles,
  Workflow,
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()

const activeMenu = computed(() => route.path)

const menuGroups = [
  {
    label: '文件',
    items: [
      { path: '/files', label: '文件管理', icon: markRaw(FolderOpen) },
      { path: '/file-catalog', label: '统一文件目录', icon: markRaw(Library) },
      { path: '/file-backups', label: '文件版本备份', icon: markRaw(ArchiveRestore) },
      { path: '/storage-analysis', label: '空间分析', icon: markRaw(BarChart3) },
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
      { path: '/transfer-plans', label: '迁移计划', icon: markRaw(ClipboardCheck) },
      { path: '/automation-rules', label: '自动化规则', icon: markRaw(Workflow) },
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
  padding: 14px 10px 24px;
}

.nav-group {
  margin-bottom: 14px;
}

.nav-group + .nav-group {
  padding-top: 9px;
  border-top: 1px solid var(--pl-border);
}

.nav-group-label {
  padding: 10px 12px 7px;
  font-size: 11px;
  font-weight: 700;
  color: var(--pl-text-muted);
  letter-spacing: 0.9px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 0 12px;
  margin: 2px 0;
  height: 39px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  cursor: pointer;
  color: var(--pl-text-secondary);
  font: inherit;
  text-align: left;
  transition: background 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
  position: relative;
}

.nav-item:hover {
  background: var(--pl-hover);
  color: var(--pl-text);
}

.nav-item.active {
  background: var(--pl-primary-soft);
  color: var(--pl-primary-hover);
  font-weight: 700;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--pl-primary) 12%, transparent);
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
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
  .side-nav { padding: 8px 10px 18px; }
  .nav-group { margin-bottom: 5px; }
  .nav-group-label { height: 8px; padding: 0; overflow: hidden; color: transparent; }
  .nav-item { justify-content: center; width: 48px; margin: 3px auto; padding: 0; }
  .nav-item-text { display: none; }
  .nav-item.active::before { left: 0; }
}
</style>
