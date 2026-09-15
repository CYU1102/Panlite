// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DriveAccount } from '@shared/types'

const api = vi.hoisted(() => ({ listAccounts: vi.fn(), deleteAccount: vi.fn(), getSetting: vi.fn(), setSetting: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
import { useAccountStore } from './account'
import { useAppStore } from './app'

const account = { id: 'fixture', platform: 'baidu', nickname: 'fixture', loginType: 'oauth', status: 'active', createdAt: 0, updatedAt: 0 } as Omit<DriveAccount, 'credential'>
beforeEach(() => { vi.clearAllMocks(); setActivePinia(createPinia()); document.documentElement.classList.remove('dark') })

it('resets navigation, search, selection, and platform when switching accounts', () => {
  const app = useAppStore(); app.navigateTo('folder', 'folder'); app.startSearch('report'); app.selectedCount = 3
  app.setAccount(account)
  expect(app.currentPlatform).toBe('baidu'); expect(app.currentPath).toBe('0'); expect(app.isSearching).toBe(false); expect(app.selectedCount).toBe(0)
})

it('clears the active account only after its deletion succeeds', async () => {
  const store = useAccountStore(); const app = useAppStore(); store.accounts = [account]; app.setAccount(account)
  api.deleteAccount.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true })
  await store.deleteAccount(account.id); expect(app.currentAccount?.id).toBe(account.id); expect(store.accounts).toHaveLength(1)
  await store.deleteAccount(account.id); expect(app.currentAccount).toBeNull(); expect(store.accounts).toEqual([])
})

it('releases loading state after a rejected account query', async () => {
  api.listAccounts.mockRejectedValueOnce(new Error('fixture failure')); const store = useAccountStore()
  await expect(store.fetchAccounts()).rejects.toThrow('fixture failure'); expect(store.loading).toBe(false)
})

it('restores and persists the selected theme', async () => {
  api.getSetting.mockResolvedValueOnce({ success: true, value: 'dark' }); api.setSetting.mockResolvedValueOnce({ success: true })
  const app = useAppStore(); await app.loadTheme(); expect(document.documentElement.classList.contains('dark')).toBe(true)
  await app.toggleTheme(); expect(api.setSetting).toHaveBeenCalledWith('theme', 'light'); expect(document.documentElement.classList.contains('dark')).toBe(false)
})
