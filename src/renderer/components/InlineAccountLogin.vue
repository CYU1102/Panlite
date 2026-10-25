<template>
  <section class="inline-login" :aria-label="`${platformName}页内登录`">
    <div class="inline-toolbar">
      <div><strong>{{ platformName }}官方登录</strong><p>在下方扫码或按官方页面提示登录，验证通过后点击“添加账号”。</p></div>
      <el-button v-if="session && !completed" size="small" @click="positionLoginArea">定位登录区</el-button>
      <el-button v-if="session || error" size="small" :disabled="starting" @click="start">刷新二维码</el-button>
    </div>
    <div v-if="!session && !starting && !error" class="inline-placeholder">
      <Monitor :size="32" />
      <el-button type="primary" @click="start">开始登录</el-button>
      <p>登录页面直接显示在此处，二维码有效期以官方页面为准。</p>
    </div>
    <div v-if="session && !completed" ref="frameRef" class="inline-frame" :aria-busy="loading" tabindex="0" aria-label="官方登录页面，可横向和纵向滚动">
      <webview :key="session.id" class="login-webview" :src="session.url" :partition="session.partition"
        @did-start-loading="loading = true" @did-stop-loading="loading = false" @dom-ready="ready"
        @did-fail-load="failed" />
      <span v-if="loading && !error" class="inline-loading" role="status">正在加载官方登录页面…</span>
    </div>
    <p v-if="session && !completed" class="inline-viewport-hint">官方页面保持原尺寸，可滚动查看；找不到二维码时点击“定位登录区”。</p>
    <div v-if="starting" class="inline-placeholder" role="status">正在准备独立登录会话…</div>
    <div v-if="completed" class="inline-success" role="status"><CheckCircle2 :size="24" />{{ completed.nickname || '登录成功' }}，请添加账号</div>
    <div v-if="error" class="inline-error" role="alert"><p>{{ error }}</p><el-button size="small" @click="start">重新加载</el-button></div>
    <p v-if="notice && !error" class="inline-notice" role="status">{{ notice }}</p>
    <div class="inline-footer">
      <span>仅使用本次独立会话，不读取系统浏览器登录状态。</span>
      <el-button v-if="session && !completed" size="small" @click="cancel">取消登录</el-button>
      <el-button size="small" @click="fallback">使用官方登录窗口</el-button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { Monitor, CheckCircle2 } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'
import type { InlineLoginPlatform, InlineLoginResult, InlineLoginSession } from '@shared/inline-login'

const props = defineProps<{ platform: InlineLoginPlatform }>()
const emit = defineEmits<{ result: [result: InlineLoginResult]; fallback: [] }>()
const platformName = computed(() => props.platform === 'quark' ? '夸克网盘' : 'UC网盘')
const session = ref<InlineLoginSession | null>(null)
const completed = ref<InlineLoginResult | null>(null)
const frameRef = ref<HTMLDivElement | null>(null)
const starting = ref(false), loading = ref(false), error = ref(''), notice = ref('')
let version = 0, disposed = false
let timer: ReturnType<typeof setTimeout> | undefined
const polling = new Set<string>()

function clearTimer() { if (timer) clearTimeout(timer); timer = undefined }
async function release(id: string) { try { await electronApi.cancelInlineLogin(id) } catch { /* Main process also clears detached guests and destroyed owners. */ } }
function cancel() {
  version++; clearTimer()
  const old = session.value
  session.value = null; starting.value = false; loading.value = false; completed.value = null; notice.value = ''; error.value = ''
  if (old) void release(old.id)
}
async function start() {
  cancel()
  const attempt = version
  starting.value = true
  emit('result', { success: false })
  try {
    const result = await electronApi.startInlineLogin(props.platform)
    if (disposed || attempt !== version) { if (result.session) void release(result.session.id); return }
    if (!result.success || !result.session) { error.value = result.error || '无法准备登录页面，请重试或使用官方登录窗口'; return }
    session.value = result.session; loading.value = true
  } catch (err) {
    if (!disposed && attempt === version) error.value = err instanceof Error ? err.message : String(err)
  } finally { if (!disposed && attempt === version) starting.value = false }
}
function positionLoginArea() {
  const frame = frameRef.value
  if (!frame) return
  frame.scrollLeft = Math.max(0, frame.scrollWidth - frame.clientWidth)
  const loginBottom = props.platform === 'uc' ? 610 : 400
  frame.scrollTop = Math.max(props.platform === 'uc' ? 160 : 0, loginBottom - frame.clientHeight)
}
function ready() { loading.value = false; positionLoginArea(); if (session.value) { clearTimer(); void poll(version, session.value.id) } }
async function poll(attempt: number, id: string) {
  if (disposed || attempt !== version || session.value?.id !== id || completed.value || error.value) return
  if (polling.has(id)) return
  polling.add(id)
  try {
    const result = await electronApi.getInlineLoginStatus(id)
    if (disposed || attempt !== version || session.value?.id !== id) return
    if (!result.success) { error.value = result.error || '登录会话已关闭，请重新加载'; void release(id); return }
    if (result.state === 'success' && result.cookies) { completed.value = result; emit('result', result); void release(id); return }
    notice.value = result.error || '等待扫码登录；二维码过期时可点击刷新。'
  } catch {
    if (!disposed && attempt === version) notice.value = '暂时无法验证登录，正在重试…'
  } finally { polling.delete(id) }
  if (!disposed && attempt === version && !completed.value && !error.value) timer = setTimeout(() => { void poll(attempt, id) }, 2000)
}
function failed(event: { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }) {
  if (event.errorCode === -3 || event.isMainFrame === false) return
  clearTimer(); loading.value = false; error.value = event.errorDescription || '官方登录页加载失败，请重新加载或使用官方登录窗口'
  if (session.value) void release(session.value.id)
}
function fallback() { cancel(); emit('result', { success: false }); emit('fallback') }
onBeforeUnmount(() => { disposed = true; cancel() })
</script>

<style scoped>
.inline-login { border: 1px solid var(--pl-border); border-radius: 12px; overflow: hidden; background: var(--pl-surface); }
.inline-toolbar, .inline-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 12px 14px; }
.inline-toolbar { border-bottom: 1px solid var(--pl-border); }
.inline-toolbar strong { color: var(--pl-text); font-size: 14px; }
.inline-toolbar p, .inline-footer span, .inline-placeholder p, .inline-notice { color: var(--pl-text-secondary); font-size: 12px; line-height: 1.6; }
.inline-toolbar p { margin: 4px 0 0; }
.inline-frame { height: min(510px, 57vh); min-height: 300px; position: relative; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.inline-frame:focus-visible { outline: 2px solid var(--pl-primary); outline-offset: -2px; }
.login-webview { display: flex; width: 1280px; height: 760px; }
.inline-viewport-hint { margin: 0; padding: 6px 14px; color: var(--pl-text-secondary); font-size: 12px; line-height: 1.6; }
.inline-loading { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); padding: 6px 10px; background: var(--pl-surface); color: var(--pl-text-secondary); font-size: 12px; border-radius: 6px; pointer-events: none; }
.inline-placeholder { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 16px; min-height: 200px; padding: 20px; color: var(--pl-primary); text-align: center; }
.inline-placeholder p, .inline-notice { margin: 0; }
.inline-notice { padding: 8px 14px; }
.inline-success { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 140px; color: var(--pl-primary); }
.inline-error { padding: 12px 14px; color: var(--el-color-danger); overflow-wrap: anywhere; }
.inline-footer { border-top: 1px solid var(--pl-border); }
.inline-footer span { flex: 1; min-width: 180px; }
</style>
