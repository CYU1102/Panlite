<template>
  <section class="share-browser" aria-label="分享链接浏览">
    <div class="browser-toolbar">
      <button class="browser-button return-button" @click="emit('close')"><ArrowLeft :size="16" />返回列表</button>
      <div class="navigation-buttons">
        <button class="browser-button" aria-label="后退" title="后退" :disabled="!canGoBack" @click="navigate('back')"><ChevronLeft :size="16" /></button>
        <button class="browser-button" aria-label="前进" title="前进" :disabled="!canGoForward" @click="navigate('forward')"><ChevronRight :size="16" /></button>
        <button class="browser-button" aria-label="刷新分享页面" title="刷新分享页面" @click="reload"><RefreshCw :size="16" :class="{ spinning: loading }" /></button>
      </div>
      <div class="page-address"><strong>{{ title || '分享内容' }}</strong><span :title="currentUrl">{{ currentUrl }}</span></div>
      <span v-if="password" class="extraction-code">提取码：<strong>{{ password }}</strong></span>
      <button class="browser-button" @click="emit('copy')"><Copy :size="15" />复制链接{{ password ? '和提取码' : '' }}</button>
    </div>
    <div class="browser-content" :aria-busy="loading">
      <webview
        :key="reloadKey"
        ref="webviewRef"
        class="share-webview"
        :src="url"
        :partition="SHARE_BROWSER_PARTITION"
        allowpopups
        @did-start-loading="onStartLoading"
        @did-stop-loading="onStopLoading"
        @did-fail-load="onFailLoad"
        @did-navigate="onNavigate"
        @did-navigate-in-page="onNavigate"
        @dom-ready="onDomReady"
      />
      <div v-if="loading && !loadError" class="loading-indicator" role="status">正在加载分享页面…</div>
      <div v-if="loadError" class="browser-error" role="alert"><strong>分享页面加载失败</strong><p>{{ loadError }}</p><button class="browser-button" @click="reload">重新加载</button></div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { WebviewTag } from 'electron'
import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw, Copy } from 'lucide-vue-next'
import { SHARE_BROWSER_PARTITION, getShareBrowserUrl } from '@shared/share-browser'

const props = defineProps<{ url: string; title?: string | null; password?: string | null }>()
const emit = defineEmits<{ close: []; copy: [] }>()
const webviewRef = ref<WebviewTag | null>(null)
const currentUrl = ref(props.url)
const loading = ref(true)
const loadError = ref('')
const ready = ref(false)
const reloadKey = ref(0)
const canGoBack = ref(false)
const canGoForward = ref(false)

function updateNavigation() {
  if (!ready.value || !webviewRef.value) return
  try {
    canGoBack.value = webviewRef.value.canGoBack()
    canGoForward.value = webviewRef.value.canGoForward()
  } catch { /* Guest may be detached while returning to the list. */ }
}
function onStartLoading() { loading.value = true; loadError.value = '' }
function onStopLoading() { loading.value = false; updateNavigation() }
function onDomReady() { ready.value = true; updateNavigation() }
function onNavigate(event: { url: string }) {
  const target = getShareBrowserUrl(event.url)
  if (target) currentUrl.value = target
  updateNavigation()
}
function onFailLoad(event: { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }) {
  if (event.errorCode === -3 || event.isMainFrame === false) return
  loading.value = false
  loadError.value = event.errorDescription || '页面暂时不可用，请重试'
}
function navigate(direction: 'back' | 'forward') {
  if (!ready.value || !webviewRef.value) return
  try {
    if (direction === 'back' && canGoBack.value) webviewRef.value.goBack()
    if (direction === 'forward' && canGoForward.value) webviewRef.value.goForward()
  } catch { loadError.value = '页面导航失败，请重新加载' }
}
function reload() {
  loadError.value = ''; loading.value = true
  if (ready.value && webviewRef.value) {
    try { webviewRef.value.reload(); return } catch { /* Recreate a detached guest. */ }
  }
  ready.value = false
  canGoBack.value = false; canGoForward.value = false
  currentUrl.value = props.url
  reloadKey.value++
}
</script>

<style scoped>
.share-browser { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); background: var(--pl-surface); }
.browser-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--pl-border); }
.browser-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 6px 9px; border: 1px solid var(--pl-border); border-radius: var(--pl-radius-control); background: var(--pl-surface); color: var(--pl-text-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.browser-button:hover:not(:disabled) { color: var(--pl-primary); background: var(--pl-primary-soft); }
.browser-button:focus-visible { outline: 2px solid var(--pl-primary); outline-offset: 2px; }
.browser-button:disabled { opacity: .45; cursor: default; }
.return-button { color: var(--pl-primary); }
.navigation-buttons { display: flex; gap: 4px; }
.page-address { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 140px; overflow: hidden; }
.page-address strong, .page-address span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.page-address strong { color: var(--pl-text); font-size: 13px; }
.page-address span { color: var(--pl-text-secondary); font-size: 12px; }
.extraction-code { color: var(--pl-text-secondary); font-size: 12px; }
.extraction-code strong { color: var(--pl-text); }
.browser-content { position: relative; flex: 1; min-height: 0; }
.share-webview { display: flex; width: 100%; height: 100%; }
.loading-indicator { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); padding: 8px 14px; border: 1px solid var(--pl-border); border-radius: 8px; background: var(--pl-surface); color: var(--pl-text-secondary); font-size: 13px; pointer-events: none; }
.browser-error { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 20px; background: var(--pl-surface); color: var(--pl-text); text-align: center; }
.browser-error p { color: var(--pl-text-secondary); overflow-wrap: anywhere; }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 760px) { .page-address { flex-basis: 100%; order: 1; } }
@media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
</style>
