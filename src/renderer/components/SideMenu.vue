<template>
  <nav class="side-nav" :class="{ collapsed }" aria-label="功能导航">
    <div class="nav-main">
      <section v-for="group in menuGroups" :key="group.id" class="nav-group" :aria-label="group.label">
        <button v-if="!collapsed" class="nav-group-label" type="button" :aria-expanded="!closedGroups[group.id]" :aria-controls="`nav-${group.id}`" @click="toggleGroup(group.id)">
          <span>{{ group.label }}</span>
          <ChevronDown :size="13" :class="{ 'is-closed': closedGroups[group.id] }" />
        </button>
        <div v-else class="nav-group-divider" />
        <div v-show="collapsed || !closedGroups[group.id]" :id="`nav-${group.id}`">
          <el-tooltip v-for="item in group.items" :key="item.path" :content="item.label" placement="right" :disabled="!collapsed" :show-after="200">
            <RouterLink :to="item.path" class="nav-item" :class="{ active: activeMenu === item.path }" :aria-label="item.label" :aria-current="activeMenu === item.path ? 'page' : undefined">
              <component :is="item.icon" :size="18" :stroke-width="1.8" class="nav-item-icon" aria-hidden="true" />
              <span v-if="!collapsed" class="nav-item-text">{{ item.label }}</span>
            </RouterLink>
          </el-tooltip>
        </div>
      </section>
    </div>
    <section class="nav-management" aria-label="管理">
      <span v-if="!collapsed" class="management-label">管理</span>
      <el-tooltip v-for="item in managementItems" :key="item.path" :content="item.label" placement="right" :disabled="!collapsed" :show-after="200">
        <RouterLink :to="item.path" class="nav-item" :class="{ active: activeMenu === item.path }" :aria-label="item.label" :aria-current="activeMenu === item.path ? 'page' : undefined">
          <component :is="item.icon" :size="18" :stroke-width="1.8" class="nav-item-icon" aria-hidden="true" />
          <span v-if="!collapsed" class="nav-item-text">{{ item.label }}</span>
        </RouterLink>
      </el-tooltip>
    </section>
  </nav>
</template>

<script setup lang="ts">
import { computed, markRaw, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import {
  FolderOpen, Library, ArchiveRestore, Download, ClipboardList,
  ClipboardCheck, Users, Settings, Share2, ArrowDownToLine, Search,
  BarChart3, ArrowRightLeft, Sparkles, Workflow, ShieldCheck, ChevronDown,
} from 'lucide-vue-next'

defineProps<{ collapsed: boolean }>()
const route = useRoute()
const activeMenu = computed(() => route.path)
const groupPreferenceKey = 'panlite:nav-closed-groups'
function readGroupPreferences(): Record<string, boolean> {
  const defaults = { transfers: true }
  try {
    const saved = JSON.parse(localStorage.getItem(groupPreferenceKey) || '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaults
    return { ...defaults, ...Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'boolean')) } as Record<string, boolean>
  } catch { return defaults }
}
const closedGroups = ref(readGroupPreferences())
const menuGroups = [
  { id: 'files', label: '文件', items: [
    { path: '/files', label: '文件管理', icon: markRaw(FolderOpen) },
    { path: '/file-catalog', label: '统一目录', icon: markRaw(Library) },
    { path: '/file-backups', label: '文件版本备份', icon: markRaw(ArchiveRestore) },
    { path: '/storage-analysis', label: '空间分析', icon: markRaw(BarChart3) },
    { path: '/dashboard', label: '存储空间', icon: markRaw(BarChart3) },
  ] },
  { id: 'ai', label: 'AI 控制台', items: [
    { path: '/ai-workspace', label: 'AI 工作台', icon: markRaw(Sparkles) },
  ] },
  { id: 'transfers', label: '传输与分享', items: [
    { path: '/tasks', label: '任务中心', icon: markRaw(ClipboardList) },
    { path: '/batch-transfer', label: '批量转存', icon: markRaw(ArrowDownToLine) },
    { path: '/cloud-transfer', label: '云端迁移', icon: markRaw(ArrowRightLeft) },
    { path: '/batch-share', label: '批量分享', icon: markRaw(Share2) },
    { path: '/share-links', label: '分享管理', icon: markRaw(Share2) },
    { path: '/transfer-plans', label: '迁移计划', icon: markRaw(ClipboardCheck) },
    { path: '/automation-rules', label: '自动化规则', icon: markRaw(Workflow) },
    { path: '/transfer-records', label: '转存记录', icon: markRaw(ArrowDownToLine) },
  ] },
  { id: 'search', label: '搜索', items: [
    { path: '/resource-search', label: '资源搜索', icon: markRaw(Search) },
    { path: '/global-search', label: '全局搜索', icon: markRaw(Search) },
  ] },
]
const managementItems = [
  { path: '/accounts', label: '账号管理', icon: markRaw(Users) },
  { path: '/backup-restore', label: '备份恢复', icon: markRaw(Download) },
  { path: '/security', label: '安全中心', icon: markRaw(ShieldCheck) },
  { path: '/settings', label: '设置', icon: markRaw(Settings) },
]
function persistGroups() {
  try { localStorage.setItem(groupPreferenceKey, JSON.stringify(closedGroups.value)) } catch { /* 本次会话仍可使用 */ }
}
function toggleGroup(id: string) {
  closedGroups.value[id] = !closedGroups.value[id]
  persistGroups()
}
watch(() => route.path, (path) => {
  const group = menuGroups.find(item => item.items.some(entry => entry.path === path))
  if (group && closedGroups.value[group.id]) {
    closedGroups.value[group.id] = false
    persistGroups()
  }
}, { immediate: true })
</script>

<style scoped>
.side-nav { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.nav-main { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 10px 12px; scrollbar-gutter: stable; }
.nav-group { margin-bottom: 8px; }
.nav-group-label { width: 100%; display: flex; justify-content: space-between; align-items: center; padding: 9px 12px 5px; border: 0; background: transparent; color: var(--pl-text-muted); font: inherit; font-size: var(--pl-font-xs); font-weight: 600; cursor: pointer; }
.nav-group-label:hover { color: var(--pl-text-secondary); }
.nav-group-label svg { transition: transform .15s ease; }
.nav-group-label .is-closed { transform: rotate(-90deg); }
.nav-item { display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 12px; margin: 3px 0; border-radius: var(--pl-radius-control); text-decoration: none; color: var(--pl-text-secondary); transition: background .15s ease, color .15s ease; position: relative; }
.nav-item:hover { background: var(--pl-hover); color: var(--pl-text); }
.nav-item.active { background: var(--pl-primary-soft); color: var(--pl-primary); font-weight: 600; }
.nav-item-icon { flex-shrink: 0; }
.nav-item-text { font-size: var(--pl-font-sm); white-space: nowrap; }
.nav-management { flex-shrink: 0; padding: 8px 10px; border-top: 1px solid var(--pl-border); }
.management-label { display: block; color: var(--pl-text-muted); font-size: var(--pl-font-xs); font-weight: 600; padding: 3px 12px 5px; }
.collapsed .nav-main { padding: 8px 10px; scrollbar-gutter: auto; }
.collapsed .nav-item { justify-content: center; padding: 0; height: 36px; }
.collapsed .nav-group { margin-bottom: 7px; }
.nav-group-divider { width: 20px; height: 1px; margin: 7px auto; background: var(--pl-border); }
.collapsed .nav-group:first-child .nav-group-divider { display: none; }
.collapsed .nav-management { padding: 6px 10px; }
@media (max-height: 700px) {
  .nav-item { height: 32px; }
  .nav-management { padding-top: 4px; padding-bottom: 4px; }
  .management-label { display: none; }
}
</style>
