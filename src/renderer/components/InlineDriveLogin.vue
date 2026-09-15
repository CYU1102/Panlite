<template>
  <div class="inline-login">
    <div class="inline-login__header">
      <div>
        <strong>使用手机扫码登录</strong>
        <p>二维码来自{{ config.label }}官方页面，扫码确认后会自动完成验证。</p>
      </div>
      <div class="inline-login__actions">
        <el-button size="small" @click="reloadPage">刷新二维码</el-button>
        <el-button size="small" :loading="resetting" @click="switchAccount">切换账号</el-button>
        <el-button size="small" @click="emit('fallback')">独立窗口登录</el-button>
      </div>
    </div>

    <div v-if="completed" class="inline-login__success">
      <CheckCircle2 :size="38" />
      <strong>登录成功</strong>
      <span>{{ completed.nickname || `${config.label}用户` }}</span>
    </div>
    <div v-show="!completed" class="inline-login__frame">
      <webview
        ref="webviewRef"
        class="inline-login__webview"
        :src="config.url"
        :partition="config.partition"
        :useragent="config.userAgent"
      />
      <div v-if="status === 'loading'" class="inline-login__overlay">
        <Loader2 :size="26" class="spin" />
        <span>正在加载官方登录页…</span>
      </div>
      <div v-else-if="status === 'error'" class="inline-login__overlay inline-login__overlay--error">
        <CircleAlert :size="26" />
        <span>{{ errorMessage }}</span>
        <el-button size="small" type="primary" @click="reloadPage">重新加载</el-button>
      </div>
    </div>

    <div v-if="!completed && status !== 'error'" class="inline-login__status">
      <Loader2 :size="14" class="spin" />
      <span>{{ status === 'checking' ? '正在验证登录状态…' : '等待扫码确认…' }}</span>
    </div>
    <div class="inline-login__security">
      <ShieldCheck :size="14" />
      <span>官方页面使用隔离会话运行；登录态仅加密保存在本机。</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { CheckCircle2, CircleAlert, Loader2, ShieldCheck } from 'lucide-vue-next'
import { INLINE_LOGIN_CONFIGS, type InlineLoginCredentialResult, type InlineLoginPlatform } from '@shared/inline-login'
import { electronApi } from '../api/ipc'

const props = defineProps<{ platform: InlineLoginPlatform }>()
const emit = defineEmits<{
  success: [result: InlineLoginCredentialResult]
  fallback: []
}>()

const config = computed(() => INLINE_LOGIN_CONFIGS[props.platform])
const webviewRef = ref<any>(null)
const status = ref<'loading' | 'waiting' | 'checking' | 'error'>('loading')
const errorMessage = ref('')
const completed = ref<InlineLoginCredentialResult | null>(null)
const resetting = ref(false)
let pollingTimer: ReturnType<typeof setInterval> | undefined
let checking = false
let disposed = false

function stopPolling() {
  if (pollingTimer) clearInterval(pollingTimer)
  pollingTimer = undefined
}

async function checkLogin() {
  if (checking || disposed || completed.value) return
  const webview = webviewRef.value
  if (!webview || typeof webview.getWebContentsId !== 'function') return

  let webContentsId = 0
  try { webContentsId = webview.getWebContentsId() } catch { return }
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) return

  checking = true
  status.value = 'checking'
  try {
    const result = await electronApi.getInlineLoginStatus({ platform: props.platform, webContentsId })
    if (disposed) return
    if (result.state === 'success' && result.result?.success) {
      completed.value = result.result
      stopPolling()
      emit('success', result.result)
    } else if (result.state === 'error') {
      status.value = 'error'
      errorMessage.value = result.error || '登录页校验失败'
      stopPolling()
    } else {
      status.value = 'waiting'
    }
  } catch (error) {
    if (!disposed) {
      status.value = 'error'
      errorMessage.value = error instanceof Error ? error.message : String(error)
      stopPolling()
    }
  } finally {
    checking = false
  }
}

function startPolling() {
  if (completed.value || pollingTimer) return
  status.value = 'waiting'
  void checkLogin()
  pollingTimer = setInterval(() => void checkLogin(), 2_000)
}

function onLoadFailed(event: Event) {
  const details = event as Event & { errorCode?: number; errorDescription?: string }
  if (details.errorCode === -3) return
  status.value = 'error'
  errorMessage.value = details.errorDescription || '官方登录页加载失败'
  stopPolling()
}

function reloadPage() {
  completed.value = null
  errorMessage.value = ''
  status.value = 'loading'
  stopPolling()
  const webview = webviewRef.value
  try {
    if (typeof webview?.reloadIgnoringCache === 'function') webview.reloadIgnoringCache()
    else if (typeof webview?.reload === 'function') webview.reload()
  } catch {
    status.value = 'error'
    errorMessage.value = '无法刷新官方登录页'
  }
}

async function switchAccount() {
  const webview = webviewRef.value
  let webContentsId = 0
  try { webContentsId = webview?.getWebContentsId?.() || 0 } catch { /* handled below */ }
  if (!webContentsId) {
    status.value = 'error'
    errorMessage.value = '登录页尚未准备好'
    return
  }
  resetting.value = true
  stopPolling()
  try {
    const result = await electronApi.resetInlineLoginSession({ platform: props.platform, webContentsId })
    if (!result.success) throw new Error(result.error || '无法清除登录会话')
    reloadPage()
  } catch (error) {
    status.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    resetting.value = false
  }
}

onMounted(() => {
  const webview = webviewRef.value
  webview?.addEventListener?.('dom-ready', startPolling)
  webview?.addEventListener?.('did-stop-loading', startPolling)
  webview?.addEventListener?.('did-fail-load', onLoadFailed)
})

onBeforeUnmount(() => {
  disposed = true
  stopPolling()
  const webview = webviewRef.value
  webview?.removeEventListener?.('dom-ready', startPolling)
  webview?.removeEventListener?.('did-stop-loading', startPolling)
  webview?.removeEventListener?.('did-fail-load', onLoadFailed)
})
</script>

<style scoped>
.inline-login { display: flex; flex-direction: column; gap: 12px; }
.inline-login__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.inline-login__header strong { color: var(--pl-text); font-size: 14px; }
.inline-login__header p { margin: 4px 0 0; color: var(--pl-text-muted); font-size: 12px; }
.inline-login__actions { display: flex; flex: 0 0 auto; }
.inline-login__frame { position: relative; height: 440px; overflow: hidden; border: 1px solid var(--pl-border); border-radius: 12px; background: #fff; }
.inline-login__webview { width: 100%; height: 100%; border: 0; }
.inline-login__overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #5b6b82; background: rgba(255, 255, 255, 0.94); font-size: 13px; }
.inline-login__overlay--error { color: #dc2626; }
.inline-login__success { min-height: 260px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; border: 1px solid #bbf7d0; border-radius: 12px; color: #16a34a; background: #f0fdf4; }
.inline-login__success span { color: var(--pl-text); font-size: 16px; font-weight: 600; }
.inline-login__status, .inline-login__security { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.inline-login__status { color: #d97706; }
.inline-login__security { color: #16884a; }
.spin { animation: inline-login-spin 1s linear infinite; }
@keyframes inline-login-spin { to { transform: rotate(360deg); } }
</style>
