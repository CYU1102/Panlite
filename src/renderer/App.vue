<template>
  <div class="app-shell">
    <!-- Left sidebar -->
    <aside class="sidebar">
      <div class="sidebar-logo">
        <div class="logo-icon">P</div>
        <span class="logo-text">PanLite</span>
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
import TopBar from './components/TopBar.vue'
import SideMenu from './components/SideMenu.vue'
import StatusBar from './components/StatusBar.vue'
import AppLockOverlay from './components/AppLockOverlay.vue'
import { electronApi } from './api/ipc'

const router = useRouter()
const showTopBar = computed(() => router.currentRoute.value.path === '/files')
let unsubscribeNavigate: (() => void) | undefined

onMounted(() => {
  unsubscribeNavigate = electronApi.onAppNavigate((path) => {
    if (typeof path === 'string' && path.startsWith('/')) void router.push(path)
  })
})

onBeforeUnmount(() => unsubscribeNavigate?.())
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
  background: #d1d5db;
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
  background: #9ca3af;
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
  width: 220px;
  min-width: 220px;
  background: var(--pl-surface-subtle);
  border-right: 1px solid var(--pl-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-logo {
  height: 72px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 22px;
  border-bottom: 1px solid var(--pl-border);
  flex-shrink: 0;
}

.logo-icon {
  width: 34px;
  height: 34px;
  background: linear-gradient(145deg, #3478f6, #5865e9);
  border-radius: 11px;
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
  color: #1f2937;
  letter-spacing: 0.5px;
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
  background: rgba(255, 255, 255, 0.98);
  border-bottom: 1px solid var(--pl-border);
  box-shadow: 0 2px 10px rgba(31, 41, 55, 0.035);
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
  padding: 22px 24px 18px;
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
  .sidebar { width: 76px; min-width: 76px; }
  .sidebar-logo { justify-content: center; padding: 0; }
  .logo-text { display: none; }
  .content-area { padding: 12px; }
}

@media (max-height: 700px) {
  .sidebar-logo { height: 58px; }
  .topbar-wrapper { height: 58px; min-height: 58px; }
  .content-area { padding-top: 12px; padding-bottom: 12px; }
  .statusbar-wrapper { height: 28px; min-height: 28px; }
}
</style>
