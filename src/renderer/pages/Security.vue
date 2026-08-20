<template>
  <div class="security-page">
    <div class="page-header">
      <div class="header-info">
        <div class="header-icon"><ShieldCheck :size="21" :stroke-width="1.6" /></div>
        <div>
          <h2>安全中心</h2>
          <p>管理应用锁、自动锁定与本地凭据保护</p>
        </div>
      </div>
      <el-tag :type="statusTag.type" effect="light">{{ statusTag.label }}</el-tag>
    </div>

    <el-alert
      v-if="!bridgeAvailable"
      title="安全模块尚未接入主进程"
      description="页面已准备好；注册 appLock IPC 与 preload 桥接后即可启用设置。"
      type="warning"
      :closable="false"
      show-icon
    />

    <div class="security-sections" v-loading="loading">
      <section class="security-card">
        <div class="card-header">
          <div class="card-icon"><LockKeyhole :size="17" /></div>
          <div>
            <h3>应用锁</h3>
            <p>离开设备时阻止他人访问网盘账号和任务记录</p>
          </div>
        </div>
        <div class="card-body">
          <div class="setting-row">
            <div class="setting-label">
              <span class="label-text">锁定状态</span>
              <span class="label-hint">{{ statusDescription }}</span>
            </div>
            <div class="row-actions">
              <el-button
                v-if="!lockState.enabled"
                type="primary"
                :disabled="!bridgeAvailable"
                @click="openEnableDialog"
              >设置应用锁</el-button>
              <template v-else>
                <el-button :disabled="!bridgeAvailable || lockState.status !== 'unlocked'" @click="lockNow">
                  <Lock :size="14" />立即锁定
                </el-button>
                <el-button type="primary" :disabled="!bridgeAvailable" @click="changeDialogVisible = true">修改密码</el-button>
              </template>
            </div>
          </div>

          <div v-if="lockState.enabled" class="setting-row">
            <div class="setting-label">
              <span class="label-text">关闭应用锁</span>
              <span class="label-hint">关闭后不会删除保险箱中已加密的凭据</span>
            </div>
            <el-button type="danger" plain :disabled="!bridgeAvailable" @click="disableDialogVisible = true">关闭应用锁</el-button>
          </div>
        </div>
      </section>

      <section class="security-card">
        <div class="card-header">
          <div class="card-icon"><TimerReset :size="17" /></div>
          <div>
            <h3>自动锁定</h3>
            <p>在一段时间没有操作后自动回到锁定界面</p>
          </div>
        </div>
        <div class="card-body">
          <div class="setting-row">
            <div class="setting-label">
              <span class="label-text">无操作锁定时间</span>
              <span class="label-hint">用户活动由主进程统一更新，避免只依赖当前页面</span>
            </div>
            <el-select
              v-model="selectedAutoLockMs"
              class="timeout-select"
              :disabled="!bridgeAvailable || !lockState.enabled || savingAutoLock"
              @change="saveAutoLock"
            >
              <el-option v-for="option in autoLockOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </div>
        </div>
      </section>

      <section class="security-card">
        <div class="card-header">
          <div class="card-icon"><Vault :size="17" /></div>
          <div>
            <h3>凭据保险箱</h3>
            <p>Cookie、Token 与密码使用带版本的认证加密 envelope 保存</p>
          </div>
        </div>
        <div class="vault-summary">
          <div class="summary-item">
            <span>加密算法</span>
            <strong>AES-256-GCM</strong>
          </div>
          <div class="summary-item">
            <span>数据完整性</span>
            <strong>已认证</strong>
          </div>
          <div class="summary-item">
            <span>日志保护</span>
            <strong>敏感字段脱敏</strong>
          </div>
        </div>
        <div class="security-note">
          <CircleCheck :size="15" />
          <span>保险箱 API 不接受日志对象，也不会记录密钥、明文或解密后的凭据。</span>
        </div>
      </section>
    </div>

    <el-dialog v-model="enableDialogVisible" title="设置应用锁" width="440px" destroy-on-close>
      <el-form label-position="top" @submit.prevent="enableLock">
        <el-form-item label="新密码">
          <el-input v-model="enableForm.password" type="password" show-password autocomplete="new-password" placeholder="至少 8 个字符" />
        </el-form-item>
        <el-form-item label="确认密码">
          <el-input v-model="enableForm.confirmPassword" type="password" show-password autocomplete="new-password" />
        </el-form-item>
        <el-form-item label="自动锁定">
          <el-select v-model="enableForm.autoLockMs" style="width: 100%">
            <el-option v-for="option in autoLockOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="enableDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="enableLock">启用应用锁</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="changeDialogVisible" title="修改应用锁密码" width="440px" destroy-on-close @closed="resetChangeForm">
      <el-form label-position="top" @submit.prevent="changePassword">
        <el-form-item label="当前密码">
          <el-input v-model="changeForm.currentPassword" type="password" show-password autocomplete="current-password" />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="changeForm.newPassword" type="password" show-password autocomplete="new-password" placeholder="至少 8 个字符" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="changeForm.confirmPassword" type="password" show-password autocomplete="new-password" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="changeDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="changePassword">修改并锁定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="disableDialogVisible" title="关闭应用锁" width="420px" destroy-on-close @closed="disablePassword = ''">
      <el-alert title="关闭后，启动应用将不再要求解锁。" type="warning" :closable="false" show-icon />
      <el-input
        v-model="disablePassword"
        class="confirm-password"
        type="password"
        show-password
        autocomplete="current-password"
        placeholder="输入当前密码确认"
        @keyup.enter="disableLock"
      />
      <template #footer>
        <el-button @click="disableDialogVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="disableLock">确认关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { CircleCheck, Lock, LockKeyhole, ShieldCheck, TimerReset, Vault } from 'lucide-vue-next'

type LockStatus = 'disabled' | 'locked' | 'unlocked' | 'cooldown'

interface LockState {
  enabled: boolean
  status: LockStatus
  autoLockMs: number
  retryAfterMs?: number
  reason?: string | null
}

interface SecurityBridge {
  appLockGetState?: () => Promise<LockState | { success: boolean; data?: LockState; error?: string }>
  appLockConfigure?: (password: string, autoLockMs: number) => Promise<unknown>
  appLockChangePassword?: (currentPassword: string, newPassword: string) => Promise<unknown>
  appLockDisable?: (password: string) => Promise<unknown>
  appLockSetAutoLock?: (autoLockMs: number) => Promise<unknown>
  appLockLock?: () => Promise<unknown>
}

const autoLockOptions = [
  { label: '不自动锁定', value: 0 },
  { label: '1 分钟', value: 60_000 },
  { label: '5 分钟', value: 5 * 60_000 },
  { label: '15 分钟', value: 15 * 60_000 },
  { label: '30 分钟', value: 30 * 60_000 },
  { label: '1 小时', value: 60 * 60_000 },
]

const bridge = (window as unknown as { electronAPI?: SecurityBridge }).electronAPI
const bridgeAvailable = computed(() => Boolean(
  bridge?.appLockGetState &&
  bridge.appLockConfigure &&
  bridge.appLockChangePassword &&
  bridge.appLockDisable &&
  bridge.appLockSetAutoLock &&
  bridge.appLockLock,
))
const loading = ref(false)
const submitting = ref(false)
const savingAutoLock = ref(false)
const lockState = reactive<LockState>({ enabled: false, status: 'disabled', autoLockMs: 5 * 60_000 })
const selectedAutoLockMs = ref(lockState.autoLockMs)
const enableDialogVisible = ref(false)
const changeDialogVisible = ref(false)
const disableDialogVisible = ref(false)
const disablePassword = ref('')
const enableForm = reactive({ password: '', confirmPassword: '', autoLockMs: 5 * 60_000 })
const changeForm = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' })

const statusTag = computed<{ label: string; type: 'info' | 'success' | 'warning' | 'danger' }>(() => {
  if (!bridgeAvailable.value) return { label: '待接线', type: 'warning' }
  if (!lockState.enabled) return { label: '未启用', type: 'info' }
  if (lockState.status === 'unlocked') return { label: '已解锁', type: 'success' }
  if (lockState.status === 'cooldown') return { label: '暂时锁定', type: 'danger' }
  return { label: '已锁定', type: 'warning' }
})

const statusDescription = computed(() => {
  if (!lockState.enabled) return '应用启动后直接进入主界面'
  if (lockState.status === 'unlocked') return '当前会话已解锁，可随时手动锁定'
  if (lockState.status === 'cooldown') return `密码尝试过多，请在 ${Math.ceil((lockState.retryAfterMs ?? 0) / 1000)} 秒后重试`
  return lockState.reason === 'idle' ? '因长时间无操作已自动锁定' : '需要输入应用锁密码才能继续'
})

function assertPassword(password: string, confirmation: string): boolean {
  if (password.length < 8) {
    ElMessage.warning('密码至少需要 8 个字符')
    return false
  }
  if (password !== confirmation) {
    ElMessage.warning('两次输入的密码不一致')
    return false
  }
  return true
}

async function invoke(operation: (() => Promise<unknown>) | undefined): Promise<void> {
  if (!operation) throw new Error('安全模块尚未接入主进程')
  const result = await operation()
  if (result && typeof result === 'object' && 'success' in result && !(result as { success: boolean }).success) {
    throw new Error(String((result as { error?: string }).error || '操作失败'))
  }
}

async function loadState(): Promise<void> {
  if (!bridge?.appLockGetState) return
  loading.value = true
  try {
    const result = await bridge.appLockGetState()
    let state: LockState | undefined
    if (result && typeof result === 'object' && 'success' in result) {
      const response = result as { success: boolean; data?: LockState; error?: string }
      if (!response.success) throw new Error(response.error || '读取应用锁状态失败')
      // Main process returns the snapshot alongside success; older builds used data.
      state = response.data || response as unknown as LockState
    } else {
      state = result as LockState
    }
    if (!state) throw new Error('未返回应用锁状态')
    Object.assign(lockState, state)
    selectedAutoLockMs.value = state.autoLockMs
  } catch (error) {
    ElMessage.error(`读取安全设置失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loading.value = false
  }
}

function openEnableDialog(): void {
  enableForm.password = ''
  enableForm.confirmPassword = ''
  enableForm.autoLockMs = 5 * 60_000
  enableDialogVisible.value = true
}

async function enableLock(): Promise<void> {
  if (!assertPassword(enableForm.password, enableForm.confirmPassword)) return
  submitting.value = true
  try {
    await invoke(() => bridge!.appLockConfigure!(enableForm.password, enableForm.autoLockMs))
    enableForm.password = ''
    enableForm.confirmPassword = ''
    enableDialogVisible.value = false
    ElMessage.success('应用锁已启用')
    await loadState()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    submitting.value = false
  }
}

function resetChangeForm(): void {
  changeForm.currentPassword = ''
  changeForm.newPassword = ''
  changeForm.confirmPassword = ''
}

async function changePassword(): Promise<void> {
  if (!changeForm.currentPassword) {
    ElMessage.warning('请输入当前密码')
    return
  }
  if (!assertPassword(changeForm.newPassword, changeForm.confirmPassword)) return
  submitting.value = true
  try {
    await invoke(() => bridge!.appLockChangePassword!(changeForm.currentPassword, changeForm.newPassword))
    changeDialogVisible.value = false
    resetChangeForm()
    ElMessage.success('密码已修改，应用现已锁定')
    await loadState()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    submitting.value = false
  }
}

async function disableLock(): Promise<void> {
  if (!disablePassword.value) {
    ElMessage.warning('请输入当前密码')
    return
  }
  submitting.value = true
  try {
    await invoke(() => bridge!.appLockDisable!(disablePassword.value))
    disablePassword.value = ''
    disableDialogVisible.value = false
    ElMessage.success('应用锁已关闭')
    await loadState()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    submitting.value = false
  }
}

async function saveAutoLock(value: number): Promise<void> {
  const previous = lockState.autoLockMs
  savingAutoLock.value = true
  try {
    await invoke(() => bridge!.appLockSetAutoLock!(value))
    lockState.autoLockMs = value
    ElMessage.success('自动锁定时间已更新')
  } catch (error) {
    selectedAutoLockMs.value = previous
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    savingAutoLock.value = false
  }
}

async function lockNow(): Promise<void> {
  try {
    await invoke(() => bridge!.appLockLock!())
    await loadState()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

onMounted(loadState)
</script>

<style scoped>
.security-page { height: 100%; overflow-y: auto; padding-right: 4px; }
.page-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 22px; margin-bottom: 14px; background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }
.header-info { display: flex; align-items: center; gap: 12px; }
.header-icon { width: 42px; height: 42px; display: flex; align-items: center; justify-content: center; color: var(--pl-primary); background: var(--pl-primary-soft); border-radius: 12px; }
.header-info h2 { margin: 0 0 3px; color: var(--pl-text); font-size: 17px; font-weight: 700; }
.header-info p { margin: 0; color: var(--pl-text-secondary); font-size: 12px; }
.security-sections { display: flex; flex-direction: column; gap: 14px; margin-top: 14px; padding-bottom: 20px; }
.security-card { overflow: hidden; background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }
.card-header { display: flex; align-items: center; gap: 12px; padding: 16px 20px; background: var(--pl-surface-subtle); border-bottom: 1px solid var(--pl-border); }
.card-icon { width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--pl-primary); background: var(--pl-primary-soft); border-radius: 10px; }
.card-header h3 { margin: 0 0 3px; color: var(--pl-text); font-size: 14px; font-weight: 650; }
.card-header p { margin: 0; color: var(--pl-text-secondary); font-size: 12px; }
.card-body { padding: 2px 20px; }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 0; }
.setting-row + .setting-row { border-top: 1px solid var(--pl-border); }
.setting-label { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.label-text { color: var(--pl-text); font-size: 13px; font-weight: 600; }
.label-hint { color: var(--pl-text-muted); font-size: 12px; line-height: 1.45; }
.row-actions { display: flex; gap: 8px; flex-shrink: 0; }
.row-actions :deep(.el-button span) { gap: 5px; }
.timeout-select { width: 180px; }
.vault-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--pl-border); border-bottom: 1px solid var(--pl-border); }
.summary-item { display: flex; flex-direction: column; gap: 6px; padding: 18px 20px; background: var(--pl-surface); }
.summary-item span { color: var(--pl-text-muted); font-size: 12px; }
.summary-item strong { color: var(--pl-text); font-size: 13px; font-weight: 650; }
.security-note { display: flex; align-items: center; gap: 8px; padding: 13px 20px; color: var(--pl-success); background: var(--pl-success-soft); font-size: 12px; }
.confirm-password { margin-top: 16px; }

@media (max-width: 700px) {
  .page-header { padding: 15px 16px; }
  .card-header { padding: 14px 16px; }
  .card-body { padding: 2px 16px; }
  .setting-row { align-items: flex-start; flex-direction: column; gap: 10px; }
  .row-actions, .timeout-select { width: 100%; }
  .row-actions :deep(.el-button) { flex: 1; }
  .vault-summary { grid-template-columns: 1fr; }
}
</style>
