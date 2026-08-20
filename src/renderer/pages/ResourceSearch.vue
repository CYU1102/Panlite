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
          <div>
            <span class="sidebar-kicker">内置搜索</span>
            <div class="sidebar-title-row">
              <span class="sidebar-title">搜索来源</span>
              <span class="source-count">{{ sites.length }}</span>
            </div>
          </div>
          <div class="source-tools">
            <button class="source-tool" title="管理搜索来源" @click="$router.push('/settings')">
              <Settings2 :size="14" />
            </button>
            <button class="source-tool" title="刷新搜索来源" @click="loadSites">
              <RefreshCw :size="14" />
            </button>
          </div>
        </div>
        <div class="sidebar-list">
          <section v-for="group in siteGroups" :key="group.label" class="site-group">
            <div class="site-group-title">
              <span>{{ group.label }}</span>
              <small>{{ group.items.length }}</small>
            </div>
          <div
            v-for="site in group.items"
            :key="site.id"
            class="site-item"
            :class="{ active: activeSite?.id === site.id }"
            @click="selectSite(site)"
          >
            <div class="site-avatar">{{ site.name.slice(0, 1).toUpperCase() }}</div>
            <div class="site-copy">
              <span class="site-name">{{ site.name }}</span>
              <span class="site-platform">{{ site.capabilities.slice(0, 2).join(' · ') || site.platform || '资源网站' }}</span>
            </div>
            <ChevronRight class="site-arrow" :size="15" />
          </div>
          </section>
          <div v-if="sites.length === 0" class="empty-hint">
            <Layers3 :size="28" :stroke-width="1.4" />
            <strong>还没有搜索来源</strong>
            <span>前往设置添加资源站后即可开始浏览</span>
            <el-button size="small" @click="$router.push('/settings')">前往设置</el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 右侧浏览器 -->
    <div class="browser-area">
      <div class="browser-context">
        <div class="context-copy">
          <div class="context-icon"><Search :size="16" /></div>
          <div>
            <span class="context-kicker">资源搜索工作台</span>
            <span class="context-title">{{ activeSite ? activeSite.name : '选择一个搜索来源开始' }}</span>
          </div>
        </div>
        <span v-if="activeSite" class="context-site">
          <span class="online-dot"></span>
          已连接 · {{ activeSite.platform || '网页来源' }}
        </span>
      </div>
      <div class="browser-toolbar">
        <el-button class="nav-button" size="small" @click="goBack" :disabled="!canGoBack" title="后退">
          <ArrowLeft :size="14" />
        </el-button>
        <el-button class="nav-button" size="small" @click="goForward" :disabled="!canGoForward" title="前进">
          <ArrowRight :size="14" />
        </el-button>
        <el-button class="nav-button" size="small" @click="refreshPage" :disabled="!activeSite" title="刷新网页">
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
        <el-button size="small" type="primary" @click="extractLinks" :loading="extracting" :disabled="!activeSite">
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
          @did-start-loading="onStartLoading"
          @did-stop-loading="onStopLoading"
          @did-navigate="onNavigate"
          @did-navigate-in-page="onNavigateInPage"
          @dom-ready="onDomReady"
          @ipc-message="onIpcMessage"
        />
        <div v-else class="welcome">
          <div class="welcome-icon"><Globe :size="38" :stroke-width="1.3" /></div>
          <span class="welcome-kicker">内置资源浏览器</span>
          <h2>选择一个搜索来源</h2>
          <p>在左侧选择资源站，浏览内容后可一键提取并转存网盘链接</p>
          <div class="welcome-features">
            <span><MousePointerClick :size="13" /> 选择来源</span>
            <span><Search :size="13" /> 浏览搜索</span>
            <span><Sparkles :size="13" /> 提取链接</span>
          </div>
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
          <div class="link-index">{{ i + 1 }}</div>
          <div class="link-info">
            <span class="link-title">{{ link.title || '未知资源' }}</span>
            <span class="link-url">{{ link.url }}</span>
            <span v-if="link.password" class="link-pwd">提取码: {{ link.password }}</span>
          </div>
          <div class="link-actions">
            <el-button size="small" type="primary" @click="transferLink(link)">
              <FolderDown :size="14" />
              转存
            </el-button>
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
        <el-button type="success" @click="transferAllLinks" v-if="extractedLinks.length > 0">
          全部转存
        </el-button>
      </template>
    </el-dialog>
    <TransferDialog
      v-model="showTransfer"
      :initial-links="transferLinks"
      :initial-target-dir-id="appStore.currentPath"
      :initial-target-name="appStore.currentPathName"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { RefreshCw, ArrowLeft, ArrowRight, Globe, Link, ExternalLink, Copy, PanelLeftClose, PanelLeftOpen, FolderDown, Search, ChevronRight, Settings2, Layers3, MousePointerClick, Sparkles } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'
import { useAppStore } from '../stores/app'
import TransferDialog from '../components/TransferDialog.vue'
import type { TransferLinkInput } from '@shared/types'

interface Site {
  id: string
  name: string
  url: string
  platform: string
  type: string
  category: string
  riskLevel: 'low' | 'medium' | 'high'
  capabilities: string[]
}

interface ExtractedLink {
  title: string
  url: string
  password?: string
}

const sites = ref<Site[]>([])
const siteGroups = computed(() => {
  const order = ['网盘搜索', '软件与技术资源', '在线工具', '综合导航']
  const groups = new Map<string, Site[]>()
  for (const site of sites.value) {
    const category = site.category || '其他资源'
    const bucket = groups.get(category) || []
    bucket.push(site)
    groups.set(category, bucket)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (order.indexOf(a) < 0 ? 999 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 999 : order.indexOf(b)))
    .map(([label, items]) => ({ label, items }))
})
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
const showTransfer = ref(false)
const transferLinks = ref<TransferLinkInput[]>([])
const appStore = useAppStore()

async function loadSites() {
  try {
    const result = await electronApi.searchSourcesList()
    if (result.success && result.sources) {
      sites.value = (result.sources as any[])
        // API sources may also expose a browsable landing page. Keep them
        // available here until a source-specific browser URL is configured.
        .filter((s: any) => s.url && s.url.startsWith('http'))
        .map((s: any) => ({
          id: s.id,
          name: s.name,
          url: s.url,
          platform: s.platform || '',
          type: s.type,
          category: s.category || '其他资源',
          riskLevel: s.risk_level === 'high' || s.risk_level === 'low' ? s.risk_level : 'medium',
          capabilities: parseCapabilities(s.capabilities),
        }))
    }
  } catch (err) {
    console.error('Failed to load sites:', err)
  }
}

function parseCapabilities(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
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

function onIpcMessage(event: { channel: string; args: unknown[] }) {
  if (event.channel !== 'extracted-links') return
  const links = event.args[0]
  if (!Array.isArray(links)) return
  extractedLinks.value = links as ExtractedLink[]
  showExtractedLinks.value = true
  extracting.value = false
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

function transferLink(link: ExtractedLink) {
  transferLinks.value = [{ url: link.url, password: link.password }]
  showExtractedLinks.value = false
  showTransfer.value = true
}

function transferAllLinks() {
  transferLinks.value = extractedLinks.value.map((link) => ({
    url: link.url,
    password: link.password,
  }))
  showExtractedLinks.value = false
  showTransfer.value = true
}

onMounted(() => {
  loadSites()
})
</script>

<style scoped>
.resource-browser {
  height: 100%;
  display: flex;
  background: var(--pl-surface);
  border: 1px solid var(--pl-border);
  border-radius: var(--pl-radius-card);
  overflow: hidden;
  box-shadow: var(--pl-shadow-card);
}

.sidebar {
  width: 258px;
  background: var(--pl-surface-subtle);
  border-right: 1px solid var(--pl-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width 0.2s ease;
}

.sidebar.collapsed { width: 42px; }

.sidebar-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  cursor: pointer;
  color: var(--pl-text-muted);
  border-bottom: 1px solid var(--pl-border);
  flex-shrink: 0;
  transition: background 0.2s, color 0.2s;
}

.sidebar-toggle:hover { background: var(--pl-primary-soft); color: var(--pl-primary); }

.sidebar-content { display: flex; flex-direction: column; flex: 1; min-height: 0; }

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 14px 13px;
  border-bottom: 1px solid var(--pl-border);
}

.sidebar-kicker {
  display: block;
  margin-bottom: 3px;
  color: var(--pl-text-muted);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.sidebar-title-row,
.source-tools,
.context-copy,
.welcome-features,
.empty-hint {
  display: flex;
  align-items: center;
}

.sidebar-title-row { gap: 7px; }
.sidebar-title { font-size: 15px; font-weight: 700; color: var(--pl-text); }
.source-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  color: var(--pl-primary-hover);
  background: var(--pl-primary-soft);
  font-size: 11px;
  font-weight: 700;
}

.source-tools { gap: 4px; }
.source-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--pl-text-muted);
  background: transparent;
  cursor: pointer;
  transition: all 0.16s ease;
}
.source-tool:hover {
  border-color: #cbd9f5;
  color: var(--pl-primary-hover);
  background: var(--pl-primary-soft);
  transform: translateY(-1px);
}

.sidebar-list { flex: 1; overflow-y: auto; padding: 10px; }

.site-group { margin-bottom: 14px; }
.site-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 7px 6px;
  color: var(--pl-text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.site-group-title small {
  min-width: 18px;
  padding: 2px 5px;
  border-radius: 9px;
  color: var(--pl-primary-hover);
  background: var(--pl-primary-soft);
  font-size: 10px;
  text-align: center;
}

.site-item {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  min-height: 56px;
  padding: 8px 9px;
  border: 1px solid transparent;
  border-radius: 11px;
  cursor: pointer;
  transition: transform 0.18s ease, background 0.18s ease, color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
  margin-bottom: 6px;
  color: var(--pl-text-secondary);
}

.site-item:hover {
  transform: translateX(2px);
  border-color: #d5e1f7;
  background: #f8fbff;
  color: var(--pl-primary-hover);
}

.site-item.active {
  border-color: #b9cdfa;
  background: var(--pl-primary-soft);
  color: var(--pl-primary-hover);
  box-shadow: 0 5px 14px rgba(52, 120, 246, 0.1);
}
.site-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 10px;
  color: var(--pl-primary);
  background: #edf3ff;
  font-size: 13px;
  font-weight: 750;
}
.site-item.active .site-avatar {
  color: #fff;
  background: var(--pl-primary);
}
.site-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.site-name { font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site-platform { font-size: 10px; color: var(--pl-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site-arrow { flex-shrink: 0; color: #c0c8d4; transition: transform 0.16s ease, color 0.16s ease; }
.site-item:hover .site-arrow,
.site-item.active .site-arrow { transform: translateX(2px); color: var(--pl-primary); }
.empty-hint {
  flex-direction: column;
  gap: 9px;
  margin: 8px 2px;
  padding: 28px 14px;
  border: 1px dashed var(--pl-border-strong);
  border-radius: 12px;
  text-align: center;
  font-size: 12px;
  line-height: 1.6;
  color: var(--pl-text-muted);
}
.empty-hint strong { color: var(--pl-text); font-size: 13px; }

.browser-area { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--pl-page-bg); }

.browser-context {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  background: var(--pl-surface);
}

.context-copy { gap: 10px; }
.context-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  color: var(--pl-primary);
  background: var(--pl-primary-soft);
}
.context-kicker { display: block; font-size: 10px; color: var(--pl-text-muted); font-weight: 650; letter-spacing: 0.06em; }
.context-title { display: block; margin-top: 2px; font-size: 15px; font-weight: 700; color: var(--pl-text); }
.context-site {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 40%;
  padding: 5px 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 8px;
  font-size: 11px;
  color: var(--pl-text-secondary);
  background: #f3f6fa;
}
.online-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--pl-success); box-shadow: 0 0 0 3px rgba(22, 160, 133, 0.12); }

.browser-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  background: var(--pl-surface);
  border-top: 1px solid var(--pl-border);
  border-bottom: 1px solid var(--pl-border);
}

.nav-button { margin-left: 0 !important; }
.nav-button:hover:not(.is-disabled) { color: var(--pl-primary-hover); background: var(--pl-primary-soft); border-color: #c9d9f8; }

.url-bar { flex: 1; min-width: 80px; }
.webview-container { flex: 1; position: relative; min-height: 0; background: var(--pl-surface); }
.webview { width: 100%; height: 100%; border: none; }

.welcome { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 10px; padding: 32px; color: var(--pl-primary); text-align: center; }
.welcome-icon { display: flex; align-items: center; justify-content: center; width: 78px; height: 78px; margin-bottom: 4px; border-radius: 24px; background: linear-gradient(145deg, #e7f0ff, #f4f8ff); box-shadow: inset 0 0 0 1px #dbe7fb; }
.welcome-kicker { color: var(--pl-primary); font-size: 11px; font-weight: 700; letter-spacing: 0.08em; }
.welcome h2 { font-size: 20px; color: var(--pl-text); margin: 0; }
.welcome p { max-width: 420px; font-size: 13px; color: var(--pl-text-secondary); margin: 0; line-height: 1.65; }
.welcome-features { gap: 8px; margin-top: 8px; flex-wrap: wrap; justify-content: center; }
.welcome-features span { display: inline-flex; align-items: center; gap: 5px; padding: 5px 9px; border: 1px solid var(--pl-border); border-radius: 8px; color: var(--pl-text-secondary); background: var(--pl-surface); font-size: 11px; }

.no-links { padding: 44px 24px; text-align: center; color: var(--pl-text-muted); }
.links-list { max-height: 400px; overflow-y: auto; padding-right: 2px; }
.link-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px; border: 1px solid var(--pl-border); border-radius: 11px; margin-bottom: 8px; background: var(--pl-surface-subtle); transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease; }
.link-item:hover { transform: translateY(-1px); border-color: #bed0f4; background: var(--pl-surface); box-shadow: 0 7px 18px rgba(31, 41, 55, 0.07); }
.link-index { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px; flex-shrink: 0; border-radius: 8px; color: var(--pl-primary); background: var(--pl-primary-soft); font-size: 11px; font-weight: 700; }
.link-info { flex: 1; min-width: 0; }
.link-title { display: block; font-size: 14px; font-weight: 600; color: var(--pl-text); margin-bottom: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-url { display: block; font-size: 12px; color: var(--pl-text-secondary); margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-pwd { font-size: 12px; color: var(--pl-primary); background: var(--pl-primary-soft); padding: 3px 7px; border-radius: 6px; }
.link-actions { display: flex; gap: 4px; flex-shrink: 0; margin-left: 8px; }

@media (max-width: 900px) {
  .sidebar { width: 190px; }
  .browser-context { padding-inline: 12px; }
  .browser-toolbar { gap: 5px; padding-inline: 10px; }
  .context-site { max-width: 34%; }
}

@media (max-width: 700px) {
  .sidebar { width: 168px; }
  .context-title { font-size: 13px; }
  .context-site { display: none; }
  .browser-toolbar { flex-wrap: wrap; }
  .url-bar { order: 2; flex-basis: 100%; }
  .browser-toolbar > .el-button:last-child { margin-left: auto; }
}
</style>
