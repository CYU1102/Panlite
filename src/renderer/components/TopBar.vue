<template>
  <div class="topbar">
    <div class="topbar-accounts" aria-label="当前网盘账号">
      <div class="select-group">
        <span class="select-label">网盘</span>
        <el-select v-model="platformModel" class="platform-select" aria-label="选择网盘" @change="onPlatformChange">
          <el-option v-for="option in platformOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </div>
      <el-select v-model="selectedAccountId" placeholder="选择账号" class="account-select-control" aria-label="选择账号" @change="onAccountChange" filterable>
        <el-option v-for="acc in filteredAccounts" :key="acc.id" :label="acc.nickname || acc.id" :value="acc.id" />
        <template #empty><div class="select-empty">暂无账号，请先添加</div></template>
      </el-select>
    </div>
    <div class="search-box">
      <el-autocomplete v-model="searchInput" :fetch-suggestions="fetchSearchSuggestions" :trigger-on-focus="true" placeholder="搜索当前网盘文件" aria-label="搜索当前网盘文件" clearable @keyup.enter="onSearch" @clear="onClearSearch" @focus="loadSearchHistory" @select="onHistorySelect">
        <template #prefix><Search :size="15" /></template>
        <template #default="{ item }"><div class="history-option"><span>{{ item.value }}</span><small>{{ item.resultCount }} 项</small></div></template>
      </el-autocomplete>
    </div>
    <div class="topbar-actions">
      <el-button type="primary" :disabled="!appStore.currentAccount" title="上传到当前目录" aria-label="上传到当前目录" @click="showUpload = true"><Upload :size="15" /><span>上传</span></el-button>
      <el-button title="添加网盘账号" aria-label="添加网盘账号" @click="showAddAccount = true"><Plus :size="15" /><span>添加账号</span></el-button>
      <el-button title="搜索公开资源" aria-label="搜索公开资源" @click="$router.push('/resource-search')"><Radar :size="15" /><span>搜资源</span></el-button>
    </div>

    <AddAccountDialog v-if="showAddAccount" v-model="showAddAccount" @success="onAccountAdded" />
    <UploadDialog
      v-if="showUpload" v-model="showUpload"
      :account="appStore.currentAccount"
      :target-dir-id="appStore.currentPath"
      :target-dir-name="appStore.currentPathName"
      @success="onUploadCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent, ref, computed, onMounted, watch } from 'vue'
import { Plus, Search, Upload, Radar } from 'lucide-vue-next'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { useAppStore } from '../stores/app'
import { useAccountStore } from '../stores/account'
import type { Platform } from '@shared/types'
import { PLATFORM_CAPABILITIES } from '@shared/capabilities'
import { PLATFORM_LABELS } from '@shared/constants'
const AddAccountDialog = defineAsyncComponent(() => import('./AddAccountDialog.vue'))
const UploadDialog = defineAsyncComponent(() => import('./UploadDialog.vue'))
import { electronApi } from '../api/ipc'

const appStore = useAppStore()

// 平台选项跟随能力注册表，新增平台自动出现
const platformOptions = (Object.keys(PLATFORM_CAPABILITIES) as Platform[]).map((value) => ({
  value,
  label: (PLATFORM_LABELS as Record<string, string>)[value] || value,
}))
const accountStore = useAccountStore()

const showAddAccount = ref(false)
const showUpload = ref(false)
const searchInput = ref(appStore.searchKeyword)
const selectedAccountId = ref('')
const searchHistory = ref<Array<{ value: string; resultCount: number }>>([])

const platformModel = computed({
  get: () => appStore.currentPlatform,
  set: (value: Platform) => { appStore.currentPlatform = value },
})

const filteredAccounts = computed(() => accountStore.getAccountsByPlatform(appStore.currentPlatform))

watch(() => appStore.currentAccount?.id, (id) => {
  selectedAccountId.value = id || ''
  searchHistory.value = []
  if (id) void loadSearchHistory()
}, { immediate: true })

watch(() => appStore.searchKeyword, (keyword) => { searchInput.value = keyword })

async function loadSearchHistory() {
  const accountId = appStore.currentAccount?.id
  if (!accountId) {
    searchHistory.value = []
    return
  }
  try {
    const result = await electronApi.getSearchHistory(accountId)
    if (!result.success || appStore.currentAccount?.id !== accountId) return
    searchHistory.value = (result.history || []).map((item) => ({
      value: item.keyword,
      resultCount: item.result_count,
    }))
  } catch {
    if (appStore.currentAccount?.id === accountId) searchHistory.value = []
  }
}

function fetchSearchSuggestions(query: string, callback: (items: Array<{ value: string; resultCount: number }>) => void) {
  const normalized = query.trim().toLocaleLowerCase()
  callback(normalized
    ? searchHistory.value.filter((item) => item.value.toLocaleLowerCase().includes(normalized))
    : searchHistory.value)
}

function onHistorySelect(item: { value: string }) {
  searchInput.value = item.value
  onSearch()
}

function onPlatformChange(val: string | number) {
  appStore.setPlatform(val as Platform)
  selectedAccountId.value = ''
}

function onAccountChange(accountId: string) {
  const account = accountStore.accounts.find((a) => a.id === accountId) || null
  appStore.setAccount(account as any)
}

function onSearch() {
  const keyword = searchInput.value.trim()
  if (!keyword) return
  if (!appStore.currentAccount) {
    ElMessage.warning('请先选择账号')
    return
  }
  appStore.startSearch(keyword)
}

function onClearSearch() {
  appStore.clearSearch()
}

function onAccountAdded() {
  accountStore.fetchAccounts()
}

function onUploadCreated() {
  appStore.refreshKey++
}

onMounted(() => {
  accountStore.fetchAccounts()
})
</script>

<style scoped>
.topbar { width: 100%; min-width: 0; display: flex; align-items: center; gap: 16px; }
.topbar-accounts { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.select-group { display: flex; align-items: center; gap: 8px; }
.select-label { color: var(--pl-text-muted); font-size: var(--pl-font-xs); white-space: nowrap; }
.platform-select { width: 132px; }
.account-select-control { width: 166px; }
.search-box { flex: 1; min-width: 140px; max-width: 420px; margin-left: auto; }
.search-box :deep(.el-autocomplete) { width: 100%; }
.topbar-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.topbar-actions :deep(.el-button) { margin-left: 0; }
.topbar-actions :deep(.el-button > span) { gap: 5px; }
.history-option { display: flex; justify-content: space-between; align-items: center; gap: 20px; width: 100%; }
.history-option small, .select-empty { color: var(--pl-text-muted); }
.select-empty { padding: 12px 0; text-align: center; font-size: 13px; }
@media (max-width: 1100px) {
  .topbar { gap: 10px; }
  .select-label { display: none; }
  .platform-select { width: 114px; }
  .account-select-control { width: 140px; }
  .topbar-actions { gap: 5px; }
  .topbar-actions :deep(.el-button:not(.el-button--primary)) { padding: 8px; }
  .topbar-actions :deep(.el-button:not(.el-button--primary) > span > span) { display: none; }
}
@media (max-width: 720px) {
  .topbar { flex-wrap: wrap; }
  .topbar-accounts { flex: 1; }
  .search-box { order: 3; max-width: none; flex-basis: 100%; }
}
</style>
