import { app } from 'electron'
import type { DriveAccount } from '../../shared/types'
import fs from 'node:fs'
import path from 'node:path'
import type { AiDocument } from '../../shared/ai-types'
import { getAccountById, type DbAccount } from '../db'
import { decryptCredential } from '../crypto'
import { getAdapter } from '../../adapters/registry'
import { importAiFiles } from './ai-service'
import { assertSafeDownloadTarget, prepareSafeDownloadRoot } from '../download-target'
import { removeOwnedDirectory } from '../owned-directory'
import { sanitizeFileName } from '../file-transfer'
import log from 'electron-log'

// This root is included in application snapshots; legacy ai-cloud-downloads
// files are left in place because existing documents may still reference them.
const CLOUD_SOURCE_DIR = path.join('ai-attachments', 'cloud-downloads')
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
  const dir = path.join(app.getPath('userData'), CLOUD_SOURCE_DIR)
  prepareSafeDownloadRoot(dir)
  return fs.realpathSync.native(dir)
}

export interface AiCloudImportRequest {
  accountId: string
  fileId: string
  fileName: string
}

/** 从网盘下载文件到受管来源目录并导入 AI 工作台；重复内容会自动复用现有索引 */
export async function importAiCloudFiles(requests: AiCloudImportRequest[]): Promise<{ success: boolean; documents: AiDocument[]; taskIds: string[]; error?: string }> {
  if (!Array.isArray(requests) || requests.length === 0) {
    return { success: false, documents: [], taskIds: [], error: '请选择要导入的网盘文件' }
  }
  if (requests.length > MAX_CLOUD_IMPORT_FILES) {
    return { success: false, documents: [], taskIds: [], error: `一次最多导入 ${MAX_CLOUD_IMPORT_FILES} 个网盘文件` }
  }
  const dir = cloudDownloadDir()
  const rootOwner = fs.lstatSync(dir)
  const assertRoot = () => {
    assertSafeDownloadTarget(dir)
    const current = fs.lstatSync(dir)
    if (current.dev !== rootOwner.dev || current.ino !== rootOwner.ino) throw new Error('网盘导入根目录身份发生变化')
  }
  const assertOwnedFile = (requestDir: string, owner: fs.Stats, candidate: string) => {
    assertRoot()
    assertSafeDownloadTarget(dir, candidate)
    assertSafeDownloadTarget(requestDir, candidate)
    const current = fs.lstatSync(requestDir)
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error('网盘导入临时目录身份发生变化')
    const stat = fs.lstatSync(candidate)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('网盘导入结果不是普通文件')
  }
  // Successfully imported documents retain these files as their source paths.
  // Old directories cannot be safely removed by age without checking references.
  const downloads: Array<{ input: { localPath: string; fileName: string; sourceAccountId: string; sourceFileId: string }; directory: string; owner: fs.Stats }> = []
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
    const fileName = sanitizeFileName(path.basename(String(request.fileName || `cloud-${request.fileId}`)))
    // Keep each download in its own directory.  Two accounts can expose the
    // same filename; sharing one directory would make the later download
    // overwrite the bytes that the earlier document is meant to index.
    let requestDir = ''
    let requestOwner: fs.Stats | undefined
    try {
      assertRoot()
      requestDir = fs.mkdtempSync(path.join(dir, 'item-'))
      requestOwner = fs.lstatSync(requestDir)
      const result = await adapter.download(account, String(request.fileId), requestDir, { fileName })
      if (!result.success || typeof result.localPath !== 'string' || !result.localPath) throw new Error(result.error || '下载失败')
      const candidate = path.resolve(result.localPath)
      assertOwnedFile(requestDir, requestOwner, candidate)
      downloads.push({ input: {
        localPath: candidate,
        fileName,
        sourceAccountId: account.id,
        sourceFileId: String(request.fileId),
      }, directory: requestDir, owner: requestOwner })
    } catch (error) {
      errors.push(`${fileName}：${error instanceof Error ? error.message : String(error)}`)
      if (requestDir && requestOwner) {
        try { assertRoot(); assertSafeDownloadTarget(dir, requestDir); removeOwnedDirectory(requestDir, requestOwner) }
        catch (cleanupError) { log.warn('Could not safely clean cloud import directory:', String(cleanupError)) }
      }
    }
  }

  const inputs = downloads.flatMap(download => {
    try { assertOwnedFile(download.directory, download.owner, download.input.localPath); return [download.input] }
    catch (error) { errors.push(`${download.input.fileName}：${error instanceof Error ? error.message : String(error)}`); return [] }
  })
  if (!inputs.length) {
    return { success: false, documents: [], taskIds: [], error: errors.join('；') || '没有可导入的文件' }
  }

  const imported = await importAiFiles(inputs)
  const combinedError = [imported.error, errors.join('；')].filter(Boolean).join('；') || undefined
  return { ...imported, error: combinedError }
}
