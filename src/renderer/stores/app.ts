import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Platform, DriveAccount } from '@shared/types'

export const useAppStore = defineStore('app', () => {
  const currentPlatform = ref<Platform>('quark')
  // Credential is never sent to renderer; we use a subset type
  const currentAccount = ref<Omit<DriveAccount, 'credential'> | null>(null)
  const currentPath = ref('0')
  const currentPathName = ref('根目录')
  const pathStack = ref<{ id: string; name: string }[]>([{ id: '0', name: '根目录' }])

  // Search state
  const isSearching = ref(false)
  const searchKeyword = ref('')

  // Refresh trigger
  const refreshKey = ref(0)

  // Selected files count (for StatusBar)
  const selectedCount = ref(0)

  const hasAccount = computed(() => currentAccount.value !== null)

  function setPlatform(platform: Platform) {
    currentPlatform.value = platform
    currentAccount.value = null
    resetPath()
    clearSearch()
  }

  function setAccount(account: Omit<DriveAccount, 'credential'> | null) {
    currentAccount.value = account
    resetPath()
    clearSearch()
  }

  function resetPath() {
    currentPath.value = '0'
    currentPathName.value = '根目录'
    pathStack.value = [{ id: '0', name: '根目录' }]
  }

  function navigateTo(id: string, name: string) {
    currentPath.value = id
    currentPathName.value = name
    pathStack.value.push({ id, name })
    clearSearch()
  }

  function navigateBack() {
    if (pathStack.value.length > 1) {
      pathStack.value.pop()
      const last = pathStack.value[pathStack.value.length - 1]
      currentPath.value = last.id
      currentPathName.value = last.name
    }
    clearSearch()
  }

  function startSearch(keyword: string) {
    searchKeyword.value = keyword
    isSearching.value = true
  }

  function clearSearch() {
    searchKeyword.value = ''
    isSearching.value = false
  }

  return {
    currentPlatform,
    currentAccount,
    currentPath,
    currentPathName,
    pathStack,
    isSearching,
    searchKeyword,
    refreshKey,
    selectedCount,
    hasAccount,
    setPlatform,
    setAccount,
    resetPath,
    navigateTo,
    navigateBack,
    startSearch,
    clearSearch,
  }
})
