import { app } from 'electron'
import type { DriveAccount } from '../../shared/types'
import fs from 'node:fs'
import path from 'node:path'
import type { AiDocument } from '../../shared/ai-types'
import { getAccountById, type DbAccount } from '../db'
import { decryptCredential } from '../crypto'
import { getAdapter } from '../../adapters/registry'
import { importAiFiles } from './ai-service'

const TEMP_DIR_NAME = 'ai-cloud-downloads'
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_CLOUD_IMPORT_FILES = 20

function toDriveAccount(row: DbAccount): DriveAccount {
  let credential: DriveAccount['credential'] = {}
  try {
    credential = JSON.parse(decryptCredential(row.encrypted_credential))
  } catch { /* 解密失败时视为空凭据 */ }
  return {
    id: row.id,
    platform: row.platform as DriveAccount['platform'],
    nickname: row.nickname || row.id,
    loginType: row.login_type as DriveAccount['loginType'],
    credential,
    status: row.status as DriveAccount['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckAt: row.last_check_at || undefined,
  }
}

function cloudDownloadDir(): string {
  const dir = path.join(app.getPath('userData'), TEMP_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function cleanupStaleDownloads(): void {
  try {
    const now = Date.now()
    for (const entry of fs.readdirSync(cloudDownloadDir())) {
      const full = path.join(cloudDownloadDir(), entry)
      try {
        if (now - fs.statSync(full).mtimeMs > TEMP_MAX_AGE_MS) fs.rmSync(full, { recursive: true, force: true })
      } catch { /* 单个文件失败不影响整体 */ }
    }
  } catch { /* 忽略清理失败 */ }
}

export interface AiCloudImportRequest {
  accountId: string
  fileId: string
  fileName: string
}

/** 从网盘下载文件到临时目录并导入 AI 工作台；重复内容会自动复用现有索引 */
export async function importAiCloudFiles(requests: AiCloudImportRequest[]): Promise<{ success: boolean; documents: AiDocument[]; taskIds: string[]; error?: string }> {
  if (!Array.isArray(requests) || requests.length === 0) {
    return { success: false, documents: [], taskIds: [], error: '请选择要导入的网盘文件' }
  }
  if (requests.length > MAX_CLOUD_IMPORT_FILES) {
    return { success: false, documents: [], taskIds: [], error: `一次最多导入 ${MAX_CLOUD_IMPORT_FILES} 个网盘文件` }
  }
  cleanupStaleDownloads()

  const dir = cloudDownloadDir()
  const inputs: Array<{ localPath: string; fileName?: string; sourceAccountId?: string; sourceFileId?: string }> = []
  const errors: string[] = []

  for (const request of requests) {
    const row = getAccountById(String(request.accountId || ''))
    const account = row ? toDriveAccount(row) : null
    if (!account) {
      errors.push(`账号不存在：${request.accountId}`)
      continue
    }
    const adapter = getAdapter(account.platform)
    if (!adapter.download) {
      errors.push(`平台 ${account.platform} 暂不支持下载`)
      continue
    }
    const fileName = path.basename(String(request.fileName || `cloud-${request.fileId}`))
    // Keep each download in its own directory.  Two accounts can expose the
    // same filename; sharing one directory would make the later download
    // overwrite the bytes that the earlier document is meant to index.
    let requestDir = ''
    try {
      requestDir = fs.mkdtempSync(path.join(dir, 'item-'))
      const result = await adapter.download(account, String(request.fileId), requestDir, { fileName })
      if (!result.success || !result.localPath) throw new Error(result.error || '下载失败')
      inputs.push({
        localPath: result.localPath,
        fileName,
        sourceAccountId: account.id,
        sourceFileId: String(request.fileId),
      })
    } catch (error) {
      errors.push(`${fileName}：${error instanceof Error ? error.message : String(error)}`)
      if (requestDir) fs.rmSync(requestDir, { recursive: true, force: true })
    }
  }

  if (!inputs.length) {
    return { success: false, documents: [], taskIds: [], error: errors.join('；') || '没有可导入的文件' }
  }

  const imported = await importAiFiles(inputs)
  const combinedError = [imported.error, errors.join('；')].filter(Boolean).join('；') || undefined
  return { ...imported, error: combinedError }
}
