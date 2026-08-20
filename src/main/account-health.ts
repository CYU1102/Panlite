import type { AccountStatus } from '../shared/types'

export interface HealthCheckAccount {
  id: string
  status?: AccountStatus
}

export type AccountHealthCheckResult = boolean | AccountStatus

export interface AccountHealthChange<Account extends HealthCheckAccount> {
  account: Account
  previousStatus: AccountStatus | undefined
  status: AccountStatus
  checkedAt: number
  error?: unknown
}

export interface AccountHealthCheckEvent<Account extends HealthCheckAccount> {
  account: Account
  status: AccountStatus
  checkedAt: number
  changed: boolean
  error?: unknown
}

export interface AccountHealthSchedulerError {
  phase: 'list-accounts' | 'status-change-callback' | 'checked-callback'
  error: unknown
  accountId?: string
}

export interface AccountHealthCycleResult {
  startedAt: number
  finishedAt: number
  total: number
  checked: number
  changes: number
  aborted: boolean
  statuses: Record<AccountStatus, number>
}

export interface AccountHealthSchedulerOptions<Account extends HealthCheckAccount> {
  getAccounts: () => readonly Account[] | Promise<readonly Account[]>
  checkAccount: (account: Account, signal: AbortSignal) => AccountHealthCheckResult | Promise<AccountHealthCheckResult>
  onStatusChange?: (change: AccountHealthChange<Account>) => void | Promise<void>
  onAccountChecked?: (event: AccountHealthCheckEvent<Account>) => void | Promise<void>
  onError?: (event: AccountHealthSchedulerError) => void
  intervalMs?: number
  concurrency?: number
  runImmediately?: boolean
  now?: () => number
}

const DEFAULT_INTERVAL_MS = 15 * 60 * 1_000
const DEFAULT_CONCURRENCY = 3

function normalizePositiveInteger(value: number | undefined, fallback: number, maximum?: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  const normalized = Math.max(1, Math.floor(value))
  return maximum === undefined ? normalized : Math.min(normalized, maximum)
}

function emptyStatusCounts(): Record<AccountStatus, number> {
  return { active: 0, expired: 0, error: 0 }
}

export class AccountHealthScheduler<Account extends HealthCheckAccount> {
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private generation = 0
  private activeCycle: { generation: number; promise: Promise<AccountHealthCycleResult> } | null = null
  private readonly controllers = new Set<AbortController>()
  private readonly knownStatuses = new Map<string, AccountStatus>()
  private readonly intervalMs: number
  private readonly concurrency: number
  private readonly now: () => number

  constructor(private readonly options: AccountHealthSchedulerOptions<Account>) {
    this.intervalMs = normalizePositiveInteger(options.intervalMs, DEFAULT_INTERVAL_MS)
    this.concurrency = normalizePositiveInteger(options.concurrency, DEFAULT_CONCURRENCY, 32)
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.generation += 1
    const generation = this.generation

    if (this.options.runImmediately === false) {
      this.scheduleNext(generation)
    } else {
      void this.runNow()
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.started = false
    this.generation += 1
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }

  dispose(): void {
    this.stop()
    this.knownStatuses.clear()
  }

  isRunning(): boolean {
    return this.started
  }

  getKnownStatus(accountId: string): AccountStatus | undefined {
    return this.knownStatuses.get(accountId)
  }

  forgetAccount(accountId: string): void {
    this.knownStatuses.delete(accountId)
  }

  async runNow(): Promise<AccountHealthCycleResult> {
    const generation = this.generation
    if (this.activeCycle?.generation === generation) return this.activeCycle.promise
    if (this.timer) clearTimeout(this.timer)
    this.timer = null

    const controller = new AbortController()
    this.controllers.add(controller)
    const promise = this.runCycle(generation, controller.signal).finally(() => {
      this.controllers.delete(controller)
      if (this.activeCycle?.promise === promise) this.activeCycle = null
      if (this.started && generation === this.generation) this.scheduleNext(generation)
    })
    this.activeCycle = { generation, promise }
    return promise
  }

  private scheduleNext(generation: number): void {
    if (!this.started || generation !== this.generation || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.started && generation === this.generation) void this.runNow()
    }, this.intervalMs)
  }

  private async runCycle(generation: number, signal: AbortSignal): Promise<AccountHealthCycleResult> {
    const startedAt = this.now()
    const result: AccountHealthCycleResult = {
      startedAt,
      finishedAt: startedAt,
      total: 0,
      checked: 0,
      changes: 0,
      aborted: false,
      statuses: emptyStatusCounts(),
    }

    let accounts: Account[]
    try {
      const listedAccounts = await this.options.getAccounts()
      accounts = [...new Map(listedAccounts.map((account) => [account.id, account])).values()]
    } catch (error) {
      this.reportError({ phase: 'list-accounts', error })
      result.finishedAt = this.now()
      return result
    }

    result.total = accounts.length
    const currentIds = new Set(accounts.map((account) => account.id))
    for (const accountId of this.knownStatuses.keys()) {
      if (!currentIds.has(accountId)) this.knownStatuses.delete(accountId)
    }

    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (!signal.aborted && generation === this.generation) {
        const index = nextIndex
        nextIndex += 1
        if (index >= accounts.length) return
        const account = accounts[index]
        await this.checkOne(account, generation, signal, result)
      }
    }

    const workerCount = Math.min(this.concurrency, accounts.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    result.aborted = signal.aborted || generation !== this.generation
    result.finishedAt = this.now()
    return result
  }

  private async checkOne(
    account: Account,
    generation: number,
    signal: AbortSignal,
    cycle: AccountHealthCycleResult,
  ): Promise<void> {
    let status: AccountStatus
    let error: unknown
    try {
      const checkResult = await this.options.checkAccount(account, signal)
      status = typeof checkResult === 'boolean' ? (checkResult ? 'active' : 'expired') : checkResult
      if (status !== 'active' && status !== 'expired' && status !== 'error') {
        throw new Error(`Unsupported account health status: ${String(status)}`)
      }
    } catch (checkError) {
      if (signal.aborted || generation !== this.generation) return
      status = 'error'
      error = checkError
    }

    if (signal.aborted || generation !== this.generation) return

    const checkedAt = this.now()
    const previousStatus = this.knownStatuses.get(account.id) ?? account.status
    const changed = previousStatus !== status
    this.knownStatuses.set(account.id, status)
    cycle.checked += 1
    cycle.statuses[status] += 1
    if (changed) cycle.changes += 1

    await this.invokeCheckedCallback({ account, status, checkedAt, changed, error })
    if (changed && !signal.aborted && generation === this.generation) {
      await this.invokeStatusChangeCallback({ account, previousStatus, status, checkedAt, error })
    }
  }

  private async invokeCheckedCallback(event: AccountHealthCheckEvent<Account>): Promise<void> {
    if (!this.options.onAccountChecked) return
    try {
      await this.options.onAccountChecked(event)
    } catch (error) {
      this.reportError({ phase: 'checked-callback', error, accountId: event.account.id })
    }
  }

  private async invokeStatusChangeCallback(change: AccountHealthChange<Account>): Promise<void> {
    if (!this.options.onStatusChange) return
    try {
      await this.options.onStatusChange(change)
    } catch (error) {
      this.reportError({ phase: 'status-change-callback', error, accountId: change.account.id })
    }
  }

  private reportError(event: AccountHealthSchedulerError): void {
    try {
      this.options.onError?.(event)
    } catch {
      // Error reporting must not stop future health checks.
    }
  }
}

export function createAccountHealthScheduler<Account extends HealthCheckAccount>(
  options: AccountHealthSchedulerOptions<Account>,
): AccountHealthScheduler<Account> {
  return new AccountHealthScheduler(options)
}
