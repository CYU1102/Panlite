import { AsyncLocalStorage } from 'node:async_hooks'

const searchSignals = new AsyncLocalStorage<AbortSignal>()

export function withSearchSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return searchSignals.run(signal, run)
}

export function getSearchSignal(): AbortSignal | undefined { return searchSignals.getStore() }

export function throwIfSearchCancelled(): void { getSearchSignal()?.throwIfAborted() }
