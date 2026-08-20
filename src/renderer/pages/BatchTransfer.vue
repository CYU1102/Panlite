<template>

 <div class="batch-transfer">

 <!-- Page header -->

 <div class="page-header">

 <div class="header-info">

 <div class="header-icon">

 <ArrowDownToLine :size="20" :stroke-width="1.5" />

 </div>

 <div>

 <h2>批量转存</h2>

 <p>粘贴分享链接，选择目标目录，快速保存到自己的网盘</p>

 </div>

 </div>

 </div>

 <div class="workflow-steps" aria-label="批量转存流程">

 <div class="workflow-step" :class="{ complete: !!selectedAccountId, active: !selectedAccountId }">

 <span class="step-index">1</span>

 <span class="step-copy"><strong>选择账号</strong><small>{{ selectedAccountId ? '账号已就绪' : '选择保存账号' }}</small></span>

 </div>

 <span class="step-line" :class="{ complete: !!selectedAccountId }" />

 <div class="workflow-step" :class="{ complete: validLinks.length > 0, active: !!selectedAccountId && validLinks.length === 0 }">

 <span class="step-index">2</span>

 <span class="step-copy"><strong>粘贴链接</strong><small>{{ validLinks.length ? `${validLinks.length} 个可转存` : '自动识别与去重' }}</small></span>

 </div>

 <span class="step-line" :class="{ complete: validLinks.length > 0 }" />

 <div class="workflow-step" :class="{ active: validLinks.length > 0 }">

 <span class="step-index">3</span>

 <span class="step-copy"><strong>确认转存</strong><small>选择目录并提交</small></span>

 </div>

 </div>

 <div class="transfer-body">

 <!-- Left: links input -->

 <div class="panel links-panel">

 <div class="panel-heading">

 <div class="panel-step">01</div>

 <div><div class="panel-title">账号与分享链接</div><p class="panel-hint">每行一个链接，支持自动识别平台和提取码</p></div>

 <span v-if="validLinks.length" class="selection-count">{{ validLinks.length }} 个有效</span>

 </div>

 <!-- Account selector -->

 <div class="account-bar">

 <el-select v-model="platform" style="width: 120px">

 <el-option label="夸克网盘" value="quark" />

 <el-option label="百度网盘" value="baidu" />

 <el-option label="UC网盘" value="uc" />

 <el-option label="迅雷网盘" value="xunlei" />

 </el-select>

 <el-select

 v-model="selectedAccountId"

 placeholder="选择账号"

 style="flex: 1"

 filterable

 size="default"

 >

 <el-option

 v-for="acc in filteredAccounts"

 :key="acc.id"

 :label="acc.nickname || acc.id"

 :value="acc.id"

 />

 </el-select>

 </div>

 <el-alert

 v-if="needsCookieHint"

 title="登录方式提示"

 description="百度网盘转存需要 Cookie 方式登录（OAuth 不支持）。迅雷需要 Token 方式登录。"

 type="warning"

 :closable="false"

 show-icon

 style="margin-bottom: 8px"

 />

 <div class="textarea-wrap">

 <el-input

 ref="textareaRef"

 v-model="bulkText"

 type="textarea"

 :rows="10"

 placeholder="#10;#10;"

 @paste="onPaste"

 />

 </div>

 <div class="link-stats" v-if="parsedLinks.length > 0">

 <span class="stat-valid">

 <CheckCircle2 :size="12" />

 {{ validLinks.length }} 个有效链接 </span>

 <span v-if="filteredOutCount > 0" class="stat-dup">

 <AlertTriangle :size="12" />

 已过滤 {{ filteredOutCount }} 个其他平台链接 </span>

 <span v-if="duplicateCount > 0" class="stat-dup">

 <AlertTriangle :size="12" />

 {{ duplicateCount }} 个重复 </span>

 <span v-if="invalidCount > 0" class="stat-invalid">

 <XCircle :size="12" />

 {{ invalidCount }} 个无效 </span>

 </div>

 <!-- Parsed link preview -->

 <div v-if="parsedLinks.length > 0" class="preview-list">

 <div

 v-for="(link, i) in parsedLinks.slice(0, 20)"

 :key="i"

 class="preview-item"

 :class="{ invalid: !link.valid, dup: link.isDuplicate }"

 >

 <span class="preview-platform">{{ link.platform }}</span>

 <span class="preview-url">{{ link.url }}</span>

 <span v-if="link.password" class="preview-pwd">提取码: {{ link.password }}</span>

 <span v-if="link.isDuplicate" class="preview-tag dup">重复</span>

 <span v-if="!link.valid" class="preview-tag invalid">无效</span>

 </div>

 <p v-if="parsedLinks.length > 20" class="preview-more">... {{ parsedLinks.length - 20 }} </p>

 </div>

 </div>

 <!-- Right: directory picker -->

 <div class="panel dir-panel">

 <div class="panel-heading">

 <div class="panel-step">02</div>

 <div><div class="panel-title">选择目标目录</div><p class="panel-hint">当前目录将作为全部链接的保存位置</p></div>

 </div>

 <div v-if="!selectedAccountId" class="dir-empty">

 <span class="empty-icon"><FolderOpen :size="28" :stroke-width="1.4" /></span>

 <strong>等待账号选择</strong>

 <p>选择账号后即可浏览目标目录</p>

 </div>

 <template v-else>

 <!-- Breadcrumb navigation -->

 <div class="folder-nav">

 <div class="folder-breadcrumb">

 <template v-for="(item, index) in navStack" :key="item.id">

 <ChevronRight v-if="index > 0" class="crumb-sep" :size="12" />

 <span

 class="crumb"

 :class="{ active: index === navStack.length - 1 }"

 @click="onBreadcrumbClick(index)"

 >

 {{ item.name }}

 </span>

 </template>

            </div>

            <button

              class="nav-btn"

              :disabled="navStack.length <= 1"

              @click="onGoBack"

              title="返回上级"

            >

              <ArrowLeft :size="14" />

            </button>

          </div>



          <!-- Folder list -->

          <div class="folder-list" v-loading="loadingFolders">

            <div v-if="folders.length === 0 && !loadingFolders" class="folder-empty">

              <FolderOpen :size="24" :stroke-width="1" />

              <span>暂无文件夹</span>

            </div>

            <div

              v-for="folder in folders"

              :key="folder.id"

              class="folder-item"

              @click="onFolderClick(folder)"

            >

              <FolderOpen :size="16" :stroke-width="1.5" />

              <span class="folder-name">{{ folder.name }}</span>

              <ChevronRight :size="14" class="folder-arrow" />

            </div>

          </div>



          <div class="target-info">

            <span>保存到</span><strong>{{ currentFolder.name }}</strong><span class="target-ready">已选择</span>

          </div>

        </template>

      </div>

    </div>



    <!-- Options bar -->
    <div class="options-bar">
      <div class="options-heading"><span class="panel-step">03</span><div><strong>任务选项</strong><small>提交前检查本次转存行为</small></div></div>
      <label class="option-card" :class="{ selected: autoShare }"><el-checkbox v-model="autoShare" /><span><strong>转存后自动分享</strong><small>完成后继续创建分享链接</small></span></label>
      <label class="option-card" :class="{ selected: verifyFirst }"><el-checkbox v-model="verifyFirst" /><span><strong>转存前检测链接</strong><small>自动跳过检测到的失效链接</small></span></label>
      <el-button
        class="verify-button"
        size="small"
        @click="onVerifyLinks"
        :loading="verifying"
        :disabled="validLinks.length === 0 || !selectedAccountId"
      >
        <ShieldCheck :size="14" style="margin-right: 4px" />
        检测链接
      </el-button>
    </div>

    <!-- Submit bar -->

    <div class="submit-bar">

      <div class="submit-info">

        <template v-if="validLinks.length > 0 && selectedAccountId">

          将转存 <strong>{{ validLinks.length }}</strong> 个链接到

          <strong>{{ currentFolder.name }}</strong>
          <template v-if="autoShare">，转存后自动分享</template>
          <template v-if="verifyFirst">，无效链接将跳过</template>

        </template>

        <template v-else>

          <span class="submit-state-dot" />

          {{ !selectedAccountId ? '请选择保存账号以开始' : '请粘贴至少一个当前平台的有效链接' }}

        </template>

      </div>

      <el-button

        type="primary"

        size="large"

        @click="onSubmit"

        :loading="submitting"

        :disabled="validLinks.length === 0 || !selectedAccountId"

      >

        <ArrowDownToLine :size="16" style="margin-right: 6px" />
        开始转存
      </el-button>

    </div>

  </div>

</template>



<script setup lang="ts">

import { ref, computed, watch, onMounted } from 'vue'

import { ElMessage } from 'element-plus/es/components/message/index.mjs'

import {

  ArrowDownToLine, CheckCircle2, AlertTriangle, XCircle,

  FolderOpen, ChevronRight, ArrowLeft, ShieldCheck,

} from 'lucide-vue-next'

import { electronApi } from '../api/ipc'

import { useAccountStore } from '../stores/account'

import type { FileItem } from '@shared/types'



const accountStore = useAccountStore()



const platform = ref<'quark' | 'baidu' | 'uc' | 'xunlei'>('quark')

const selectedAccountId = ref('')

const bulkText = ref('')

const submitting = ref(false)

const autoShare = ref(false)

const verifyFirst = ref(false)

const verifying = ref(false)



const filteredAccounts = computed(() =>

  accountStore.getAccountsByPlatform(platform.value),

)



const needsCookieHint = computed(() => {

  const acc = filteredAccounts.value.find((a) => a.id === selectedAccountId.value)

  if (!acc) return false

  // 百度 OAuth 登录不支持分享/转存，需要 Cookie
  if (platform.value === 'baidu' && acc.loginType === 'oauth') return true

  // 迅雷需要官方授权 Token（OAuth 浏览器登录或手动 Refresh Token）
  if (platform.value === 'xunlei' && !['token', 'oauth'].includes(acc.loginType)) return true

  return false

})



// Reset account when platform changes

watch(platform, () => {

  selectedAccountId.value = ''

  folders.value = []

  navStack.value = [{ id: '0', name: 'root' }]

})



// Auto-select first account

watch(filteredAccounts, (accs) => {

  if (accs.length > 0 && !accs.find((a) => a.id === selectedAccountId.value)) {

    selectedAccountId.value = accs[0].id

  }

}, { immediate: true })



// ---- Link parsing ----



interface ParsedLink {

  url: string

  password: string | null

  platform: string

  valid: boolean

  isDuplicate: boolean

}



function cleanPastedText(text: string): string {

  const lines = text.split('\n')

  const cleaned: string[] = []

  // 根据当前选择的平台确定域名匹配规则
  const platformDomains: Record<string, RegExp> = {
    quark: /https?:\/\/pan\.quark\.cn\/\S+/,
    baidu: /https?:\/\/pan\.baidu\.com\/\S+/,
    uc: /https?:\/\/drive\.uc\.cn\/\S+/,
    xunlei: /https?:\/\/pan\.xunlei\.com\/\S+/,
  }
  const domainRegex = platformDomains[platform.value]

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // 只提取当前平台的链接
    const urlMatch = trimmed.match(domainRegex)
    if (!urlMatch) continue

    let url = urlMatch[0]

    // 升级百度旧链接格式 share/init?surl= → s/1
    url = url.replace(/share\/init\?surl=/, 's/1')

    // 提取密码
    let pwd: string | null = null

    // 从 URL 参数提取 pwd
    const pwdParamMatch = url.match(/[?&]pwd=([a-zA-Z0-9]{4})/)
    if (pwdParamMatch) pwd = pwdParamMatch[1]

    // 从 URL 后面的文本提取（提取码/密码/pwd）
    if (!pwd) {
      const afterUrl = trimmed.substring(trimmed.indexOf(url) + url.length).trim()
      const pwdTextMatch = afterUrl.match(/(?:提取码|密码|pwd)[:\s：]*([a-zA-Z0-9]{4})/i)
      if (pwdTextMatch) pwd = pwdTextMatch[1]
    }

    // 处理空格分隔的提取码（如 "https://... uftv"）
    if (!pwd) {
      const afterUrl = trimmed.substring(trimmed.indexOf(url) + url.length).trim()
      const spacePwdMatch = afterUrl.match(/^([a-zA-Z0-9]{4})$/)
      if (spacePwdMatch) pwd = spacePwdMatch[1]
    }

    // URL 已有 pwd 参数时，先去掉再重新拼接（避免重复）
    let cleanUrl = url.replace(/[?&]pwd=[a-zA-Z0-9]{4}/, '')
    if (pwd) cleanUrl += '?pwd=' + pwd

    cleaned.push(cleanUrl)
  }

  return cleaned.join('\n')

}



function onPaste(e: ClipboardEvent) {

  e.preventDefault()

  const pasted = e.clipboardData?.getData('text') || ''

  const cleaned = cleanPastedText(pasted)



  // Insert cleaned text at cursor position

  const textarea = textareaRef.value?.$el?.querySelector('textarea') as HTMLTextAreaElement | null

  if (textarea) {

    const start = textarea.selectionStart

    const end = textarea.selectionEnd

    const before = bulkText.value.substring(0, start)

    const after = bulkText.value.substring(end)

    bulkText.value = before + cleaned + after

  } else {

    bulkText.value += cleaned

  }

}



function parseLink(line: string): ParsedLink | null {

  const trimmed = line.trim()

  if (!trimmed) return null

  let url = ''

  let pwd: string | null = null

  // 简化正则：直接匹配各平台 URL
  const urlMatch = trimmed.match(/(https?:\/\/pan\.quark\.cn\/\S+)/)
    || trimmed.match(/(https?:\/\/pan\.baidu\.com\/\S+)/)
    || trimmed.match(/(https?:\/\/drive\.uc\.cn\/\S+)/)
    || trimmed.match(/(https?:\/\/pan\.xunlei\.com\/\S+)/)

  if (!urlMatch) return { url: trimmed, password: null, platform: 'unknown', valid: false, isDuplicate: false }

  url = urlMatch[1]



  // 升级百度旧链接格式
  url = url.replace(/share\/init\?surl=/, 's/1')



  // 从 URL 参数提取密码
  const pwdParamMatch = url.match(/[?&]pwd=([a-zA-Z0-9]{4})/)

  if (pwdParamMatch) pwd = pwdParamMatch[1]



  // 从 URL 后文本提取密码（提取码/密码/pwd）
  if (!pwd) {

    const afterUrl = trimmed.substring(trimmed.indexOf(url) + url.length).trim()

    const pwdTextMatch = afterUrl.match(/(?:提取码|密码|pwd)[:\s：]*([a-zA-Z0-9]{4})/i)

    if (pwdTextMatch) pwd = pwdTextMatch[1]

  }

  // 处理空格分隔的提取码（如 "https://... uftv"）
  if (!pwd) {
    const afterUrl = trimmed.substring(trimmed.indexOf(url) + url.length).trim()
    const spacePwdMatch = afterUrl.match(/^([a-zA-Z0-9]{4})$/)
    if (spacePwdMatch) pwd = spacePwdMatch[1]
  }



  let platform = 'unknown'

  if (url.includes('pan.quark.cn')) platform = 'quark'

  else if (url.includes('pan.baidu.com')) platform = 'baidu'

  else if (url.includes('drive.uc.cn')) platform = 'uc'

  else if (url.includes('pan.xunlei.com')) platform = 'xunlei'



  const valid = platform !== 'unknown'

  return { url, password: pwd, platform, valid, isDuplicate: false }

}



const parsedLinks = computed<ParsedLink[]>(() => {

  const lines = bulkText.value.split('\n')

  const seen = new Set<string>()

  const result: ParsedLink[] = []



  for (const line of lines) {

    const parsed = parseLink(line)

    if (!parsed) continue

    const key = parsed.url.toLowerCase()

    if (seen.has(key)) {

      parsed.isDuplicate = true

    } else {

      seen.add(key)

    }

    result.push(parsed)

  }

  return result

})



// 根据选择的平台过滤链接（只保留匹配当前平台的链接）
const validLinks = computed(() =>

  parsedLinks.value.filter((l) => l.valid && !l.isDuplicate && l.platform === platform.value),

)

// 被过滤掉的其他平台链接数量
const filteredOutCount = computed(() =>
  parsedLinks.value.filter((l) => l.valid && !l.isDuplicate && l.platform !== platform.value).length,
)



const duplicateCount = computed(() =>

  parsedLinks.value.filter((l) => l.isDuplicate).length,

)



const invalidCount = computed(() =>

  parsedLinks.value.filter((l) => !l.valid).length,

)



// ---- Directory picker ----



interface NavItem { id: string; name: string }



const navStack = ref<NavItem[]>([{ id: '0', name: 'root' }])

const folders = ref<FileItem[]>([])

const loadingFolders = ref(false)

const currentFolder = ref<NavItem>({ id: '0', name: 'root' })

const textareaRef = ref()



async function loadFolders(parentId: string) {

  if (!selectedAccountId.value) return



  loadingFolders.value = true

  try {

    const result = await electronApi.listFiles(selectedAccountId.value, parentId)

    if (result.success) {

      folders.value = result.files.filter((f: FileItem) => f.isDir)

    } else {

      ElMessage.error('加载目录失败')
      folders.value = []

    }

  } catch (err) {

    ElMessage.error('加载目录失败: ' + String(err))

    folders.value = []

  } finally {

    loadingFolders.value = false

  }

}



function onFolderClick(folder: FileItem) {

  navStack.value.push({ id: folder.id, name: folder.name })

  currentFolder.value = { id: folder.id, name: folder.name }

  loadFolders(folder.id)

}



function onBreadcrumbClick(index: number) {

  if (index === navStack.value.length - 1) return

  navStack.value.splice(index + 1)

  currentFolder.value = navStack.value[navStack.value.length - 1]

  loadFolders(currentFolder.value.id)

}



function onGoBack() {

  if (navStack.value.length > 1) {

    navStack.value.pop()

    currentFolder.value = navStack.value[navStack.value.length - 1]

    loadFolders(currentFolder.value.id)

  }

}



// Load folders when account changes

watch(selectedAccountId, (id) => {

  if (id) {

    navStack.value = [{ id: '0', name: 'root' }]

    currentFolder.value = { id: '0', name: 'root' }

    loadFolders('0')

  } else {

    folders.value = []

  }

})



// ---- Verify links ----

async function onVerifyLinks() {
  if (!selectedAccountId.value) return
  if (validLinks.value.length === 0) return

  const links = validLinks.value.map((l) => ({
    url: l.url,
    password: l.password || undefined,
  }))

  verifying.value = true
  try {
    const result = await electronApi.linkVerify(selectedAccountId.value, links)
    if (result.success && result.results) {
      let validCount = 0
      let invalidCount = 0
      for (const r of result.results) {
        if (r.valid) {
          validCount++
        } else {
          invalidCount++
          // Mark the link as invalid in parsedLinks
          const idx = parsedLinks.value.findIndex((l) => l.url === r.url)
          if (idx !== -1) {
            parsedLinks.value[idx].valid = false
          }
        }
      }
      if (invalidCount === 0) {
        ElMessage.success(`全部 ${validCount} 个链接有效`)
      } else {
        ElMessage.warning(`${validCount} 个有效，${invalidCount} 个无效`)
      }
    } else {
      ElMessage.error(result.error || '检测失败')
    }
  } catch (err) {
    ElMessage.error('检测失败: ' + String(err))
  } finally {
    verifying.value = false
  }
}

// ---- Submit ----



async function onSubmit() {

  if (!selectedAccountId.value) return

  if (validLinks.value.length === 0) return



  const links = validLinks.value.map((l) => ({

    url: l.url,

    password: l.password || undefined,

  }))



  submitting.value = true
  try {
    const result = await electronApi.batchTransfer(
      selectedAccountId.value,
      links,
      currentFolder.value.id === '0' ? undefined : currentFolder.value.id,
      currentFolder.value.id === '0' ? undefined : currentFolder.value.name,
      autoShare.value ? { autoShare: true } : undefined,
    )

    if (result.success) {

      ElMessage.success(`已创建转存任务（${links.length} 个链接），请在任务日志中查看进度`)

      bulkText.value = ''

    } else {

      ElMessage.error(result.error || '创建转存任务失败')

    }

  } catch (err) {

    ElMessage.error('创建转存任务失败: ' + String(err))

  } finally {

    submitting.value = false

  }

}



onMounted(async () => {

  await accountStore.fetchAccounts()

  const accs = accountStore.getAccountsByPlatform(platform.value)

  if (accs.length > 0 && !selectedAccountId.value) {

    selectedAccountId.value = accs[0].id

    await loadFolders('0')

  }

})

</script>



<style scoped>

.batch-transfer {

  height: 100%;

  display: flex;

  flex-direction: column;

  gap: 16px;

}



/* ── Page header ── */

.page-header {

  display: flex;

  align-items: center;

  padding: 20px 24px;

  background: #ffffff;

  border-radius: 12px;

  border: 1px solid #e5e7eb;

}



.header-info {

  display: flex;

  align-items: center;

  gap: 12px;

}



.header-icon {

  width: 40px;

  height: 40px;

  border-radius: 10px;

  background: #faf5ff;

  color: #a855f7;

  display: flex;

  align-items: center;

  justify-content: center;

}



.header-info h2 {

  font-size: 16px;

  font-weight: 700;

  color: #1f2937;

  margin-bottom: 2px;

}



.header-info p {

  font-size: 12px;

  color: #9ca3af;

}



/* ── Body ── */

.transfer-body {

  flex: 1;

  display: flex;

  gap: 16px;

  min-height: 0;

}



.panel {

  flex: 1;

  background: #ffffff;

  border-radius: 12px;

  border: 1px solid #e5e7eb;

  padding: 16px;

  display: flex;

  flex-direction: column;

  gap: 12px;

}



.panel-title {

  font-size: 13px;

  font-weight: 600;

  color: #374151;

}



/* ── Account bar ── */

.account-bar {

  display: flex;

  align-items: center;

  gap: 8px;

}



/* ── Textarea ── */

.textarea-wrap {

  flex: 1;

  min-height: 0;

}

.textarea-wrap :deep(.el-textarea) {

  height: 100%;

}

.textarea-wrap :deep(.el-textarea__inner) {

  height: 100% !important;

  resize: none;

  font-size: 13px;

  font-family: 'Cascadia Code', 'Fira Code', monospace;

}



/* ── Link stats ── */

.link-stats {

  display: flex;

  gap: 12px;

  font-size: 12px;

}



.stat-valid {

  display: flex;

  align-items: center;

  gap: 4px;

  color: #22c55e;

}



.stat-dup {

  display: flex;

  align-items: center;

  gap: 4px;

  color: #f59e0b;

}



.stat-invalid {

  display: flex;

  align-items: center;

  gap: 4px;

  color: #ef4444;

}



/* ── Preview ── */

.preview-list {

  max-height: 180px;

  overflow-y: auto;

  background: #f9fafb;

  border-radius: 8px;

  padding: 8px;

  display: flex;

  flex-direction: column;

  gap: 4px;

}



.preview-item {

  display: flex;

  align-items: center;

  gap: 8px;

  font-size: 12px;

  color: #374151;

  padding: 4px 8px;

  border-radius: 4px;

  background: #ffffff;

}



.preview-item.invalid {

  background: #fef2f2;

  color: #ef4444;

}



.preview-item.dup {

  background: #fffbeb;

  color: #92400e;

}



.preview-platform {

  display: inline-block;

  padding: 1px 6px;

  border-radius: 3px;

  font-size: 10px;

  font-weight: 600;

  background: #eff6ff;

  color: #3b82f6;

  flex-shrink: 0;

}



.preview-url {

  flex: 1;

  overflow: hidden;

  text-overflow: ellipsis;

  white-space: nowrap;

}



.preview-pwd {

  font-size: 11px;

  color: #6b7280;

  flex-shrink: 0;

}



.preview-tag {

  display: inline-block;

  padding: 1px 6px;

  border-radius: 3px;

  font-size: 10px;

  font-weight: 600;

  flex-shrink: 0;

}



.preview-tag.dup {

  background: #fef3c7;

  color: #92400e;

}



.preview-tag.invalid {

  background: #fecaca;

  color: #991b1b;

}



.preview-more {

  font-size: 12px;

  color: #9ca3af;

  text-align: center;

}



/* ── Directory picker ── */

.dir-empty {

  flex: 1;

  display: flex;

  flex-direction: column;

  align-items: center;

  justify-content: center;

  gap: 8px;

  color: #d1d5db;

}

.dir-empty p {

  font-size: 13px;

  color: #9ca3af;

}



.folder-nav {

  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 8px;

  padding: 8px 12px;

  background: #f9fafb;

  border-radius: 8px;

  border: 1px solid #e5e7eb;

}



.folder-breadcrumb {

  display: flex;

  align-items: center;

  gap: 2px;

  min-width: 0;

  flex: 1;

  overflow: hidden;

}



.crumb {

  font-size: 13px;

  color: #6b7280;

  cursor: pointer;

  padding: 2px 6px;

  border-radius: 4px;

  white-space: nowrap;

}

.crumb:hover { background: #e5e7eb; color: #3b82f6; }

.crumb.active { color: #1f2937; font-weight: 600; cursor: default; }

.crumb.active:hover { background: transparent; }

.crumb-sep { color: #d1d5db; flex-shrink: 0; }



.nav-btn {

  width: 28px;

  height: 28px;

  display: flex;

  align-items: center;

  justify-content: center;

  border: none;

  background: #e5e7eb;

  border-radius: 6px;

  color: #6b7280;

  cursor: pointer;

  flex-shrink: 0;

}

.nav-btn:hover:not(:disabled) { background: #d1d5db; color: #374151; }

.nav-btn:disabled { opacity: 0.4; cursor: not-allowed; }



.folder-list {

  flex: 1;

  min-height: 0;

  overflow-y: auto;

  border: 1px solid #e5e7eb;

  border-radius: 8px;

}



.folder-empty {

  display: flex;

  flex-direction: column;

  align-items: center;

  gap: 6px;

  padding: 40px 0;

  color: #d1d5db;

}

.folder-empty span { font-size: 13px; color: #9ca3af; }



.folder-item {

  display: flex;

  align-items: center;

  gap: 10px;

  padding: 10px 14px;

  cursor: pointer;

  color: #374151;

  border-bottom: 1px solid #f3f4f6;

  transition: background 0.1s;

}

.folder-item:last-child { border-bottom: none; }

.folder-item:hover { background: #f9fafb; }



.folder-name { flex: 1; font-size: 13px; }

.folder-arrow { color: #d1d5db; flex-shrink: 0; }



.target-info {

  font-size: 13px;

  color: #6b7280;

  padding: 4px 0;

}



/* ── Options bar ── */
.options-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 20px;
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
}
.options-bar .el-checkbox {
  margin-right: 0;
}

/* ── Submit bar ── */

.submit-bar {

  display: flex;

  align-items: center;

  justify-content: space-between;

  padding: 12px 20px;

  background: #ffffff;

  border-radius: 12px;

  border: 1px solid #e5e7eb;

}



.submit-info {

  font-size: 13px;

  color: #6b7280;

}

/* Shared light workflow surfaces */
.batch-transfer { gap: var(--pl-space-4); }
.page-header, .panel, .options-bar, .submit-bar { border-color: var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }
.page-header { padding: var(--pl-space-5) var(--pl-space-6); }
.header-icon { background: var(--pl-primary-soft); color: var(--pl-primary); border-radius: var(--pl-radius-control); }
.header-info h2, .panel-title, .folder-name, .preview-item { color: var(--pl-text); }
.header-info p, .submit-info, .target-info { color: var(--pl-text-secondary); }
.transfer-body { gap: var(--pl-space-4); }
.panel { padding: var(--pl-space-5); gap: var(--pl-space-3); }
.textarea-wrap :deep(.el-textarea__inner) { border-color: var(--pl-border); background: var(--pl-surface-subtle); color: var(--pl-text); }
.preview-list { background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-control); }
.preview-item { border: 1px solid var(--pl-border); }
.preview-item.invalid { background: var(--pl-danger-soft); color: var(--pl-danger); }
.preview-item.dup { background: var(--pl-warning-soft); color: #9a6700; }
.preview-platform { background: var(--pl-primary-soft); color: var(--pl-primary); }
.stat-valid { color: var(--pl-success); }
.stat-dup { color: var(--pl-warning); }
.stat-invalid { color: var(--pl-danger); }
.folder-nav { background: var(--pl-surface-subtle); border-color: var(--pl-border); border-radius: var(--pl-radius-control); }
.crumb { color: var(--pl-text-secondary); }
.crumb:hover { background: var(--pl-primary-soft); color: var(--pl-primary); }
.crumb.active { color: var(--pl-text); }
.nav-btn { background: var(--pl-primary-soft); color: var(--pl-primary); border-radius: var(--pl-radius-sm); }
.nav-btn:hover:not(:disabled) { background: #d8e7ff; color: var(--pl-primary-hover); }
.folder-list { border-color: var(--pl-border); border-radius: var(--pl-radius-control); }
.folder-item { border-bottom-color: var(--pl-surface-subtle); color: var(--pl-text); }
.folder-item:hover { background: var(--pl-surface-subtle); }
.options-bar { padding: var(--pl-space-3) var(--pl-space-5); }
.submit-bar { padding: var(--pl-space-3) var(--pl-space-5); }
@media (max-width: 900px) { .transfer-body { flex-direction: column; overflow-y: auto; } .panel { min-height: 360px; } }
@media (max-width: 560px) {
  .page-header, .panel { padding: var(--pl-space-4); }
  .account-bar { flex-wrap: wrap; }
  .options-bar { flex-wrap: wrap; gap: var(--pl-space-2); }
  .submit-bar { align-items: stretch; flex-direction: column; gap: var(--pl-space-3); }
  .submit-bar .el-button { width: 100%; }
}

/* Workflow hierarchy and interaction */
.workflow-steps {
  display: grid;
  grid-template-columns: max-content minmax(32px, 1fr) max-content minmax(32px, 1fr) max-content;
  align-items: center;
  gap: var(--pl-space-3);
  padding: var(--pl-space-3) var(--pl-space-5);
  background: var(--pl-surface);
  border: 1px solid var(--pl-border);
  border-radius: var(--pl-radius-card);
  box-shadow: var(--pl-shadow-card);
}

.workflow-step { display: flex; align-items: center; gap: var(--pl-space-2); min-width: 0; color: var(--pl-text-muted); transition: color 180ms ease, transform 180ms ease; }
.workflow-step.active { color: var(--pl-primary); transform: translateY(-1px); }
.workflow-step.complete { color: var(--pl-success); }
.step-index { width: 28px; height: 28px; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid var(--pl-border-strong); border-radius: 50%; background: var(--pl-surface-subtle); font-size: 12px; font-weight: 700; transition: all 180ms ease; }
.workflow-step.active .step-index { color: var(--pl-primary); background: var(--pl-primary-soft); border-color: var(--pl-primary); box-shadow: 0 0 0 4px var(--pl-primary-soft); }
.workflow-step.complete .step-index { color: var(--pl-success); background: var(--pl-success-soft); border-color: var(--pl-success); }
.step-copy { display: flex; flex-direction: column; line-height: 1.25; }
.step-copy strong { color: var(--pl-text); font-size: 12px; font-weight: 650; white-space: nowrap; }
.step-copy small { margin-top: 2px; font-size: 10px; color: currentColor; white-space: nowrap; }
.step-line { height: 1px; min-width: 24px; background: var(--pl-border); transition: background 180ms ease; }
.step-line.complete { background: var(--pl-success); }

.panel { overflow: hidden; transition: border-color 180ms ease, box-shadow 180ms ease; }
.panel:hover { border-color: var(--pl-border-strong); box-shadow: var(--pl-shadow-float); }
.panel-heading { display: flex; align-items: center; gap: var(--pl-space-3); min-height: 36px; }
.panel-heading > div:nth-child(2) { min-width: 0; }
.panel-step { width: 34px; height: 34px; display: grid; place-items: center; flex: 0 0 auto; border-radius: var(--pl-radius-sm); color: var(--pl-primary); background: var(--pl-primary-soft); font-size: 11px; font-weight: 750; letter-spacing: .04em; }
.panel-title { font-size: 14px; font-weight: 700; }
.panel-hint { margin-top: 2px; color: var(--pl-text-muted); font-size: 11px; line-height: 1.35; }
.selection-count { margin-left: auto; padding: 4px 9px; border-radius: 999px; background: var(--pl-success-soft); color: var(--pl-success); font-size: 11px; font-weight: 650; white-space: nowrap; }

.account-bar { padding: var(--pl-space-2); border-radius: var(--pl-radius-control); background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); }
.textarea-wrap :deep(.el-textarea__inner) { padding: 14px; line-height: 1.7; transition: background 150ms ease, box-shadow 150ms ease; }
.textarea-wrap :deep(.el-textarea__inner:focus) { background: var(--pl-surface); }
.link-stats { flex-wrap: wrap; gap: var(--pl-space-2); }
.link-stats > span { padding: 4px 8px; border-radius: 999px; background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); }
.preview-item { min-height: 34px; transition: transform 150ms ease, box-shadow 150ms ease; }
.preview-item:hover { transform: translateX(2px); box-shadow: var(--pl-shadow-card); }

.dir-empty { text-align: center; }
.dir-empty strong { color: var(--pl-text-secondary); font-size: 13px; }
.empty-icon { width: 52px; height: 52px; display: grid; place-items: center; border-radius: 16px; color: var(--pl-primary); background: var(--pl-primary-soft); }
.folder-item { min-height: 46px; transition: background 150ms ease, padding 150ms ease, color 150ms ease; }
.folder-item:hover { padding-left: 18px; color: var(--pl-primary-hover); background: var(--pl-primary-soft); }
.folder-item:hover .folder-arrow { color: var(--pl-primary); transform: translateX(2px); }
.folder-arrow { transition: color 150ms ease, transform 150ms ease; }
.target-info { display: flex; align-items: center; gap: var(--pl-space-2); padding: var(--pl-space-2) var(--pl-space-3); border-radius: var(--pl-radius-control); background: var(--pl-success-soft); }
.target-info strong { color: var(--pl-success); }
.target-ready { margin-left: auto; padding: 2px 7px; border-radius: 999px; color: var(--pl-success); background: var(--pl-surface); font-size: 10px; font-weight: 650; }

.options-bar { gap: var(--pl-space-3); }
.options-heading { display: flex; align-items: center; gap: var(--pl-space-3); margin-right: var(--pl-space-1); min-width: 170px; }
.options-heading > div { display: flex; flex-direction: column; }
.options-heading strong { color: var(--pl-text); font-size: 13px; }
.options-heading small { color: var(--pl-text-muted); font-size: 10px; }
.option-card { display: flex; align-items: center; gap: var(--pl-space-2); flex: 1; min-width: 180px; padding: 8px 10px; border: 1px solid var(--pl-border); border-radius: var(--pl-radius-control); background: var(--pl-surface-subtle); cursor: pointer; transition: border-color 150ms ease, background 150ms ease, transform 150ms ease; }
.option-card:hover { border-color: var(--pl-primary); transform: translateY(-1px); }
.option-card.selected { border-color: var(--pl-primary); background: var(--pl-primary-soft); }
.option-card > span { display: flex; flex-direction: column; min-width: 0; }
.option-card strong { color: var(--pl-text); font-size: 11px; font-weight: 650; }
.option-card small { color: var(--pl-text-muted); font-size: 10px; white-space: nowrap; }
.verify-button { margin-left: auto; flex: 0 0 auto; }

.submit-bar { min-height: 64px; border-color: var(--pl-border-strong); box-shadow: var(--pl-shadow-float); }
.submit-info { display: flex; align-items: center; gap: var(--pl-space-2); min-width: 0; }
.submit-info strong { color: var(--pl-primary); }
.submit-state-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--pl-warning); box-shadow: 0 0 0 4px var(--pl-warning-soft); }
.submit-bar :deep(.el-button) { min-width: 132px; box-shadow: 0 6px 16px rgba(52, 120, 246, .18); transition: transform 150ms ease, box-shadow 150ms ease; }
.submit-bar :deep(.el-button:not(.is-disabled):hover) { transform: translateY(-1px); box-shadow: 0 8px 20px rgba(52, 120, 246, .24); }
.submit-bar :deep(.el-button.is-disabled) { box-shadow: none; }

@media (max-width: 1120px) {
  .options-bar { flex-wrap: wrap; }
  .options-heading { width: 100%; }
  .verify-button { margin-left: 0; }
}

@media (max-width: 760px) {
  .workflow-steps { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--pl-space-2); }
  .step-line { display: none; }
  .step-copy small { display: none; }
  .workflow-step { justify-content: center; }
}

@media (max-width: 560px) {
  .workflow-steps { padding: var(--pl-space-3); }
  .step-copy strong { font-size: 11px; }
  .panel-heading { align-items: flex-start; }
  .panel-hint { display: none; }
  .selection-count { align-self: center; }
  .option-card { min-width: 100%; }
  .verify-button { width: 100%; }
}
</style>

