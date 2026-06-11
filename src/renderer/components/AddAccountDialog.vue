<template>
  <el-dialog
    :model-value="modelValue"
    width="640px"
    :show-close="true"
    @close="onClose"
    class="add-account-dialog"
    :close-on-click-modal="false"
  >
    <template #header>
      <div class="dialog-header">
        <h2>添加网盘账号</h2>
      </div>
    </template>

    <!-- Step 1: Select platform -->
    <div class="form-section">
      <label class="form-label">网盘类型</label>
      <el-select v-model="selectedPlatform" style="width: 100%" @change="onPlatformChange">
        <el-option label="夸克网盘" value="quark" />
        <el-option label="百度网盘" value="baidu" />
        <el-option label="UC网盘" value="uc" />
        <el-option label="迅雷网盘" value="xunlei" />
      </el-select>
    </div>

    <!-- Step 2: Login method selector -->
    <div class="method-selector">
      <button
        v-for="m in currentMethods"
        :key="m.key"
        class="method-btn"
        :class="{ active: activeMethod === m.key }"
        @click="activeMethod = m.key"
      >
        <component :is="m.icon" :size="16" />
        <span>{{ m.label }}</span>
      </button>
    </div>

    <!-- Quark: Auto Cookie Login -->
    <div v-if="selectedPlatform === 'quark' && activeMethod === 'auto'" class="method-body">
      <div class="split-layout">
        <div class="steps-panel">
          <div class="step-item" v-for="(step, i) in quarkSteps" :key="i">
            <div class="step-num" :class="{ done: quarkAutoStep === 'success' && i < 4 }">
              <Check v-if="quarkAutoStep === 'success' && i < 4" :size="14" />
              <span v-else>{{ i + 1 }}</span>
            </div>
            <div class="step-content">
              <div class="step-title">{{ step.title }}</div>
              <div class="step-desc">{{ step.desc }}</div>
            </div>
          </div>
        </div>
        <div class="action-panel">
          <div class="status-tag" :class="quarkAutoStep">
            <component :is="stepStatusIcon(quarkAutoStep)" :size="14" />
            {{ stepStatusText(quarkAutoStep, '扫码') }}
          </div>
          <div v-if="quarkAutoStep === 'idle'" class="action-center">
            <el-button type="primary" size="large" @click="startQuarkAuto">
              <Monitor :size="16" style="margin-right: 6px" />
              开始登录
            </el-button>
            <p class="action-hint">将打开夸克网盘登录页面，请用夸克 App 扫码</p>
          </div>
          <div v-else-if="quarkAutoStep === 'logging'" class="action-center">
            <div class="pulse-ring"><Monitor :size="28" /></div>
            <p class="action-hint">请在弹出的窗口中扫码登录</p>
          </div>
          <div v-else-if="quarkAutoStep === 'success'" class="action-center success">
            <CheckCircle2 :size="32" />
            <p class="nickname">{{ quarkAutoResult.nickname }}</p>
          </div>
          <div v-else-if="quarkAutoStep === 'failed'" class="action-center failed">
            <XCircle :size="32" />
            <p>{{ quarkAutoError }}</p>
            <el-button size="small" @click="resetQuarkAuto">重试</el-button>
          </div>
        </div>
      </div>
      <div class="security-notice">
        <ShieldCheck :size="14" />
        <span>登录态仅保存在本地 · Cookie 加密存储 · 不读取系统浏览器数据</span>
      </div>
    </div>

    <!-- Quark: Manual Cookie -->
    <div v-if="selectedPlatform === 'quark' && activeMethod === 'manual'" class="method-body">
      <div class="form-card">
        <div class="help-steps">
          <div class="help-title">获取 Cookie 步骤：</div>
          <div class="help-step"><span class="help-num">1</span>用浏览器打开 <strong>pan.quark.cn</strong> 并登录</div>
          <div class="help-step"><span class="help-num">2</span>按 <kbd>F12</kbd> 打开开发者工具</div>
          <div class="help-step"><span class="help-num">3</span>点击顶部 <strong>Application</strong>（应用程序）标签</div>
          <div class="help-step"><span class="help-num">4</span>左侧展开 <strong>Cookies</strong> → 点击 <strong>https://pan.quark.cn</strong></div>
          <div class="help-step"><span class="help-num">5</span>右键表格 → <strong>Select All</strong> → 右键 → <strong>Copy</strong></div>
          <div class="help-step"><span class="help-num">6</span>粘贴到下方输入框</div>
        </div>
        <el-form label-position="top">
          <el-form-item label="账号昵称">
            <el-input v-model="manualNickname" placeholder="给账号起个名字（可选）" />
          </el-form-item>
          <el-form-item label="Cookie">
            <el-input
              v-model="manualCookie"
              type="textarea"
              :rows="5"
              placeholder="粘贴夸克网盘 Cookie"
            />
          </el-form-item>
        </el-form>
        <el-alert type="warning" :closable="false" show-icon>
          请勿粘贴他人账号信息，仅使用自己的账号凭证
        </el-alert>
      </div>
    </div>

    <!-- Baidu: Auto Cookie Login -->
    <div v-if="selectedPlatform === 'baidu' && activeMethod === 'auto'" class="method-body">
      <div class="split-layout">
        <div class="steps-panel">
          <div class="step-item" v-for="(step, i) in baiduCookieSteps" :key="i">
            <div class="step-num" :class="{ done: baiduAutoStep === 'success' && i < 4 }">
              <Check v-if="baiduAutoStep === 'success' && i < 4" :size="14" />
              <span v-else>{{ i + 1 }}</span>
            </div>
            <div class="step-content">
              <div class="step-title">{{ step.title }}</div>
              <div class="step-desc">{{ step.desc }}</div>
            </div>
          </div>
        </div>
        <div class="action-panel">
          <div class="status-tag" :class="baiduAutoStep">
            <component :is="stepStatusIcon(baiduAutoStep)" :size="14" />
            {{ stepStatusText(baiduAutoStep, '登录') }}
          </div>
          <div v-if="baiduAutoStep === 'idle'" class="action-center">
            <el-button type="primary" size="large" @click="startBaiduAuto">
              <Monitor :size="16" style="margin-right: 6px" />
              开始登录
            </el-button>
            <p class="action-hint">将打开百度网盘登录页面</p>
          </div>
          <div v-else-if="baiduAutoStep === 'logging'" class="action-center">
            <div class="pulse-ring"><Monitor :size="28" /></div>
            <p class="action-hint">请在弹出的窗口中登录百度账号</p>
          </div>
          <div v-else-if="baiduAutoStep === 'success'" class="action-center success">
            <CheckCircle2 :size="32" />
            <p class="nickname">{{ baiduAutoResult.nickname }}</p>
          </div>
          <div v-else-if="baiduAutoStep === 'failed'" class="action-center failed">
            <XCircle :size="32" />
            <p>{{ baiduAutoError }}</p>
            <el-button size="small" @click="resetBaiduAuto">重试</el-button>
          </div>
        </div>
      </div>
      <div class="security-notice">
        <ShieldCheck :size="14" />
        <span>登录态仅保存在本地 · Cookie 加密存储 · 不读取系统浏览器数据</span>
      </div>
    </div>

    <!-- Baidu: OAuth -->
    <div v-if="selectedPlatform === 'baidu' && activeMethod === 'oauth'" class="method-body">
      <div class="split-layout">
        <div class="steps-panel">
          <div class="step-item" v-for="(step, i) in baiduOAuthSteps" :key="i">
            <div class="step-num" :class="{ done: baiduOAuthStep === 'success' && i < 3 }">
              <Check v-if="baiduOAuthStep === 'success' && i < 3" :size="14" />
              <span v-else>{{ i + 1 }}</span>
            </div>
            <div class="step-content">
              <div class="step-title">{{ step.title }}</div>
              <div class="step-desc">{{ step.desc }}</div>
            </div>
          </div>
        </div>
        <div class="action-panel">
          <div v-if="baiduOAuthStep === 'code'">
            <el-form label-position="top">
              <el-form-item label="账号昵称">
                <el-input v-model="baiduOAuthNickname" placeholder="给账号起个名字（可选）" />
              </el-form-item>
              <el-form-item>
                <el-button type="primary" @click="openBaiduAuth" :loading="baiduOAuthOpening">
                  <ExternalLink :size="14" style="margin-right: 4px" />
                  打开授权页面
                </el-button>
              </el-form-item>
              <el-form-item label="授权码">
                <el-input v-model="baiduOAuthCode" placeholder="粘贴百度授权后的授权码" />
              </el-form-item>
            </el-form>
          </div>
          <div v-else-if="baiduOAuthStep === 'exchanging'" class="action-center">
            <div class="pulse-ring"><Key :size="28" /></div>
            <p class="action-hint">正在换取 Token...</p>
          </div>
          <div v-else-if="baiduOAuthStep === 'success'" class="action-center success">
            <CheckCircle2 :size="32" />
            <p class="nickname">{{ baiduOAuthResult.nickname }}</p>
          </div>
          <div v-else-if="baiduOAuthStep === 'failed'" class="action-center failed">
            <XCircle :size="32" />
            <p>{{ baiduOAuthError }}</p>
            <el-button size="small" @click="resetBaiduOAuth">重试</el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- Baidu: Manual Cookie -->
    <div v-if="selectedPlatform === 'baidu' && activeMethod === 'manual'" class="method-body">
      <div class="form-card">
        <div class="help-steps">
          <div class="help-title">获取 Cookie 步骤：</div>
          <div class="help-step"><span class="help-num">1</span>用浏览器打开 <strong>pan.baidu.com</strong> 并登录</div>
          <div class="help-step"><span class="help-num">2</span>按 <kbd>F12</kbd> 打开开发者工具</div>
          <div class="help-step"><span class="help-num">3</span>点击顶部 <strong>Application</strong>（应用程序）标签</div>
          <div class="help-step"><span class="help-num">4</span>左侧展开 <strong>Cookies</strong> → 点击 <strong>https://pan.baidu.com</strong></div>
          <div class="help-step"><span class="help-num">5</span>在右侧表格中找到 <strong>BDUSS</strong>，双击 Value 列复制值</div>
          <div class="help-step"><span class="help-num">6</span>格式：<code>BDUSS=你的值; BDUSS_BFESS=你的值</code>，粘贴到下方</div>
        </div>
        <el-form label-position="top">
          <el-form-item label="账号昵称">
            <el-input v-model="manualNickname" placeholder="给账号起个名字（可选）" />
          </el-form-item>
          <el-form-item label="Cookie">
            <el-input
              v-model="manualCookie"
              type="textarea"
              :rows="5"
              placeholder="粘贴百度网盘 Cookie（至少包含 BDUSS）"
            />
          </el-form-item>
        </el-form>
        <el-alert type="warning" :closable="false" show-icon>
          请勿粘贴他人账号信息，仅使用自己的账号凭证
        </el-alert>
      </div>
    </div>

    <!-- UC: Auto Cookie Login -->
    <div v-if="selectedPlatform === 'uc' && activeMethod === 'auto'" class="method-body">
      <div class="split-layout">
        <div class="steps-panel">
          <div class="step-item" v-for="(step, i) in ucSteps" :key="i">
            <div class="step-num" :class="{ done: ucAutoStep === 'success' && i < 4 }">
              <Check v-if="ucAutoStep === 'success' && i < 4" :size="14" />
              <span v-else>{{ i + 1 }}</span>
            </div>
            <div class="step-content">
              <div class="step-title">{{ step.title }}</div>
              <div class="step-desc">{{ step.desc }}</div>
            </div>
          </div>
        </div>
        <div class="action-panel">
          <div class="status-tag" :class="ucAutoStep">
            <component :is="stepStatusIcon(ucAutoStep)" :size="14" />
            {{ stepStatusText(ucAutoStep, '登录') }}
          </div>
          <div v-if="ucAutoStep === 'idle'" class="action-center">
            <el-button type="primary" size="large" @click="startUcAuto">
              <Monitor :size="16" style="margin-right: 6px" />
              开始登录
            </el-button>
            <p class="action-hint">将打开 UC 网盘登录页面</p>
          </div>
          <div v-else-if="ucAutoStep === 'logging'" class="action-center">
            <div class="pulse-ring"><Monitor :size="28" /></div>
            <p class="action-hint">请在弹出的窗口中登录 UC 账号</p>
          </div>
          <div v-else-if="ucAutoStep === 'success'" class="action-center success">
            <CheckCircle2 :size="32" />
            <p class="nickname">{{ ucAutoResult.nickname }}</p>
          </div>
          <div v-else-if="ucAutoStep === 'failed'" class="action-center failed">
            <XCircle :size="32" />
            <p>{{ ucAutoError }}</p>
            <el-button size="small" @click="resetUcAuto">重试</el-button>
          </div>
        </div>
      </div>
      <div class="security-notice">
        <ShieldCheck :size="14" />
        <span>登录态仅保存在本地 · Cookie 加密存储</span>
      </div>
    </div>

    <!-- UC: Manual Cookie -->
    <div v-if="selectedPlatform === 'uc' && activeMethod === 'manual'" class="method-body">
      <div class="form-card">
        <div class="help-steps">
          <div class="help-title">获取 Cookie 步骤：</div>
          <div class="help-step"><span class="help-num">1</span>用浏览器打开 <strong>drive.uc.cn</strong> 并登录</div>
          <div class="help-step"><span class="help-num">2</span>按 <kbd>F12</kbd> 打开开发者工具</div>
          <div class="help-step"><span class="help-num">3</span>点击顶部 <strong>Application</strong>（应用程序）标签</div>
          <div class="help-step"><span class="help-num">4</span>左侧展开 <strong>Cookies</strong> → 点击 <strong>https://drive.uc.cn</strong></div>
          <div class="help-step"><span class="help-num">5</span>右键表格 → <strong>Select All</strong> → 右键 → <strong>Copy</strong></div>
          <div class="help-step"><span class="help-num">6</span>粘贴到下方输入框</div>
        </div>
        <el-form label-position="top">
          <el-form-item label="账号昵称">
            <el-input v-model="manualNickname" placeholder="给账号起个名字（可选）" />
          </el-form-item>
          <el-form-item label="Cookie">
            <el-input v-model="manualCookie" type="textarea" :rows="5" placeholder="粘贴 UC 网盘 Cookie" />
          </el-form-item>
        </el-form>
      </div>
    </div>

    <!-- Xunlei: Browser Login -->
    <div v-if="selectedPlatform === 'xunlei' && activeMethod === 'auto'" class="method-body">
      <div class="split-layout">
        <div class="steps-panel">
          <div class="step-item" v-for="(step, i) in xunleiSteps" :key="i">
            <div class="step-num" :class="{ done: xunleiAutoStep === 'success' && i < 4 }">
              <Check v-if="xunleiAutoStep === 'success' && i < 4" :size="14" />
              <span v-else>{{ i + 1 }}</span>
            </div>
            <div class="step-content">
              <div class="step-title">{{ step.title }}</div>
              <div class="step-desc">{{ step.desc }}</div>
            </div>
          </div>
        </div>
        <div class="action-panel">
          <div class="status-tag" :class="xunleiAutoStep">
            <component :is="stepStatusIcon(xunleiAutoStep)" :size="14" />
            {{ stepStatusText(xunleiAutoStep, '登录') }}
          </div>
          <div v-if="xunleiAutoStep === 'idle'" class="action-center">
            <el-button type="primary" size="large" @click="startXunleiAuto">
              <Monitor :size="16" style="margin-right: 6px" />
              开始登录
            </el-button>
            <p class="action-hint">将打开迅雷网盘登录页面</p>
          </div>
          <div v-else-if="xunleiAutoStep === 'logging'" class="action-center">
            <div class="pulse-ring"><Monitor :size="28" /></div>
            <p class="action-hint">请在弹出的窗口中登录迅雷账号</p>
          </div>
          <div v-else-if="xunleiAutoStep === 'success'" class="action-center success">
            <CheckCircle2 :size="32" />
            <p class="nickname">{{ xunleiAutoResult.nickname }}</p>
          </div>
          <div v-else-if="xunleiAutoStep === 'failed'" class="action-center failed">
            <XCircle :size="32" />
            <p>{{ xunleiAutoError }}</p>
            <el-button size="small" @click="resetXunleiAuto">重试</el-button>
          </div>
        </div>
      </div>
      <div class="security-notice">
        <ShieldCheck :size="14" />
        <span>登录态仅保存在本地 · Token 加密存储</span>
      </div>
    </div>

    <!-- Xunlei: Manual Token -->
    <div v-if="selectedPlatform === 'xunlei' && activeMethod === 'token'" class="method-body">
      <div class="form-card">
        <div class="help-steps">
          <div class="help-title">获取 Refresh Token 步骤：</div>
          <div class="help-step"><span class="help-num">1</span>用浏览器打开 <strong>pan.xunlei.com</strong> 并登录</div>
          <div class="help-step"><span class="help-num">2</span>按 <kbd>F12</kbd> 打开开发者工具 → <strong>Application</strong></div>
          <div class="help-step"><span class="help-num">3</span>左侧 <strong>Local Storage</strong> → 点击 <strong>https://pan.xunlei.com</strong></div>
          <div class="help-step"><span class="help-num">4</span>找到 <strong>refresh_token</strong>，复制其值</div>
        </div>
        <el-form label-position="top">
          <el-form-item label="账号昵称">
            <el-input v-model="manualNickname" placeholder="给账号起个名字（可选）" />
          </el-form-item>
          <el-form-item label="Refresh Token">
            <el-input v-model="manualToken" placeholder="粘贴 refresh_token" />
          </el-form-item>
        </el-form>
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="onClose">取消</el-button>
        <el-button type="primary" @click="onConfirm" :loading="saving">添加账号</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, markRaw } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Globe, PenSquare, KeyRound, Monitor, Check, CheckCircle2,
  XCircle, ShieldCheck, ExternalLink, Key, Loader2,
} from 'lucide-vue-next'
import type { Platform, LoginType, DriveCredential } from '@shared/types'
import { electronApi, type LoginResult, type BaiduLoginResult } from '../api/ipc'

defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; success: [] }>()

const saving = ref(false)
const selectedPlatform = ref<Platform>('quark')
const activeMethod = ref('auto')

type Step = 'idle' | 'logging' | 'success' | 'failed'

// ── Login method definitions ──

const quarkMethods = [
  { key: 'auto', label: '自动获取 Cookie', icon: markRaw(Globe) },
  { key: 'manual', label: '手动粘贴 Cookie', icon: markRaw(PenSquare) },
]

const baiduMethods = [
  { key: 'auto', label: '自动获取 Cookie', icon: markRaw(Globe) },
  { key: 'oauth', label: 'OAuth 授权', icon: markRaw(KeyRound) },
  { key: 'manual', label: '手动粘贴 Cookie', icon: markRaw(PenSquare) },
]

const ucMethods = [
  { key: 'auto', label: '自动获取 Cookie', icon: markRaw(Globe) },
  { key: 'manual', label: '手动粘贴 Cookie', icon: markRaw(PenSquare) },
]

const xunleiMethods = [
  { key: 'auto', label: '自动获取 Token', icon: markRaw(Globe) },
  { key: 'token', label: '粘贴 Refresh Token', icon: markRaw(KeyRound) },
]

const currentMethods = computed(() => {
  switch (selectedPlatform.value) {
    case 'quark': return quarkMethods
    case 'baidu': return baiduMethods
    case 'uc': return ucMethods
    case 'xunlei': return xunleiMethods
    default: return quarkMethods
  }
})

function onPlatformChange() {
  activeMethod.value = 'auto'
  resetQuarkAuto()
  resetBaiduAuto()
  resetBaiduOAuth()
  resetUcAuto()
  resetXunleiAuto()
  manualNickname.value = ''
  manualCookie.value = ''
  manualToken.value = ''
}

// ── Step status helpers ──

function stepStatusIcon(step: Step) {
  switch (step) {
    case 'idle': return markRaw(Monitor)
    case 'logging': return markRaw(Loader2)
    case 'success': return markRaw(CheckCircle2)
    case 'failed': return markRaw(XCircle)
  }
}

function stepStatusText(step: Step, action: string) {
  switch (step) {
    case 'idle': return '准备就绪'
    case 'logging': return `等待${action}...`
    case 'success': return '登录成功'
    case 'failed': return '登录失败'
  }
}

// ── Quark Auto Cookie ──

const quarkSteps = [
  { title: '打开夸克网盘', desc: '打开官方登录页面' },
  { title: '扫码登录', desc: '使用夸克 App 扫码' },
  { title: '自动获取', desc: '登录成功后自动获取 Cookie' },
  { title: '保存账号', desc: '验证通过后自动保存' },
]

const quarkAutoStep = ref<Step>('idle')
const quarkAutoResult = ref<LoginResult>({ success: false })
const quarkAutoError = ref('')

async function startQuarkAuto() {
  quarkAutoStep.value = 'logging'
  quarkAutoError.value = ''
  try {
    const result = await electronApi.openQuarkLogin()
    quarkAutoResult.value = result
    quarkAutoStep.value = result.success ? 'success' : 'failed'
    if (!result.success) quarkAutoError.value = result.error || '登录失败'
  } catch (err) {
    quarkAutoStep.value = 'failed'
    quarkAutoError.value = String(err)
  }
}

function resetQuarkAuto() {
  quarkAutoStep.value = 'idle'
  quarkAutoResult.value = { success: false }
  quarkAutoError.value = ''
}

// ── Baidu Auto Cookie ──

const baiduCookieSteps = [
  { title: '打开百度网盘', desc: '打开官方登录页面' },
  { title: '登录账号', desc: '输入账号密码或扫码登录' },
  { title: '自动获取', desc: '登录成功后自动获取 Cookie' },
  { title: '保存账号', desc: '验证通过后自动保存' },
]

const baiduAutoStep = ref<Step>('idle')
const baiduAutoResult = ref<LoginResult>({ success: false })
const baiduAutoError = ref('')

async function startBaiduAuto() {
  baiduAutoStep.value = 'logging'
  baiduAutoError.value = ''
  try {
    const result = await electronApi.loginBaiduCookie()
    baiduAutoResult.value = result
    baiduAutoStep.value = result.success ? 'success' : 'failed'
    if (!result.success) baiduAutoError.value = result.error || '登录失败'
  } catch (err) {
    baiduAutoStep.value = 'failed'
    baiduAutoError.value = String(err)
  }
}

function resetBaiduAuto() {
  baiduAutoStep.value = 'idle'
  baiduAutoResult.value = { success: false }
  baiduAutoError.value = ''
}

// ── Baidu OAuth ──

const baiduOAuthSteps = [
  { title: '打开授权页面', desc: '使用百度账号授权' },
  { title: '复制授权码', desc: '粘贴到输入框' },
  { title: '保存账号', desc: '换取 Token 后保存' },
]

type OAuthStep = 'code' | 'exchanging' | 'success' | 'failed'
const baiduOAuthStep = ref<OAuthStep>('code')
const baiduOAuthNickname = ref('')
const baiduOAuthCode = ref('')
const baiduOAuthOpening = ref(false)
const baiduOAuthError = ref('')
const baiduOAuthResult = ref<BaiduLoginResult>({ success: false })

async function openBaiduAuth() {
  baiduOAuthOpening.value = true
  try { await electronApi.getBaiduAuthUrl() }
  finally { baiduOAuthOpening.value = false }
}

async function exchangeBaiduCode() {
  if (!baiduOAuthCode.value.trim()) {
    ElMessage.warning('请输入授权码')
    return false
  }
  baiduOAuthStep.value = 'exchanging'
  baiduOAuthError.value = ''
  try {
    const result = await electronApi.loginBaidu(baiduOAuthCode.value.trim())
    baiduOAuthResult.value = result
    if (result.success) {
      baiduOAuthStep.value = 'success'
      return true
    }
    baiduOAuthStep.value = 'failed'
    baiduOAuthError.value = result.error || '授权失败'
    return false
  } catch (err) {
    baiduOAuthStep.value = 'failed'
    baiduOAuthError.value = String(err)
    return false
  }
}

function resetBaiduOAuth() {
  baiduOAuthStep.value = 'code'
  baiduOAuthCode.value = ''
  baiduOAuthError.value = ''
  baiduOAuthResult.value = { success: false }
}

// ── Manual ──

const manualNickname = ref('')
const manualCookie = ref('')
const manualToken = ref('')

// ── UC Auto Cookie ──

const ucSteps = [
  { title: '打开UC网盘', desc: '打开官方登录页面' },
  { title: '登录账号', desc: '登录您的UC账号' },
  { title: '自动获取', desc: '登录成功后自动获取 Cookie' },
  { title: '保存账号', desc: '验证通过后自动保存' },
]

const ucAutoStep = ref<Step>('idle')
const ucAutoResult = ref<LoginResult>({ success: false })
const ucAutoError = ref('')

async function startUcAuto() {
  ucAutoStep.value = 'logging'
  ucAutoError.value = ''
  try {
    const result = await electronApi.loginUc()
    ucAutoResult.value = result
    ucAutoStep.value = result.success ? 'success' : 'failed'
    if (!result.success) ucAutoError.value = result.error || '登录失败'
  } catch (err) {
    ucAutoStep.value = 'failed'
    ucAutoError.value = String(err)
  }
}

function resetUcAuto() {
  ucAutoStep.value = 'idle'
  ucAutoResult.value = { success: false }
  ucAutoError.value = ''
}

// ── Xunlei Browser Login ──

import type { XunleiLoginResult } from '../api/ipc'

const xunleiSteps = [
  { title: '打开迅雷网盘', desc: '打开官方登录页面' },
  { title: '登录账号', desc: '扫码或输入账号密码登录' },
  { title: '自动获取', desc: '登录成功后自动获取 Token' },
  { title: '保存账号', desc: '验证通过后自动保存' },
]

const xunleiAutoStep = ref<Step>('idle')
const xunleiAutoResult = ref<XunleiLoginResult>({ success: false })
const xunleiAutoError = ref('')

async function startXunleiAuto() {
  xunleiAutoStep.value = 'logging'
  xunleiAutoError.value = ''
  try {
    const result = await electronApi.openXunleiLogin()
    xunleiAutoResult.value = result
    xunleiAutoStep.value = result.success ? 'success' : 'failed'
    if (!result.success) xunleiAutoError.value = result.error || '登录失败'
  } catch (err) {
    xunleiAutoStep.value = 'failed'
    xunleiAutoError.value = String(err)
  }
}

function resetXunleiAuto() {
  xunleiAutoStep.value = 'idle'
  xunleiAutoResult.value = { success: false }
  xunleiAutoError.value = ''
}

// ── Confirm ──

async function onConfirm() {
  saving.value = true
  try {
    let params: {
      platform: Platform; nickname: string; loginType: LoginType
      credential: DriveCredential; userAgent?: string
    }

    const platform = selectedPlatform.value

    if (platform === 'quark') {
      if (activeMethod.value === 'auto') {
        if (quarkAutoStep.value !== 'success') { ElMessage.warning('请先完成登录'); return }
        params = {
          platform: 'quark', nickname: quarkAutoResult.value.nickname || '夸克账号',
          loginType: 'cookie',
          credential: { cookies: quarkAutoResult.value.cookies, userAgent: quarkAutoResult.value.userAgent },
          userAgent: quarkAutoResult.value.userAgent,
        }
      } else {
        if (!manualCookie.value.trim()) { ElMessage.warning('请输入 Cookie'); return }
        params = {
          platform: 'quark', nickname: manualNickname.value || '夸克账号',
          loginType: 'cookie',
          credential: { cookies: manualCookie.value.trim() },
        }
      }
    } else if (platform === 'baidu') {
      if (activeMethod.value === 'auto') {
        if (baiduAutoStep.value !== 'success') { ElMessage.warning('请先完成登录'); return }
        params = {
          platform: 'baidu', nickname: baiduAutoResult.value.nickname || '百度账号',
          loginType: 'cookie',
          credential: { cookies: baiduAutoResult.value.cookies },
          userAgent: baiduAutoResult.value.userAgent,
        }
      } else if (activeMethod.value === 'oauth') {
        if (baiduOAuthStep.value === 'code') { const ok = await exchangeBaiduCode(); if (!ok) return }
        if (baiduOAuthStep.value !== 'success') { ElMessage.warning('请先完成授权'); return }
        params = {
          platform: 'baidu', nickname: baiduOAuthNickname.value || baiduOAuthResult.value.nickname || '百度账号',
          loginType: 'oauth',
          credential: {
            accessToken: baiduOAuthResult.value.accessToken,
            refreshToken: baiduOAuthResult.value.refreshToken,
            expiresAt: Date.now() + (baiduOAuthResult.value.expiresIn || 0) * 1000,
          },
        }
      } else {
        if (!manualCookie.value.trim()) { ElMessage.warning('请输入 Cookie'); return }
        params = {
          platform: 'baidu', nickname: manualNickname.value || '百度账号',
          loginType: 'cookie',
          credential: { cookies: manualCookie.value.trim() },
        }
      }
    } else if (platform === 'uc') {
      if (activeMethod.value === 'auto') {
        if (ucAutoStep.value !== 'success') { ElMessage.warning('请先完成登录'); return }
        params = {
          platform: 'uc', nickname: ucAutoResult.value.nickname || 'UC账号',
          loginType: 'cookie',
          credential: { cookies: ucAutoResult.value.cookies },
        }
      } else {
        if (!manualCookie.value.trim()) { ElMessage.warning('请输入 Cookie'); return }
        params = {
          platform: 'uc', nickname: manualNickname.value || 'UC账号',
          loginType: 'cookie',
          credential: { cookies: manualCookie.value.trim() },
        }
      }
    } else if (platform === 'xunlei') {
      if (activeMethod.value === 'auto') {
        if (xunleiAutoStep.value !== 'success') { ElMessage.warning('请先完成登录'); return }
        params = {
          platform: 'xunlei', nickname: xunleiAutoResult.value.nickname || '迅雷账号',
          loginType: 'token',
          credential: {
            refreshToken: xunleiAutoResult.value.refreshToken,
            accessToken: xunleiAutoResult.value.accessToken,
            userId: xunleiAutoResult.value.userId,
          },
        }
      } else {
        if (!manualToken.value.trim()) { ElMessage.warning('请输入 Refresh Token'); return }
        params = {
          platform: 'xunlei', nickname: manualNickname.value || '迅雷账号',
          loginType: 'token',
          credential: { refreshToken: manualToken.value.trim() },
        }
      }
    } else {
      ElMessage.warning('不支持的平台')
      return
    }

    const result = await electronApi.addAccount(params)
    if (result.success) {
      ElMessage.success('账号添加成功')
      emit('update:modelValue', false)
      emit('success')
      resetForms()
    } else {
      ElMessage.error(result.error || '添加失败')
    }
  } finally { saving.value = false }
}

function resetForms() {
  selectedPlatform.value = 'quark'
  activeMethod.value = 'auto'
  resetQuarkAuto()
  resetBaiduAuto()
  resetBaiduOAuth()
  resetUcAuto()
  resetXunleiAuto()
  manualNickname.value = ''
  manualCookie.value = ''
  manualToken.value = ''
}

function onClose() { emit('update:modelValue', false) }
</script>

<style scoped>
.dialog-header h2 {
  font-size: 18px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 4px;
}

.form-section {
  margin-bottom: 16px;
}
.form-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: #374151;
  margin-bottom: 6px;
}

/* ── Method selector ── */
.method-selector {
  display: flex;
  gap: 6px;
  padding-bottom: 16px;
  border-bottom: 1px solid #f3f4f6;
  margin-bottom: 20px;
}

.method-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid #e5e7eb;
  background: #ffffff;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.15s;
}
.method-btn:hover { border-color: #d1d5db; background: #f9fafb; }
.method-btn.active { background: #eff6ff; border-color: #93c5fd; color: #3b82f6; }

/* ── Method body ── */
.method-body {
  min-height: 280px;
}

/* ── Split layout ── */
.split-layout {
  display: flex;
  gap: 24px;
}

.steps-panel {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  background: #f9fafb;
  border-radius: 12px;
}

.step-item {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.step-num {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: #e5e7eb;
  color: #6b7280;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.step-num.done { background: #22c55e; color: #ffffff; }

.step-content { min-width: 0; }
.step-title { font-size: 13px; font-weight: 600; color: #1f2937; }
.step-desc { font-size: 12px; color: #9ca3af; margin-top: 2px; }

.action-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  background: #f3f4f6;
  color: #6b7280;
  align-self: flex-start;
}
.status-tag.logging { background: #fffbeb; color: #f59e0b; }
.status-tag.logging svg { animation: spin 1s linear infinite; }
.status-tag.success { background: #f0fdf4; color: #22c55e; }
.status-tag.failed { background: #fef2f2; color: #ef4444; }

@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.action-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.action-center.success { color: #22c55e; }
.action-center.failed { color: #ef4444; }
.nickname { font-size: 16px; font-weight: 600; color: #1f2937; }
.action-hint { font-size: 13px; color: #9ca3af; }

.pulse-ring {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #eff6ff;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #3b82f6;
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.1); opacity: 0.7; } }

.security-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  margin-top: 16px;
  background: #f0fdf4;
  border-radius: 8px;
  font-size: 12px;
  color: #16a34a;
}

.form-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── Help steps ── */
.help-steps {
  background: #f9fafb;
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.help-title {
  font-size: 13px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 4px;
}

.help-step {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #6b7280;
  line-height: 1.6;
}

.help-num {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #e5e7eb;
  color: #374151;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
}

.help-step strong {
  color: #1f2937;
}

.help-step kbd {
  display: inline-block;
  padding: 1px 5px;
  background: #ffffff;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 11px;
  font-family: monospace;
  color: #374151;
}

.help-step code {
  display: inline-block;
  padding: 1px 5px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  font-size: 11px;
  font-family: monospace;
  color: #3b82f6;
  word-break: break-all;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
