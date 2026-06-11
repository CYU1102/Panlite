<template>
  <div class="topbar">
    <div class="topbar-left">
      <el-button type="primary" @click="showAddAccount = true">
        <Plus :size="14" style="margin-right: 4px" />
        添加账号
      </el-button>
    </div>

    <div class="topbar-center">
      <el-select
        v-model="platformModel"
        style="width: 160px"
        @change="onPlatformChange"
      >
        <el-option label="夸克网盘" value="quark" />
        <el-option label="百度网盘" value="baidu" />
        <el-option label="UC网盘" value="uc" />
        <el-option label="迅雷网盘" value="xunlei" />
      </el-select>
      <div class="account-select">
        <el-select
          v-model="selectedAccountId"
          placeholder="选择账号"
          style="width: 180px"
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
        <el-input
          v-model="searchInput"
          placeholder="搜索文件..."
          clearable
          @keyup.enter="onSearch"
          @clear="onClearSearch"
        >
          <template #prefix>
            <Search :size="14" />
          </template>
        </el-input>
      </div>
      <el-button @click="onRefresh" :icon="RefreshCw" circle />
    </div>

    <AddAccountDialog v-model="showAddAccount" @success="onAccountAdded" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { RefreshCw, Plus, Search } from 'lucide-vue-next'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../stores/app'
import { useAccountStore } from '../stores/account'
import type { Platform } from '@shared/types'
import AddAccountDialog from './AddAccountDialog.vue'

const appStore = useAppStore()
const accountStore = useAccountStore()

const showAddAccount = ref(false)
const searchInput = ref('')
const selectedAccountId = ref('')

const platformModel = ref('quark')

const filteredAccounts = computed(() => accountStore.getAccountsByPlatform(appStore.currentPlatform))

watch(() => appStore.currentAccount?.id, (id) => {
  if (id) selectedAccountId.value = id
})

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

function onTransfer(item: { url: string; password?: string }) {
  // 复制链接到剪贴板
  const text = item.password ? `${item.url}?pwd=${item.password}` : item.url
  navigator.clipboard.writeText(text).then(() => {
    ElMessage.success('链接已复制，请到转存页面粘贴')
  }).catch(() => {
    ElMessage.info('请手动复制链接')
  })
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
  flex-shrink: 0;
}

.topbar-center {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  justify-content: center;
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
  width: 240px;
}

.select-empty {
  padding: 12px 0;
  text-align: center;
  color: #9ca3af;
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
</style>
