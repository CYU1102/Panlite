/** Convert reactive JSON-shaped form data before crossing Electron's clone boundary. */
export function plainIpcData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => plainIpcData(item)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainIpcData(item)])) as T
  }
  return value
}
