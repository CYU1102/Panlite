<template>
  <div class="cloud-transfer">
    <div class="page-header">
      <div class="header-icon"><ArrowRightLeft :size="20" :stroke-width="1.6" /></div>
      <div>
        <h2>云端迁移</h2>
        <p>在账号和网盘之间迁移文件，自动保留目录结构</p>
      </div>
    </div>

    <el-alert
      v-if="accounts.length === 0"
      title="请先添加网盘账号"
      type="warning"
      :closable="false"
      show-icon
    />

    <el-alert
      v-else-if="baiduCookieSource"
      title="百度云端迁移需要 OAuth 授权"
      type="warning"
      :closable="false"
      show-icon
    >
      <template #default>
        当前百度源账号是 Cookie 登录。百度官方接口会拒绝下载直链（9019 need verify），请在
        <el-button link type="primary" @click="router.push('/accounts')">账号管理</el-button>
        中新增并完成百度 OAuth 授权账号后再迁移。
      </template>
    </el-alert>

    <div class="transfer-grid">
      <section class="panel">
        <div class="panel-title">1. 选择源文件</div>
        <el-select v-model="sourceAccountId" placeholder="选择源账号" filterable class="account-select">
          <el-option
            v-for="account in accounts"
            :key="account.id"
            :label="accountLabel(account)"
            :value="account.id"
            :disabled="account.status !== 'active'"
          />
        </el-select>

        <div class="folder-nav">
          <button class="nav-button" :disabled="sourceNav.length <= 1" @click="sourceBack">
            <ArrowLeft :size="15" />
          </button>
          <div class="breadcrumbs">
            <template v-for="(item, index) in sourceNav" :key="item.id">
              <ChevronRight v-if="index > 0" :size="13" class="separator" />
              <button class="crumb" :class="{ active: index === sourceNav.length - 1 }" @click="sourceBreadcrumb(index)">
                {{ item.name }}
              </button>
            </template>
          </div>
          <button class="nav-button" :disabled="!sourceAccountId" @click="loadSourceFiles(sourceCurrentId)">
            <RefreshCw :size="15" />
          </button>
        </div>

        <div class="file-list" v-loading="sourceLoading">
          <div v-if="!sourceLoading && sourceFiles.length === 0" class="empty-state">
            <FolderOpen :size="30" :stroke-width="1" />
            <span>{{ sourceAccountId ? '此文件夹为空' : '请选择源账号' }}</span>
          </div>
          <div
            v-for="file in sourceFiles"
            :key="file.id"
            class="file-row"
            :class="{ selected: selectedIds.has(file.id) }"
            @click="toggleSource(file)"
          >
            <el-checkbox :model-value="selectedIds.has(file.id)" @click.stop @change="toggleSource(file)" />
            <FolderOpen v-if="file.isDir" :size="17" class="folder-icon" />
            <File v-else :size="17" class="file-icon" />
            <span class="file-name" :title="file.name">{{ file.name }}</span>
            <span class="file-size">{{ file.isDir ? '文件夹' : formatSize(file.size) }}</span>
            <button v-if="file.isDir" class="enter-button" @click.stop="enterSource(file)">
              <ChevronRight :size="15" />
            </button>
          </div>
        </div>

        <div class="selection-summary">
          <span>已选 {{ selectedFiles.length }} 项</span>
          <el-button v-if="selectedFiles.length" text size="small" @click="selectedFiles = []">清空</el-button>
        </div>
      </section>

      <div class="direction"><ArrowRightLeft :size="22" /></div>

      <section class="panel">
        <div class="panel-title">2. 选择目标目录</div>
        <el-select v-model="targetAccountId" placeholder="选择目标账号" filterable class="account-select">
          <el-option
            v-for="account in accounts"
            :key="account.id"
            :label="accountLabel(account)"
            :value="account.id"
            :disabled="account.status !== 'active'"
          />
        </el-select>

        <div class="folder-nav">
          <button class="nav-button" :disabled="targetNav.length <= 1" @click="targetBack">
            <ArrowLeft :size="15" />
          </button>
          <div class="breadcrumbs">
            <template v-for="(item, index) in targetNav" :key="item.id">
              <ChevronRight v-if="index > 0" :size="13" class="separator" />
              <button class="crumb" :class="{ active: index === targetNav.length - 1 }" @click="targetBreadcrumb(index)">
                {{ item.name }}
              </button>
            </template>
          </div>
          <button class="nav-button" :disabled="!targetAccountId" @click="loadTargetFolders(targetCurrentId)">
            <RefreshCw :size="15" />
          </button>
        </div>

        <div class="file-list" v-loading="targetLoading">
          <div v-if="!targetLoading && targetFolders.length === 0" class="empty-state">
            <FolderOpen :size="30" :stroke-width="1" />
            <span>{{ targetAccountId ? '此目录没有子文件夹' : '请选择目标账号' }}</span>
          </div>
          <button v-for="folder in targetFolders" :key="folder.id" class="folder-row" @click="enterTarget(folder)">
            <FolderOpen :size="17" class="folder-icon" />
            <span class="file-name" :title="folder.name">{{ folder.name }}</span>
            <ChevronRight :size="15" />
          </button>
        </div>

        <div class="target-summary">
          <span>目标位置</span>
          <strong>{{ targetPathLabel }}</strong>
        </div>
      </section>
    </div>

    <div class="options-bar">
      <div class="option-field">
        <span>同名文件</span>
        <el-select v-model="conflictPolicy" style="width: 150px">
          <el-option label="自动重命名" value="rename" />
          <el-option label="跳过" value="skip" />
          <el-option label="覆盖" value="overwrite" />
        </el-select>
      </div>
      <el-alert :title="transferModeText" type="info" :closable="false" show-icon class="mode-alert" />
      <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submitTransfer">
        开始迁移
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { ArrowLeft, ArrowRightLeft, ChevronRight, File, FolderOpen, RefreshCw } from 'lucide-vue-next'
import type { DriveAccount, FileConflictPolicy, FileItem } from '@shared/types'
import { PLATFORM_LABELS } from '@shared/constants'
import { getPlatformCapabilities } from '@shared/capabilities'
import { isTargetInsideSelectedDirectory, selectCloudTransferMode } from '@shared/cloud-transfer'
import { electronApi } from '../api/ipc'
import { useAccountStore } from '../stores/account'

type SafeAccount = Omit<DriveAccount, 'credential'>
interface NavItem { id: string; name: string }

const router = useRouter()
const accountStore = useAccountStore()
const sourceAccountId = ref('')
const targetAccountId = ref('')
const sourceNav = ref<NavItem[]>([{ id: '0', name: '根目录' }])
const targetNav = ref<NavItem[]>([{ id: '0', name: '根目录' }])
const sourceFiles = ref<FileItem[]>([])
const targetFolders = ref<FileItem[]>([])
const selectedFiles = ref<FileItem[]>([])
const sourceLoading = ref(false)
const targetLoading = ref(false)
const submitting = ref(false)
const conflictPolicy = ref<FileConflictPolicy>('rename')

const accounts = computed(() => accountStore.accounts)
const sourceAccount = computed(() => accounts.value.find((account) => account.id === sourceAccountId.value))
const targetAccount = computed(() => accounts.value.find((account) => account.id === targetAccountId.value))
const sourceCurrentId = computed(() => sourceNav.value[sourceNav.value.length - 1]?.id || '0')
const targetCurrentId = computed(() => targetNav.value[targetNav.value.length - 1]?.id || '0')
const targetPathLabel = computed(() => targetNav.value.map((item) => item.name).join(' / '))
const selectedIds = computed(() => new Set(selectedFiles.value.map((file) => file.id)))
const baiduCookieSource = computed(() => Boolean(
  sourceAccount.value?.platform === 'baidu' && sourceAccount.value.loginType !== 'oauth',
))
const canSubmit = computed(() => Boolean(
  sourceAccount.value && targetAccount.value && selectedFiles.value.length && !baiduCookieSource.value,
))
const transferModeText = computed(() => {
  if (!sourceAccount.value || !targetAccount.value) return '选择源账号和目标账号后显示迁移方式'
  const mode = selectCloudTransferMode({
    sameAccount: sourceAccount.value.id === targetAccount.value.id,
    samePlatform: sourceAccount.value.platform === targetAccount.value.platform,
    conflictPolicy: conflictPolicy.value,
    canNativeCopy: getPlatformCapabilities(sourceAccount.value.platform).copy,
    canSharedTransfer: true,
  })
  if (mode === 'native_copy') return '迁移方式：网盘原生云端复制'
  if (mode === 'shared_transfer') return '迁移方式：同平台云端转存，不占用本地带宽'
  return '迁移方式：源网盘官方下载 → 目标网盘官方上传，临时文件完成后清理'
})

function accountLabel(account: SafeAccount): string {
  const authLabel = account.platform === 'baidu'
    ? (account.loginType === 'oauth' ? 'OAuth 可下载' : 'Cookie 仅网页')
    : ''
  return `${PLATFORM_LABELS[account.platform]} · ${account.nickname || account.id}${authLabel ? `（${authLabel}）` : ''}`
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

async function loadSourceFiles(parentId: string): Promise<void> {
  if (!sourceAccountId.value) return
  sourceLoading.value = true
  try {
    const result = await electronApi.listFiles(sourceAccountId.value, parentId)
    if (!result.success) throw new Error(result.error || '加载源目录失败')
    sourceFiles.value = result.files
  } catch (err) {
    sourceFiles.value = []
    ElMessage.error(String(err))
  } finally {
    sourceLoading.value = false
  }
}

async function loadTargetFolders(parentId: string): Promise<void> {
  if (!targetAccountId.value) return
  targetLoading.value = true
  try {
    const result = await electronApi.listFiles(targetAccountId.value, parentId)
    if (!result.success) throw new Error(result.error || '加载目标目录失败')
    targetFolders.value = result.files.filter((file: FileItem) => file.isDir)
  } catch (err) {
    targetFolders.value = []
    ElMessage.error(String(err))
  } finally {
    targetLoading.value = false
  }
}

function toggleSource(file: FileItem): void {
  const index = selectedFiles.value.findIndex((item) => item.id === file.id)
  if (index >= 0) selectedFiles.value.splice(index, 1)
  else selectedFiles.value.push(file)
}

function enterSource(file: FileItem): void {
  sourceNav.value.push({ id: file.id, name: file.name })
  loadSourceFiles(file.id)
}

function sourceBreadcrumb(index: number): void {
  if (index === sourceNav.value.length - 1) return
  sourceNav.value.splice(index + 1)
  loadSourceFiles(sourceCurrentId.value)
}

function sourceBack(): void {
  if (sourceNav.value.length <= 1) return
  sourceNav.value.pop()
  loadSourceFiles(sourceCurrentId.value)
}

function enterTarget(folder: FileItem): void {
  targetNav.value.push({ id: folder.id, name: folder.name })
  loadTargetFolders(folder.id)
}

function targetBreadcrumb(index: number): void {
  if (index === targetNav.value.length - 1) return
  targetNav.value.splice(index + 1)
  loadTargetFolders(targetCurrentId.value)
}

function targetBack(): void {
  if (targetNav.value.length <= 1) return
  targetNav.value.pop()
  loadTargetFolders(targetCurrentId.value)
}

async function submitTransfer(): Promise<void> {
  if (!sourceAccount.value || !targetAccount.value || selectedFiles.value.length === 0) return
  const targetAncestorIds = targetNav.value.map((item) => item.id)
  if (sourceAccount.value.id === targetAccount.value.id
    && isTargetInsideSelectedDirectory(
      selectedFiles.value.map((file) => ({ fileId: file.id, isDir: file.isDir })),
      targetAncestorIds,
    )) {
    ElMessage.warning('不能把文件夹迁移到自身或其子目录')
    return
  }
  submitting.value = true
  try {
    const result = await electronApi.cloudTransfer({
      sourceAccountId: sourceAccount.value.id,
      targetAccountId: targetAccount.value.id,
      files: selectedFiles.value.map((file) => ({
        fileId: file.id,
        fileName: file.name,
        fileSize: file.size,
        isDir: file.isDir,
        path: file.path,
      })),
      targetDirId: targetCurrentId.value,
      targetPath: targetPathLabel.value,
      targetAncestorIds,
      conflictPolicy: conflictPolicy.value,
    })
    if (!result.success) throw new Error(result.error || '创建迁移任务失败')
    ElMessage.success('迁移任务已创建')
    await router.push('/tasks')
  } catch (err) {
    ElMessage.error(String(err))
  } finally {
    submitting.value = false
  }
}

watch(sourceAccountId, (accountId) => {
  sourceNav.value = [{ id: '0', name: '根目录' }]
  sourceFiles.value = []
  selectedFiles.value = []
  if (accountId) loadSourceFiles('0')
})

watch(targetAccountId, (accountId) => {
  targetNav.value = [{ id: '0', name: '根目录' }]
  targetFolders.value = []
  if (accountId) loadTargetFolders('0')
})

onMounted(async () => {
  await accountStore.fetchAccounts()
  const activeAccounts = accounts.value.filter((account) => account.status === 'active')
  sourceAccountId.value = activeAccounts[0]?.id || ''
  targetAccountId.value = activeAccounts[1]?.id || activeAccounts[0]?.id || ''
})
</script>

<style scoped>
.cloud-transfer { min-height: 100%; height: auto; display: flex; flex-direction: column; gap: var(--pl-space-4); }
.page-header { flex-shrink: 0; display: flex; align-items: center; gap: var(--pl-space-3); padding: var(--pl-space-5) var(--pl-space-6); background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }
.page-header h2 { margin: 0 0 2px; color: var(--pl-text); font-size: 16px; }
.page-header p { margin: 0; color: var(--pl-text-secondary); font-size: 12px; }
.header-icon { width: 40px; height: 40px; display: grid; place-items: center; color: var(--pl-primary); background: var(--pl-primary-soft); border-radius: var(--pl-radius-control); }
.transfer-grid { flex: 0 0 auto; height: clamp(560px, calc(100vh - 330px), 900px); min-height: 560px; display: grid; grid-template-columns: minmax(0, 1fr) 44px minmax(0, 1fr); align-items: stretch; }
.panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--pl-space-3); padding: var(--pl-space-5); background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }
.panel-title { color: var(--pl-text); font-size: 13px; font-weight: 700; }
.account-select { width: 100%; }
.direction { display: grid; place-items: center; color: var(--pl-primary); }
.folder-nav { display: flex; align-items: center; gap: var(--pl-space-2); min-height: 38px; padding: 5px 8px; background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-control); }
.breadcrumbs { min-width: 0; flex: 1; display: flex; align-items: center; overflow: hidden; }
.separator { flex-shrink: 0; color: var(--pl-text-muted); }
.crumb, .nav-button, .enter-button { border: 0; background: transparent; color: var(--pl-text-secondary); cursor: pointer; }
.crumb { overflow: hidden; padding: 4px 5px; white-space: nowrap; text-overflow: ellipsis; border-radius: var(--pl-radius-sm); }
.crumb:hover, .crumb.active { color: var(--pl-primary); background: var(--pl-primary-soft); }
.nav-button { width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--pl-radius-sm); }
.nav-button:hover:not(:disabled), .enter-button:hover { color: var(--pl-primary); background: var(--pl-primary-soft); }
.nav-button:disabled { opacity: .35; cursor: not-allowed; }
.file-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; border: 1px solid var(--pl-border); border-radius: var(--pl-radius-control); }
.file-row, .folder-row { width: 100%; min-height: 42px; display: flex; align-items: center; gap: 9px; padding: 8px 12px; color: var(--pl-text); background: var(--pl-surface); border: 0; border-bottom: 1px solid var(--pl-surface-subtle); text-align: left; }
.file-row { cursor: pointer; }
.file-row:hover, .folder-row:hover, .file-row.selected { background: var(--pl-primary-soft); }
.folder-row { cursor: pointer; }
.folder-icon { flex-shrink: 0; color: var(--pl-warning); }
.file-icon { flex-shrink: 0; color: var(--pl-text-muted); }
.file-name { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; }
.file-size { flex-shrink: 0; color: var(--pl-text-muted); font-size: 11px; }
.enter-button { width: 26px; height: 26px; display: grid; flex-shrink: 0; place-items: center; border-radius: var(--pl-radius-sm); }
.empty-state { height: 100%; min-height: 180px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--pl-text-muted); font-size: 12px; }
.selection-summary, .target-summary { min-height: 34px; display: flex; align-items: center; justify-content: space-between; color: var(--pl-text-secondary); font-size: 12px; }
.target-summary strong { max-width: 70%; overflow: hidden; color: var(--pl-text); white-space: nowrap; text-overflow: ellipsis; }
.options-bar { flex-shrink: 0; display: flex; align-items: center; gap: var(--pl-space-4); padding: var(--pl-space-3) var(--pl-space-5); background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }
.option-field { display: flex; align-items: center; gap: var(--pl-space-2); color: var(--pl-text-secondary); font-size: 12px; }
.mode-alert { flex: 1; padding-top: 7px; padding-bottom: 7px; }
@media (max-width: 900px) {
  .transfer-grid { height: auto; min-height: 0; display: flex; flex-direction: column; gap: var(--pl-space-3); }
  .direction { min-height: 32px; transform: rotate(90deg); }
  .panel { min-height: 460px; }
  .options-bar { align-items: stretch; flex-direction: column; }
}
</style>
