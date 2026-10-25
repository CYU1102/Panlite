import type { Platform } from './types'

/**
 * 平台功能能力的单一事实来源。
 *
 * 这里描述 PanLite 当前代码已接入的能力，界面以此决定功能入口是否可用。
 * 实际账号的端到端验收另见 docs/FUNCTIONAL_AUDIT.md；此表不代表云端验收通过。
 */
export interface PlatformCapabilities {
  readonly list: boolean
  readonly search: boolean
  readonly createFolder: boolean
  readonly rename: boolean
  readonly move: boolean
  readonly delete: boolean
  readonly copy: boolean
  readonly share: boolean
  readonly transfer: boolean
  readonly uploadFile: boolean
  readonly uploadFolder: boolean
  readonly downloadFile: boolean
  readonly downloadFolder: boolean
  readonly browseArchive: boolean
  readonly extractArchive: boolean
  readonly createArchive: boolean
  readonly createArchiveFromFolder: boolean
}

const STANDARD_CAPABILITIES = {
  list: true,
  search: true,
  createFolder: true,
  rename: true,
  move: true,
  delete: true,
  copy: false,
  share: true,
  transfer: true,
  uploadFile: true,
  uploadFolder: true,
  downloadFile: true,
  downloadFolder: true,
  browseArchive: true,
  extractArchive: true,
  // PanLite 在本地下载、压缩后再上传，不依赖网盘原生压缩能力。
  createArchive: true,
  createArchiveFromFolder: true,
} as const satisfies PlatformCapabilities

export const PLATFORM_CAPABILITIES: Readonly<Record<Platform, PlatformCapabilities>> = {
  quark: { ...STANDARD_CAPABILITIES, copy: true },
  baidu: { ...STANDARD_CAPABILITIES, copy: true },
  uc: { ...STANDARD_CAPABILITIES, copy: true },
  xunlei: STANDARD_CAPABILITIES,
  // WebDAV 无分享/转存协议能力；其余文件操作走标准 DAV 方法
  webdav: { ...STANDARD_CAPABILITIES, share: false, transfer: false },
  // 开放平台未开放分享接口；转存输入分享链接因此也不可用
  aliyun: { ...STANDARD_CAPABILITIES, copy: true, share: false, transfer: false },
  // 123 开放平台同样未开放分享协议能力
  pan123: { ...STANDARD_CAPABILITIES, share: false, transfer: false },
  // 阿里云盘·网页版（逆向 web 接口）：支持分享/转存；上传需要 proof code，暂不开放
  aliyun_web: {
    ...STANDARD_CAPABILITIES,
    share: true,
    transfer: true,
    uploadFile: false,
    uploadFolder: false,
    createArchive: false,
    createArchiveFromFolder: false,
  },
}

const NO_CAPABILITIES: PlatformCapabilities = {
  list: false,
  search: false,
  createFolder: false,
  rename: false,
  move: false,
  delete: false,
  copy: false,
  share: false,
  transfer: false,
  uploadFile: false,
  uploadFolder: false,
  downloadFile: false,
  downloadFolder: false,
  browseArchive: false,
  extractArchive: false,
  createArchive: false,
  createArchiveFromFolder: false,
}

export function getPlatformCapabilities(platform?: Platform | null): PlatformCapabilities {
  return platform ? PLATFORM_CAPABILITIES[platform] : NO_CAPABILITIES
}
