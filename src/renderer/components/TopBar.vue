<template>
  <div class="topbar">
    <div class="topbar-left">
      <el-button type="primary" @click="showAddAccount = true">
        <Plus :size="14" style="margin-right: 4px" />
        添加账号
      </el-button>
      <el-button :disabled="!appStore.currentAccount" @click="showUpload = true">
        <Upload :size="14" style="margin-right: 4px" />
        上传
      </el-button>
      <el-button @click="$router.push('/resource-search')">
        <Radar :size="14" style="margin-right: 4px" />
        搜资源
      </el-button>
    </div>

    <div class="topbar-center">
      <div class="select-group">
        <span class="select-label">平台</span>
        <el-select
          v-model="platformModel"
          class="platform-select"
          @change="onPlatformChange"
        >
          <el-option
            v-for="platformOption in platformOptions"
            :key="platformOption.value"
            :label="platformOption.label"
            :value="platformOption.value"
          />
        </el-select>
      </div>
      <div class="account-select select-group">
        <span class="select-label">账号</span>
        <el-select
          v-model="selectedAccountId"
          placeholder="选择账号"
          class="account-select-control"
          @change="onAccountChange"
          filterable
        >
          <el-option
            v-for="acc in filteredAccounts"
            :key="acc.id"
            :label="acc.nickname || acc.id"
            :value="acc.id"
          />
          <template #empty>
            <div class="select-empty">暂无账号，请先添加</div>
          </template>
        </el-select>
      </div>
    </div>

    <div class="topbar-right">
      <button class="theme-toggle" :title="appStore.theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'" :aria-label="appStore.theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'" @click="appStore.toggleTheme()">
        <Sun v-if="appStore.theme === 'dark'" :size="16" />
        <Moon v-else :size="16" />
      </button>
      <div class="search-box">
        <el-autocomplete
          v-model="searchInput"
          :fetch-suggestions="fetchSearchSuggestions"
          :trigger-on-focus="true"
          placeholder="搜索文件..."
          clearable
          @keyup.enter="onSearch"
          @clear="onClearSearch"
          @focus="loadSearchHistory"
          @select="onHistorySelect"
        >
          <template #prefix>
            <Search :size="14" />
          </template>
          <template #default="{ item }">
            <div class="history-option">
              <span>{{ item.value }}</span>
              <small>{{ item.resultCount }} 项</small>
            </div>
          </template>
        </el-autocomplete>
      </div>
      <el-button @click="onRefresh" :icon="RefreshCw" title="刷新当前页面" aria-label="刷新当前页面" circle />
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
import { RefreshCw, Plus, Search, Upload, Radar, Sun, Moon } from 'lucide-vue-next'
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
const searchInput = ref('')
const selectedAccountId = ref('')
const searchHistory = ref<Array<{ value: string; resultCount: number }>>([])

const platformModel = ref('quark')

const filteredAccounts = computed(() => accountStore.getAccountsByPlatform(appStore.currentPlatform))

watch(() => appStore.currentAccount?.id, (id) => {
  if (id) selectedAccountId.value = id
  searchHistory.value = []
  if (id) void loadSearchHistory()
})

async function loadSearchHistory() {
  const accountId = appStore.currentAccount?.id
  if (!accountId) {
    searchHistory.value = []
    return
  }
  try {
    const result = await electronApi.getSearchHistory(accountId)
    if (!result.success) return
    searchHistory.value = (result.history || []).map((item) => ({
      value: item.keyword,
      resultCount: item.result_count,
    }))
  } catch {
    searchHistory.value = []
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

function onRefresh() {
  // Trigger refresh in current page via store
  appStore.refreshKey++
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
.topbar {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 16px;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.topbar-left :deep(.el-button) {
  margin-left: 0;
  min-height: 36px;
  font-weight: 600;
}

.topbar-left :deep(.el-button--primary) {
  box-shadow: 0 4px 10px color-mix(in srgb, var(--pl-primary) 18%, transparent);
}

.topbar-center {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 0 0 auto;
  justify-content: center;
}

.select-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.select-label {
  color: var(--pl-text-secondary);
  font-size: var(--pl-font-xs);
  font-weight: 600;
  white-space: nowrap;
}

.platform-select {
  width: 142px;
}

.account-select-control {
  width: 174px;
}

.account-select {
  flex-shrink: 0;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 200px;
  min-width: 150px;
  max-width: 330px;
  margin-left: auto;
  padding-left: 14px;
  border-left: 1px solid var(--pl-border);
}

.search-box {
  flex: 1;
  min-width: 0;
}

.search-box :deep(.el-autocomplete) {
  width: 100%;
}

.history-option {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  width: 100%;
}

.history-option small {
  color: var(--pl-text-muted);
}

.select-empty {
  padding: 12px 0;
  text-align: center;
  color: var(--pl-text-muted);
  font-size: 13px;
}

/* Segmented control styling */
:deep(.el-segmented) {
  --el-segmented-item-selected-bg-color: #3b82f6;
  --el-segmented-item-selected-color: #ffffff;
  --el-segmented-bg-color: var(--pl-hover);
  border-radius: 8px;
}
:deep(.el-segmented__item) {
  border-radius: 6px;
  font-weight: 500;
}

:deep(.el-select .el-input__wrapper) {
  min-height: 36px;
  background: var(--pl-surface-subtle);
}

.search-box :deep(.el-input__wrapper) {
  min-height: 36px;
  background: var(--pl-surface-subtle);
}

@media (max-width: 1100px) {
  .topbar {
    gap: 10px;
  }

  .topbar-center {
    gap: 8px;
  }

  .select-label {
    display: none;
  }

  .platform-select {
    width: 124px;
  }

  .account-select-control {
    width: 142px;
  }

  .search-box {
    width: 190px;
  }
}

@media (max-width: 960px) {
  .topbar-left :deep(.el-button:not(:first-child)) {
    padding-left: 9px;
    padding-right: 9px;
    font-size: 0;
  }

  .platform-select {
    width: 112px;
  }

  .account-select-control {
    width: 126px;
  }

  .search-box {
    width: 150px;
  }

  .topbar-right {
    padding-left: 8px;
  }
}
.theme-toggle {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: grid;
  place-items: center;
  border: 1px solid var(--pl-border);
  border-radius: var(--pl-radius-control);
  color: var(--pl-text-secondary);
  background: var(--pl-surface-subtle);
  cursor: pointer;
  transition: color 160ms ease, border-color 160ms ease, background-color 160ms ease;
}
.theme-toggle:hover {
  color: var(--pl-primary);
  border-color: var(--pl-border-strong);
  background: var(--pl-primary-soft);
}
</style>
