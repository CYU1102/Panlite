import { h } from 'vue'
import { ElNotification } from 'element-plus'

export function scheduleUndoableAction(options: {
  title: string
  message: string
  delayMs?: number
  onCommit: () => void | Promise<void>
  onUndo?: () => void | Promise<void>
}): { commit: () => Promise<void>; undo: () => Promise<void> } {
  let settled = false
  const state: { timer?: ReturnType<typeof setTimeout>; notification?: ReturnType<typeof ElNotification> } = {}
  const commit = async () => {
    if (settled) return
    settled = true
    if (state.timer) clearTimeout(state.timer)
    state.notification?.close()
    await options.onCommit()
  }
  const undo = async () => {
    if (settled) return
    settled = true
    if (state.timer) clearTimeout(state.timer)
    state.notification?.close()
    await options.onUndo?.()
  }
  state.notification = ElNotification({
    title: options.title,
    duration: options.delayMs ?? 5_000,
    message: h('span', { class: 'pl-undo-message' }, [
      options.message,
      h('button', { class: 'pl-undo-button', onClick: () => { void undo() } }, '撤销'),
    ]),
    onClose: () => { if (!settled) void commit() },
  })
  state.timer = setTimeout(() => { void commit() }, options.delayMs ?? 5_000)
  return { commit, undo }
}
