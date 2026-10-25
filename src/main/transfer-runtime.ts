import { getSetting } from './db'

export interface TransferRuntimeSettings {
  parallelChunks: number
  parallelFiles: number
  speedLimitBps: number
  scheduledWindow: string
  tempDir: string
}

export function getTransferRuntimeSettings(): TransferRuntimeSettings {
  const readNumber = (key: string, fallback: number, min: number, max: number): number => {
    const parsed = Number(getSetting(key)?.value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.round(parsed)))
  }
  return {
    parallelChunks: readNumber('transferParallelChunks', 4, 1, 8),
    parallelFiles: readNumber('transferParallelFiles', 2, 1, 4),
    speedLimitBps: readNumber('transferSpeedLimitMbps', 0, 0, 2048) * 1024 * 1024,
    scheduledWindow: (getSetting('transferScheduledWindow')?.value || '').trim(),
    tempDir: (getSetting('transferTempDir')?.value || '').trim(),
  }
}

/** 解析 'HH:MM-HH:MM' 窗口；支持跨午夜。空串或格式非法表示不限时 */
export function isInTransferWindow(window_: string, now = new Date()): boolean {
  const match = window_.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/)
  if (!match) return true
  const startHour = Number(match[1]); const startMinute = Number(match[2])
  const endHour = Number(match[3]); const endMinute = Number(match[4])
  // Treat out-of-range values as an unset window instead of silently creating
  // a schedule that can never be reasoned about (e.g. 99:99-...).
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return true
  const startMinutes = startHour * 60 + startMinute
  const endMinutes = endHour * 60 + endMinute
  const current = now.getHours() * 60 + now.getMinutes()
  if (startMinutes === endMinutes) return true
  if (startMinutes < endMinutes) return current >= startMinutes && current < endMinutes
  return current >= startMinutes || current < endMinutes
}
