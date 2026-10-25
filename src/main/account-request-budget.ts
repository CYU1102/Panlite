import { AsyncLocalStorage } from 'node:async_hooks'
import type { DriveAdapter } from '../adapters/base'

type Priority = 'interactive' | 'background'
interface Waiter { priority: Priority; signal?: AbortSignal; start(): void; cancel(): void }
interface AccountQueue { active: number; foregroundStreak: number; pending: Waiter[] }

/** Bound client operations per account; nested calls share their parent's permit. */
export class AccountRequestBudget {
  private readonly accounts = new Map<string, AccountQueue>()
  private readonly context = new AsyncLocalStorage<ReadonlySet<string>>()
  constructor(readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid account request concurrency')
  }

  async run<T>(accountId: string, priority: Priority, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    if (this.context.getStore()?.has(accountId)) return operation()
    const release = await this.acquire(accountId, priority, signal)
    try {
      signal?.throwIfAborted()
      const held = new Set(this.context.getStore()).add(accountId)
      return await this.context.run(held, operation)
    } finally { release() }
  }

  private acquire(id: string, priority: Priority, signal?: AbortSignal): Promise<() => void> {
    const queue = this.accounts.get(id) ?? { active: 0, foregroundStreak: 0, pending: [] }
    this.accounts.set(id, queue)
    return new Promise((resolvePermit, reject) => {
      const waiter: Waiter = {
        priority, signal,
        start: () => {
          signal?.removeEventListener('abort', waiter.cancel)
          queue.active++
          let released = false
          resolvePermit(() => {
            if (released) return
            released = true
            queue.active--
            this.drain(id, queue)
          })
        },
        cancel: () => {
          const index = queue.pending.indexOf(waiter)
          if (index < 0) return
          queue.pending.splice(index, 1)
          signal?.removeEventListener('abort', waiter.cancel)
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
          this.drain(id, queue)
        },
      }
      queue.pending.push(waiter)
      signal?.addEventListener('abort', waiter.cancel, { once: true })
      if (signal?.aborted) waiter.cancel()
      else this.drain(id, queue)
    })
  }

  private drain(id: string, queue: AccountQueue): void {
    while (queue.active < this.concurrency && queue.pending.length) {
      const background = queue.pending.findIndex(waiter => waiter.priority === 'background')
      const foreground = queue.pending.findIndex(waiter => waiter.priority === 'interactive')
      const next = background >= 0 && (queue.foregroundStreak >= 4 || foreground < 0) ? background : Math.max(0, foreground)
      const [waiter] = queue.pending.splice(next, 1)
      queue.foregroundStreak = waiter.priority === 'background' ? 0 : queue.foregroundStreak + 1
      waiter.start()
    }
    if (!queue.active && !queue.pending.length) this.accounts.delete(id)
  }
}

export const accountRequestBudget = new AccountRequestBudget(2)
const wrappers = new WeakMap<DriveAdapter, Map<Priority, DriveAdapter>>()
const controlled = new Set(['listFiles', 'getDownloadSource', 'getDownloadUrl', 'download', 'upload', 'copy', 'move', 'rename', 'delete', 'mkdir', 'createShare', 'getShareInfo', 'saveShare'])

/** Provider-side asynchronous jobs remain provider-managed; this budgets client calls. */
export function budgetDriveAdapter(adapter: DriveAdapter, priority: Priority = 'interactive'): DriveAdapter {
  let variants = wrappers.get(adapter)
  if (!variants) { variants = new Map(); wrappers.set(adapter, variants) }
  const cached = variants.get(priority)
  if (cached) return cached
  const wrapped = new Proxy(adapter, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (!controlled.has(String(property))) return value.bind(target)
      return (...args: unknown[]) => {
        const account = args[0] as { id?: unknown } | undefined
        if (!account || typeof account.id !== 'string') return value.apply(target, args)
        const options = args[args.length - 1] as { signal?: AbortSignal } | undefined
        const signal = options && typeof options === 'object' && options.signal instanceof AbortSignal ? options.signal : undefined
        return accountRequestBudget.run(account.id, priority, () => value.apply(target, args), signal)
      }
    },
  })
  variants.set(priority, wrapped)
  return wrapped
}
