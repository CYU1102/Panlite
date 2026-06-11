import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { DriveAccount, Platform } from '@shared/types'
import { electronApi } from '../api/ipc'

export const useAccountStore = defineStore('account', () => {
  const accounts = ref<Omit<DriveAccount, 'credential'>[]>([])
  const loading = ref(false)

  const quarkAccounts = computed(() => accounts.value.filter((a) => a.platform === 'quark'))
  const baiduAccounts = computed(() => accounts.value.filter((a) => a.platform === 'baidu'))

  function getAccountsByPlatform(platform: Platform) {
    return accounts.value.filter((a) => a.platform === platform)
  }

  async function fetchAccounts() {
    loading.value = true
    try {
      const result = await electronApi.listAccounts()
      if (result.success) {
        accounts.value = result.accounts
      }
    } finally {
      loading.value = false
    }
  }

  async function deleteAccount(id: string) {
    const result = await electronApi.deleteAccount(id)
    if (result.success) {
      accounts.value = accounts.value.filter((a) => a.id !== id)
    }
    return result
  }

  async function checkAccount(id: string) {
    return electronApi.checkAccount(id)
  }

  return {
    accounts,
    loading,
    quarkAccounts,
    baiduAccounts,
    getAccountsByPlatform,
    fetchAccounts,
    deleteAccount,
    checkAccount,
  }
})
