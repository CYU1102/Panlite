import type { DriveAdapter } from './base'
import { quarkAdapter } from './quark'
import { baiduAdapter } from './baidu'
import { ucAdapter } from './uc'
import { xunleiAdapter } from './xunlei'

const adapters: Record<string, DriveAdapter> = {
  quark: quarkAdapter,
  baidu: baiduAdapter,
  uc: ucAdapter,
  xunlei: xunleiAdapter,
}

/**
 * Get the drive adapter for a given platform.
 * Throws if the platform is unknown.
 */
export function getAdapter(platform: string): DriveAdapter {
  const adapter = adapters[platform]
  if (!adapter) {
    throw new Error(`Unknown platform: "${platform}". Supported: ${Object.keys(adapters).join(', ')}`)
  }
  return adapter
}

/** List all registered platform names. */
export function getSupportedPlatforms(): string[] {
  return Object.keys(adapters)
}
