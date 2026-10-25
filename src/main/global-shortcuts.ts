import { globalShortcut } from 'electron'
import { GLOBAL_SHORTCUTS } from '../shared/constants'

interface GlobalShortcutActions {
  toggleWindow: () => void
  navigateTo: (path: string) => void
}

let actions: GlobalShortcutActions | null = null
let active = false

function apply(enabled: boolean): boolean {
  try {
    globalShortcut.unregisterAll()
    if (!enabled || !actions) {
      active = false
      return !enabled
    }
    const registered = [
      globalShortcut.register(GLOBAL_SHORTCUTS.TOGGLE_WINDOW, () => actions?.toggleWindow()),
      globalShortcut.register(GLOBAL_SHORTCUTS.QUICK_SEARCH, () => actions?.navigateTo('/global-search')),
      globalShortcut.register(GLOBAL_SHORTCUTS.BATCH_TRANSFER, () => actions?.navigateTo('/batch-transfer')),
    ]
    // 任一组合注册失败（通常是被其他应用占用）就全部撤并，不留半套
    if (registered.some((ok) => !ok)) {
      globalShortcut.unregisterAll()
      active = false
      return false
    }
    active = true
    return true
  } catch {
    active = false
    return false
  }
}

export function initGlobalShortcuts(actionsOverride: GlobalShortcutActions): void {
  actions = actionsOverride
}

export function isGlobalShortcutsActive(): boolean {
  return active
}

export function setGlobalShortcutsEnabled(enabled: boolean): boolean {
  return apply(enabled)
}

export function releaseGlobalShortcuts(): void {
  globalShortcut.unregisterAll()
  active = false
}
