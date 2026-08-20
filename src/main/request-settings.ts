export interface RequestSettings {
  quarkPageSize: number
  baiduPageSize: number
  requestDelayMs: number
}
export const DEFAULT_REQUEST_SETTINGS: Readonly<RequestSettings> = Object.freeze({
  quarkPageSize: 200,
  baiduPageSize: 100,
  requestDelayMs: 300,
})

const LIMITS: Record<keyof RequestSettings, readonly [number, number]> = {
  quarkPageSize: [20, 500],
  baiduPageSize: [20, 1000],
  requestDelayMs: [0, 5000],
}

let currentSettings: RequestSettings = { ...DEFAULT_REQUEST_SETTINGS }

export function normalizeRequestSetting<K extends keyof RequestSettings>(
  key: K,
  value: unknown,
): RequestSettings[K] {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(parsed)) throw new Error(`${key} 必须是有效数字`)
  const [min, max] = LIMITS[key]
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} 必须是 ${min} 到 ${max} 之间的整数`)
  }
  return parsed
}

export function isRequestSettingKey(key: string): key is keyof RequestSettings {
  return Object.prototype.hasOwnProperty.call(LIMITS, key)
}

export function configureRequestSettings(values: Partial<Record<keyof RequestSettings, unknown>>): RequestSettings {
  const next = { ...currentSettings }
  for (const key of Object.keys(values) as (keyof RequestSettings)[]) {
    const value = values[key]
    if (value !== undefined && value !== null && value !== '') {
      next[key] = normalizeRequestSetting(key, value)
    }
  }
  currentSettings = next
  return getRequestSettings()
}

export function resetRequestSettings(): void {
  currentSettings = { ...DEFAULT_REQUEST_SETTINGS }
}

export function getRequestSettings(): RequestSettings {
  return { ...currentSettings }
}
