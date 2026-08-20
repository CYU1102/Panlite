import type { Platform } from './types'

/**
 * 平台功能能力的单一事实来源。
 *
 * 这里描述的是 PanLite 当前已经接通并验证过的能力，而不是各网盘官网
 * 理论上提供的所有能力。界面应以此表决定功能入口是否可用。
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
  // 当前压缩 IPC 只会直接下载文件，尚未接入目录递归下载流程。
  createArchiveFromFolder: false,
} as const satisfies PlatformCapabilities

export const PLATFORM_CAPABILITIES: Readonly<Record<Platform, PlatformCapabilities>> = {
  quark: STANDARD_CAPABILITIES,
  baidu: { ...STANDARD_CAPABILITIES, copy: true },
  uc: STANDARD_CAPABILITIES,
  xunlei: STANDARD_CAPABILITIES,
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
