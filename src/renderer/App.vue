<template>
  <div class="app-shell" :class="{ 'is-collapsed': sidebarCollapsed }">
    <!-- Left sidebar -->
    <aside class="sidebar" aria-label="应用导航">
      <div class="sidebar-logo">
        <div class="logo-icon">P</div>
        <span class="logo-text">PanLite</span>
      </div>
      <SideMenu :collapsed="sidebarCollapsed" />
      <div class="sidebar-actions">
        <el-tooltip :content="themeActionLabel" placement="right" :disabled="!sidebarCollapsed">
          <button class="shell-action theme-action" type="button" :aria-label="themeActionLabel" @click="appStore.toggleTheme()">
            <component :is="appStore.theme === 'dark' ? Sun : Moon" :size="17" />
            <span v-if="!sidebarCollapsed">{{ appStore.theme === 'dark' ? '浅色外观' : '深色外观' }}</span>
          </button>
        </el-tooltip>
        <el-tooltip :content="compactViewport ? '窄窗口自动收起导航' : collapseActionLabel" placement="right">
          <button class="shell-action collapse-action" type="button" :aria-label="collapseActionLabel" :aria-expanded="!sidebarCollapsed" :disabled="compactViewport" @click="toggleSidebar">
            <component :is="sidebarCollapsed ? PanelLeftOpen : PanelLeftClose" :size="17" />
          </button>
        </el-tooltip>
      </div>
    </aside>

    <!-- Right area -->
    <div class="main-area">
      <!-- 文件管理页专属工具栏；其他页面使用自己的页面级操作区 -->
      <header v-if="showTopBar" class="topbar-wrapper">
        <TopBar />
      </header>

      <!-- Content -->
      <main id="main-content" class="content-area" aria-label="页面内容">
        <router-view />
      </main>

      <!-- Status bar -->
      <footer class="statusbar-wrapper">
        <StatusBar />
      </footer>
    </div>
    <AppLockOverlay />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElNotification } from 'element-plus'
import { Moon, Sun, PanelLeftOpen, PanelLeftClose } from 'lucide-vue-next'
import TopBar from './components/TopBar.vue'
import SideMenu from './components/SideMenu.vue'
import StatusBar from './components/StatusBar.vue'
import AppLockOverlay from './components/AppLockOverlay.vue'
import { electronApi } from './api/ipc'
import { useAppStore } from './stores/app'

const router = useRouter()
const appStore = useAppStore()
const showTopBar = computed(() => router.currentRoute.value.path === '/files')
const sidebarPreferenceKey = 'panlite:sidebar-collapsed'
function readSidebarPreference() {
  try { return localStorage.getItem(sidebarPreferenceKey) === 'true' } catch { return false }
}
const manuallyCollapsed = ref(readSidebarPreference())
const compactMedia = window.matchMedia('(max-width: 820px)')
const compactViewport = ref(compactMedia.matches)
const sidebarCollapsed = computed(() => manuallyCollapsed.value || compactViewport.value)
const collapseActionLabel = computed(() => sidebarCollapsed.value ? '展开导航' : '收起导航')
const themeActionLabel = computed(() => appStore.theme === 'dark' ? '切换至浅色外观' : '切换至深色外观')
function toggleSidebar() {
  manuallyCollapsed.value = !manuallyCollapsed.value
  try { localStorage.setItem(sidebarPreferenceKey, String(manuallyCollapsed.value)) } catch { /* 本次会话仍可使用 */ }
}
function updateCompactViewport(event: MediaQueryListEvent) { compactViewport.value = event.matches }
let unsubscribeNavigate: (() => void) | undefined
let unsubscribeClipboard: (() => void) | undefined

onMounted(() => {
  compactMedia.addEventListener('change', updateCompactViewport)
  void appStore.loadTheme()
  unsubscribeNavigate = electronApi.onAppNavigate((path) => {
    if (typeof path === 'string' && path.startsWith('/')) void router.push(path)
  })
  unsubscribeClipboard = electronApi.onClipboardShareDetected((payload) => {
    if (!payload?.links?.length) return
    const first = payload.links[0]
    const extra = payload.links.length > 1 ? ` 等 ${payload.links.length} 条链接` : ''
    ElNotification({
      title: '检测到网盘分享链接',
      message: `${first.url}${extra}，点击前往批量转存`,
      type: 'info',
      duration: 8000,
      onClick: () => {
        ElNotification.closeAll()
        void router.push({ path: '/batch-transfer', query: { share: payload.text } })
      },
    })
  })
})

onBeforeUnmount(() => {
  compactMedia.removeEventListener('change', updateCompactViewport)
  unsubscribeNavigate?.()
  unsubscribeClipboard?.()
})
</script>

<style>
/* ── Reset & Global ── */
*,
*::before,
*::after {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #app {
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  color: var(--pl-text);
  background: var(--pl-page-bg);
  -webkit-font-smoothing: antialiased;
}

/* ── Scrollbar ── */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: var(--pl-border);
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--pl-text-muted);
}

</style>

<style scoped>
/* ── Shell layout ── */
.app-shell {
  display: flex;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}

/* ── Sidebar ── */
.sidebar {
  width: 216px;
  min-width: 216px;
  background: var(--pl-surface-subtle);
  border-right: 1px solid var(--pl-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-logo {
  height: 68px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 20px;
  border-bottom: 1px solid var(--pl-border);
  flex-shrink: 0;
}

.logo-icon {
  width: 34px;
  height: 34px;
  background: var(--pl-primary);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 700;
  font-size: 16px;
  flex-shrink: 0;
}

.logo-text {
  font-size: 17px;
  font-weight: 700;
  color: var(--pl-text);
  letter-spacing: -0.3px;
}

.sidebar-actions { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--pl-border); flex-shrink: 0; }
.shell-action { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 34px; border: 0; border-radius: var(--pl-radius-control); background: transparent; color: var(--pl-text-secondary); cursor: pointer; font: inherit; font-size: var(--pl-font-xs); }
.shell-action:hover { background: var(--pl-hover); color: var(--pl-text); }
.shell-action:disabled { opacity: .4; cursor: default; }
.theme-action { flex: 1; justify-content: flex-start; padding: 0 8px; }
.collapse-action { width: 34px; flex-shrink: 0; }
.is-collapsed .sidebar { width: 72px; min-width: 72px; }
.is-collapsed .sidebar-logo { justify-content: center; padding: 0; }
.is-collapsed .logo-text { display: none; }
.is-collapsed .sidebar-actions { flex-direction: column; padding: 8px; }
.is-collapsed .theme-action { flex: none; width: 36px; justify-content: center; padding: 0; }

/* ── Main area ── */
.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.topbar-wrapper {
  height: 72px;
  min-height: 72px;
  background: var(--pl-surface);
  border-bottom: 1px solid var(--pl-border);
  display: flex;
  align-items: center;
  padding: 0 26px;
  flex-shrink: 0;
}

.content-area {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: var(--pl-space-6) var(--pl-space-6) var(--pl-space-4);
  background: var(--pl-page-bg);
}

.content-area > * {
  min-width: 0;
  min-height: 0;
}

.statusbar-wrapper {
  height: 34px;
  min-height: 34px;
  background: var(--pl-surface-subtle);
  border-top: 1px solid var(--pl-border);
  display: flex;
  align-items: center;
  padding: 0 22px;
  flex-shrink: 0;
}

@media (max-width: 1100px) {
  .sidebar {
    width: 196px;
    min-width: 196px;
  }

  .topbar-wrapper {
    padding: 0 18px;
  }

  .content-area {
    padding: 18px;
  }
}

@media (max-width: 960px) {
  .sidebar {
    width: 176px;
    min-width: 176px;
  }

  .topbar-wrapper {
    height: 68px;
    min-height: 68px;
    padding: 0 14px;
  }

  .content-area {
    padding: 14px;
  }
}

@media (max-width: 820px) {
  .content-area { padding: 12px; }
}

@media (max-height: 700px) {
  .sidebar-logo { height: 58px; }
  .topbar-wrapper { height: 58px; min-height: 58px; }
  .content-area { padding-top: 12px; padding-bottom: 12px; }
  .statusbar-wrapper { height: 28px; min-height: 28px; }
}

@media (max-width: 720px) {
  .topbar-wrapper { height: auto; min-height: 88px; padding: 8px 12px; }
}
</style>
