import type { DriveAdapter } from './base'
import { quarkAdapter } from './quark'
import { baiduAdapter } from './baidu'
import { ucAdapter } from './uc'
import { xunleiAdapter } from './xunlei'
import { webdavAdapter } from './webdav'
import { aliyunAdapter } from './aliyun'
import { pan123Adapter } from './pan123'
import { aliyunWebAdapter } from './aliyun-web'

const adapters: Record<string, DriveAdapter> = {
  quark: quarkAdapter,
  baidu: baiduAdapter,
  uc: ucAdapter,
  xunlei: xunleiAdapter,
  webdav: webdavAdapter,
  aliyun: aliyunAdapter,
  pan123: pan123Adapter,
  aliyun_web: aliyunWebAdapter,
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
