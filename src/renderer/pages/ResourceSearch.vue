<template>
  <div class="resource-browser">
    <!-- 左侧资源站列表 -->
    <div class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-toggle" @click="sidebarCollapsed = !sidebarCollapsed">
        <PanelLeftClose :size="16" v-if="!sidebarCollapsed" />
        <PanelLeftOpen :size="16" v-else />
      </div>
      <div v-show="!sidebarCollapsed" class="sidebar-content">
        <div class="sidebar-header">
          <span class="sidebar-title">📚 资源站</span>
          <el-button link size="small" @click="loadSites">
            <RefreshCw :size="14" />
          </el-button>
        </div>
        <div class="sidebar-list">
          <div
            v-for="site in sites"
            :key="site.id"
            class="site-item"
            :class="{ active: activeSite?.id === site.id }"
            @click="selectSite(site)"
          >
            <span class="site-name">{{ site.name }}</span>
            <span class="site-platform">{{ site.platform }}</span>
          </div>
          <div v-if="sites.length === 0" class="empty-hint">
            暂无资源站，请在设置中添加
          </div>
        </div>
      </div>
    </div>

    <!-- 右侧浏览器 -->
    <div class="browser-area">
      <div class="browser-toolbar">
        <el-button size="small" @click="goBack" :disabled="!canGoBack">
          <ArrowLeft :size="14" />
        </el-button>
        <el-button size="small" @click="goForward" :disabled="!canGoForward">
          <ArrowRight :size="14" />
        </el-button>
        <el-button size="small" @click="refreshPage">
          <RefreshCw :size="14" />
        </el-button>
        <div class="url-bar">
          <el-input
            v-model="currentUrl"
            size="small"
            readonly
            placeholder="选择左侧资源站开始浏览"
          />
        </div>
        <el-button size="small" type="primary" @click="extractLinks" :loading="extracting">
          <Link :size="14" style="margin-right: 4px" />
          提取链接
        </el-button>
      </div>

      <!-- WebView 容器 -->
      <div class="webview-container" v-loading="loading">
        <webview
          v-if="activeSite"
          ref="webviewRef"
          :src="activeSite.url"
          class="webview"
          :preload="preloadScript"
          @did-start-loading="onStartLoading"
          @did-stop-loading="onStopLoading"
          @did-navigate="onNavigate"
          @did-navigate-in-page="onNavigateInPage"
          @dom-ready="onDomReady"
          @console-message="onConsoleMessage"
        />
        <div v-else class="welcome">
          <Globe :size="64" :stroke-width="1" />
          <h2>资源浏览器</h2>
          <p>从左侧选择一个资源站开始浏览</p>
        </div>
      </div>
    </div>

    <!-- 提取的链接弹窗 -->
    <el-dialog v-model="showExtractedLinks" title="提取的网盘链接" width="600px">
      <div v-if="extractedLinks.length === 0" class="no-links">
        未找到网盘链接
      </div>
      <div v-else class="links-list">
        <div v-for="(link, i) in extractedLinks" :key="i" class="link-item">
          <div class="link-info">
            <span class="link-title">{{ link.title || '未知资源' }}</span>
            <span class="link-url">{{ link.url }}</span>
            <span v-if="link.password" class="link-pwd">提取码: {{ link.password }}</span>
          </div>
          <div class="link-actions">
            <el-button size="small" @click="openLink(link.url)">
              <ExternalLink :size="14" />
            </el-button>
            <el-button size="small" @click="copyLink(link.url)">
              <Copy :size="14" />
            </el-button>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="showExtractedLinks = false">关闭</el-button>
        <el-button type="primary" @click="copyAllLinks" v-if="extractedLinks.length > 0">
          复制全部链接
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { RefreshCw, ArrowLeft, ArrowRight, Globe, Link, ExternalLink, Copy, PanelLeftClose, PanelLeftOpen } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'

interface Site {
  id: string
  name: string
  url: string
  platform: string
}

interface ExtractedLink {
  title: string
  url: string
  password?: string
}

const sites = ref<Site[]>([])
const activeSite = ref<Site | null>(null)
const currentUrl = ref('')
const loading = ref(false)
const extracting = ref(false)
const canGoBack = ref(false)
const canGoForward = ref(false)
const webviewRef = ref<any>(null)
const showExtractedLinks = ref(false)
const extractedLinks = ref<ExtractedLink[]>([])
const sidebarCollapsed = ref(false)

// 预加载脚本：从页面提取网盘链接
const preloadScript = 'file://' + (window as any).__dirname + '/preload-extract.js'

async function loadSites() {
  try {
    const result = await electronApi.searchSourcesList()
    if (result.success && result.sources) {
      sites.value = (result.sources as any[])
        .filter((s: any) => s.url && s.url.startsWith('http'))
        .map((s: any) => ({
          id: s.id,
          name: s.name,
          url: s.url,
          platform: s.platform || '',
        }))
    }
  } catch (err) {
    console.error('Failed to load sites:', err)
  }
}

function selectSite(site: Site) {
  activeSite.value = site
  currentUrl.value = site.url
}

function onStartLoading() {
  loading.value = true
}

function onStopLoading() {
  loading.value = false
  updateNavState()
}

function onNavigate(event: any) {
  currentUrl.value = event.url
  updateNavState()
}

function onNavigateInPage(event: any) {
  currentUrl.value = event.url
  updateNavState()
}

function onDomReady() {
  updateNavState()
}

function onConsoleMessage(event: any) {
  // 接收预加载脚本发来的消息
  try {
    const msg = JSON.parse(event.message)
    if (msg.type === 'extracted-links') {
      extractedLinks.value = msg.links
      showExtractedLinks.value = true
      extracting.value = false
    }
  } catch {}
}

function updateNavState() {
  const wv = webviewRef.value
  if (wv) {
    canGoBack.value = wv.canGoBack()
    canGoForward.value = wv.canGoForward()
  }
}

function goBack() {
  webviewRef.value?.goBack()
}

function goForward() {
  webviewRef.value?.goForward()
}

function refreshPage() {
  webviewRef.value?.reload()
}

function extractLinks() {
  extracting.value = true
  // 向 webview 发送消息，请求提取链接
  webviewRef.value?.send('extract-links')
}

function openLink(url: string) {
  electronApi.openExternal(url)
}

function copyLink(url: string) {
  navigator.clipboard.writeText(url)
  ElMessage.success('已复制链接')
}

function copyAllLinks() {
  const text = extractedLinks.value.map(l => {
    const pwd = l.password ? ` 提取码:${l.password}` : ''
    return `${l.title}\n${l.url}${pwd}`
  }).join('\n\n')
  navigator.clipboard.writeText(text)
  ElMessage.success(`已复制 ${extractedLinks.value.length} 个链接`)
}

onMounted(() => {
  loadSites()
})
</script>

<style scoped>
.resource-browser {
  height: 100%;
  display: flex;
  gap: 0;
  background: #f5f7fa;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #e5e7eb;
}

/* ── 左侧边栏 ── */
.sidebar {
  width: 220px;
  background: #ffffff;
  border-right: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width 0.3s ease;
  position: relative;
}

.sidebar.collapsed {
  width: 40px;
}

.sidebar-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 36px;
  cursor: pointer;
  color: #6b7280;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
  transition: all 0.2s;
}

.sidebar-toggle:hover {
  background: #f3f4f6;
  color: #1f2937;
}

.sidebar-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;
}

.sidebar-title {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
}

.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.site-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: 4px;
}

.site-item:hover {
  background: #eff6ff;
}

.site-item.active {
  background: #3b82f6;
  color: #ffffff;
}

.site-item.active .site-platform {
  color: rgba(255, 255, 255, 0.7);
}

.site-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.site-platform {
  font-size: 11px;
  color: #9ca3af;
  margin-left: 8px;
}

.empty-hint {
  padding: 20px;
  text-align: center;
  font-size: 12px;
  color: #9ca3af;
}

/* ── 右侧浏览器 ── */
.browser-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.browser-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #ffffff;
  border-bottom: 1px solid #e5e7eb;
}

.url-bar {
  flex: 1;
}

.webview-container {
  flex: 1;
  position: relative;
  min-height: 0;
}

.webview {
  width: 100%;
  height: 100%;
  border: none;
}

.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
  color: #d1d5db;
}

.welcome h2 {
  font-size: 20px;
  color: #6b7280;
  margin: 0;
}

.welcome p {
  font-size: 14px;
  color: #9ca3af;
}

/* ── 提取的链接弹窗 ── */
.no-links {
  padding: 40px;
  text-align: center;
  color: #9ca3af;
}

.links-list {
  max-height: 400px;
  overflow-y: auto;
}

.link-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  margin-bottom: 8px;
}

.link-info {
  flex: 1;
  min-width: 0;
}

.link-title {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: #1f2937;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-url {
  display: block;
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-pwd {
  font-size: 12px;
  color: #3b82f6;
  background: #eff6ff;
  padding: 2px 6px;
  border-radius: 4px;
}

.link-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  margin-left: 8px;
}
</style>
