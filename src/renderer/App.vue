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
      <!-- Top bar -->
      <header class="topbar-wrapper">
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
  </div>
</template>

<script setup lang="ts">
import TopBar from './components/TopBar.vue'
import SideMenu from './components/SideMenu.vue'
import StatusBar from './components/StatusBar.vue'
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
  color: #1f2937;
  background: #f6f8fb;
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
  border-radius: 8px;
}
.el-button--primary {
  --el-button-bg-color: #3b82f6;
  --el-button-border-color: #3b82f6;
  --el-button-hover-bg-color: #2563eb;
  --el-button-hover-border-color: #2563eb;
}
.el-input__wrapper {
  border-radius: 8px;
}
.el-dialog {
  border-radius: 16px;
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
  width: 210px;
  min-width: 210px;
  background: #ffffff;
  border-right: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-logo {
  height: 64px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 20px;
  border-bottom: 1px solid #f3f4f6;
  flex-shrink: 0;
}

.logo-icon {
  width: 32px;
  height: 32px;
  background: linear-gradient(135deg, #3b82f6, #6366f1);
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
  font-size: 18px;
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
  height: 64px;
  min-height: 64px;
  background: #ffffff;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  padding: 0 24px;
  flex-shrink: 0;
}

.content-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 20px;
  background: #f6f8fb;
}

.statusbar-wrapper {
  height: 36px;
  min-height: 36px;
  background: #ffffff;
  border-top: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  padding: 0 20px;
  flex-shrink: 0;
}
</style>
