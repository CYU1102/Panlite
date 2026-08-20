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
      <el-button @click="showQuickSearch = true">
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
          <el-option label="夸克网盘" value="quark" />
          <el-option label="百度网盘" value="baidu" />
          <el-option label="UC网盘" value="uc" />
          <el-option label="迅雷网盘" value="xunlei" />
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
      <el-button @click="onRefresh" :icon="RefreshCw" circle />
    </div>

    <AddAccountDialog v-model="showAddAccount" @success="onAccountAdded" />
    <UploadDialog
      v-model="showUpload"
      :account="appStore.currentAccount"
      :target-dir-id="appStore.currentPath"
      :target-dir-name="appStore.currentPathName"
      @success="onUploadCreated"
    />
    <QuickSearchDialog v-model="showQuickSearch" @transfer="onTransfer" />
    <TransferDialog
      v-model="showTransfer"
      :initial-links="transferLinks"
      :initial-target-dir-id="appStore.currentPath"
      :initial-target-name="appStore.currentPathName"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { RefreshCw, Plus, Search, Upload, Radar } from 'lucide-vue-next'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { useAppStore } from '../stores/app'
import { useAccountStore } from '../stores/account'
import type { Platform } from '@shared/types'
import AddAccountDialog from './AddAccountDialog.vue'
import UploadDialog from './UploadDialog.vue'
import QuickSearchDialog from './QuickSearchDialog.vue'
import TransferDialog from './TransferDialog.vue'
import type { TransferLinkInput } from '@shared/types'
import { electronApi } from '../api/ipc'

const appStore = useAppStore()
const accountStore = useAccountStore()

const showAddAccount = ref(false)
const showUpload = ref(false)
const showQuickSearch = ref(false)
const showTransfer = ref(false)
const transferLinks = ref<TransferLinkInput[]>([])
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

function onTransfer(item: TransferLinkInput) {
  transferLinks.value = [{ url: item.url, password: item.password }]
  showTransfer.value = true
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
  gap: 18px;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.topbar-left :deep(.el-button) {
  margin-left: 0;
}

.topbar-center {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1;
  justify-content: center;
}

.select-group {
  display: flex;
  align-items: center;
  gap: 7px;
}

.select-label {
  color: var(--pl-text-muted);
  font-size: 11px;
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
  flex-shrink: 0;
}

.search-box {
  width: 236px;
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
  --el-segmented-bg-color: #f3f4f6;
  border-radius: 8px;
}
:deep(.el-segmented__item) {
  border-radius: 6px;
  font-weight: 500;
}

:deep(.el-select .el-input__wrapper) {
  min-height: 36px;
  background: #fbfcfe;
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
}
</style>
