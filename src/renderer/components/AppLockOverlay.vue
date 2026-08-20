<template>
  <transition name="lock-fade">
    <div v-if="enabled && locked" class="lock-screen">
      <div class="lock-card">
        <div class="lock-icon"><LockKeyhole :size="28" /></div>
        <h2>PanLite 已锁定</h2>
        <p>输入应用密码以继续使用</p>
        <el-input
          ref="passwordInput"
          v-model="password"
          type="password"
          show-password
          placeholder="应用密码"
          :disabled="submitting"
          @keyup.enter="unlock"
        />
        <div v-if="error" class="error-text">{{ error }}</div>
        <el-button type="primary" :loading="submitting" :disabled="!password" @click="unlock">
          解锁
        </el-button>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { LockKeyhole } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'

const enabled = ref(false)
const locked = ref(false)
const password = ref('')
const error = ref('')
const submitting = ref(false)
const passwordInput = ref<{ focus: () => void }>()
let unsubscribe: (() => void) | undefined
let lastTouch = 0

function applyState(state: unknown): void {
  const value = state as { enabled?: boolean; locked?: boolean }
  enabled.value = Boolean(value?.enabled)
  locked.value = Boolean(value?.locked)
  if (locked.value) nextTick(() => passwordInput.value?.focus())
}

async function unlock(): Promise<void> {
  if (!password.value || submitting.value) return
  submitting.value = true
  error.value = ''
  try {
    const result = await electronApi.unlockApp(password.value)
    if (!result.success) throw new Error(result.error || '密码错误')
    password.value = ''
    applyState(result)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    password.value = ''
    nextTick(() => passwordInput.value?.focus())
  } finally {
    submitting.value = false
  }
}

function recordActivity(): void {
  const now = Date.now()
  if (!enabled.value || locked.value || now - lastTouch < 15_000) return
  lastTouch = now
  void electronApi.touchAppLock()
}

onMounted(async () => {
  const result = await electronApi.getAppLockStatus()
  if (result.success) applyState(result)
  unsubscribe = electronApi.onAppLockChanged(applyState)
  for (const eventName of ['pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(eventName, recordActivity, { passive: true })
  }
})

onBeforeUnmount(() => {
  unsubscribe?.()
  for (const eventName of ['pointerdown', 'keydown', 'wheel']) {
    window.removeEventListener(eventName, recordActivity)
  }
})
</script>

<style scoped>
.lock-screen { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; background: rgba(238, 243, 250, .96); backdrop-filter: blur(18px); }
.lock-card { width: min(390px, calc(100vw - 40px)); display: flex; flex-direction: column; gap: 16px; padding: 34px; background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: 22px; box-shadow: 0 24px 70px rgba(31, 41, 55, .18); text-align: center; }
.lock-icon { width: 58px; height: 58px; display: grid; place-items: center; margin: 0 auto; color: var(--pl-primary); background: var(--pl-primary-soft); border-radius: 18px; }
.lock-card h2 { color: var(--pl-text); font-size: 19px; }
.lock-card p { color: var(--pl-text-secondary); font-size: 13px; }
.error-text { color: var(--pl-danger); font-size: 12px; }
.lock-fade-enter-active, .lock-fade-leave-active { transition: opacity .18s ease; }
.lock-fade-enter-from, .lock-fade-leave-to { opacity: 0; }
</style>
