<template>
  <div class="app-shell">
    <!-- Left sidebar -->
    <aside class="sidebar">
      <div class="sidebar-logo">
        <div class="logo-icon">P</div>
        <div class="logo-copy">
          <span class="logo-text">PanLite</span>
          <span class="logo-caption">你的网盘工作台</span>
        </div>
      </div>
      <SideMenu />
    </aside>

    <!-- Right area -->
    <div class="main-area">
      <!-- 文件管理页专属工具栏；其他页面使用自己的页面级操作区 -->
      <header v-if="showTopBar" class="topbar-wrapper">
        <TopBar />
      </header>

      <!-- Content -->
      <main class="content-area">
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
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElNotification } from 'element-plus'
import TopBar from './components/TopBar.vue'
import SideMenu from './components/SideMenu.vue'
import StatusBar from './components/StatusBar.vue'
import AppLockOverlay from './components/AppLockOverlay.vue'
import { electronApi } from './api/ipc'
import { useAppStore } from './stores/app'

const router = useRouter()
const appStore = useAppStore()
const showTopBar = computed(() => router.currentRoute.value.path === '/files')
let unsubscribeNavigate: (() => void) | undefined
let unsubscribeClipboard: (() => void) | undefined

onMounted(() => {
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

/* ── Element Plus overrides ── */
.el-button {
  font-weight: 500;
  border-radius: var(--pl-radius-control);
  --el-button-hover-text-color: var(--pl-primary-hover);
}
.el-button--primary {
  --el-button-bg-color: var(--pl-primary);
  --el-button-border-color: var(--pl-primary);
  --el-button-hover-bg-color: var(--pl-primary-hover);
  --el-button-hover-border-color: var(--pl-primary-hover);
  --el-button-active-bg-color: #1d4ed8;
}
.el-input__wrapper {
  border-radius: var(--pl-radius-control);
  box-shadow: 0 0 0 1px var(--pl-border) inset;
  transition: box-shadow 0.15s ease, background 0.15s ease;
}
.el-input__wrapper:hover,
.el-input__wrapper.is-focus {
  box-shadow: 0 0 0 1px rgba(52, 120, 246, 0.45) inset, 0 0 0 3px rgba(52, 120, 246, 0.09);
}
.el-dialog {
  border-radius: 18px;
  overflow: hidden;
}
.el-message-box {
  border-radius: 16px;
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
  width: 232px;
  min-width: 232px;
  background: linear-gradient(180deg, var(--pl-sidebar-bg), var(--pl-sidebar-raised));
  border-right: 1px solid var(--pl-sidebar-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-logo {
  height: 82px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px;
  border-bottom: 1px solid var(--pl-sidebar-border);
  flex-shrink: 0;
}

.logo-icon {
  width: 40px;
  height: 40px;
  background: linear-gradient(145deg, var(--pl-primary), var(--pl-primary-hover));
  border-radius: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 700;
  font-size: 18px;
  flex-shrink: 0;
  box-shadow: 0 7px 16px color-mix(in srgb, var(--pl-primary) 24%, transparent);
}

.logo-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.logo-text {
  font-size: 18px;
  font-weight: 750;
  color: var(--pl-sidebar-text);
  letter-spacing: -0.3px;
}

.logo-caption {
  color: var(--pl-sidebar-muted);
  font-size: 11px;
  letter-spacing: 0.2px;
}

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
  padding: 26px clamp(18px, 2.3vw, 36px) 22px;
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
    width: 208px;
    min-width: 208px;
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
    width: 184px;
    min-width: 184px;
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
  .sidebar { width: 76px; min-width: 76px; }
  .sidebar-logo { justify-content: center; padding: 0; }
  .logo-copy { display: none; }
  .content-area { padding: 12px; }
}

@media (max-height: 700px) {
  .sidebar-logo { height: 58px; }
  .topbar-wrapper { height: 58px; min-height: 58px; }
  .content-area { padding-top: 12px; padding-bottom: 12px; }
  .statusbar-wrapper { height: 28px; min-height: 28px; }
}
</style>
