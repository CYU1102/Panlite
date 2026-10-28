import type { ArchiveExtractOptions, ArchiveExtractTaskPayload } from '../shared/types'
import { decryptCredential, encryptCredential } from './crypto'
import { isWindowsTaskPassword, protectWindowsTaskPassword, unprotectWindowsTaskPassword } from './windows-dpapi'

type TaskOptions = ArchiveExtractTaskPayload['options']

/** Never persist a new archive password in plaintext; fail closed if OS protection is unavailable. */
export async function protectArchiveTaskOptions(options: ArchiveExtractOptions): Promise<TaskOptions> {
  const result: TaskOptions = { targetDir: options.targetDir, files: options.files }
  if (options.password) {
    try {
      result.encryptedPassword = process.platform === 'win32'
        ? await protectWindowsTaskPassword(options.password)
        : encryptCredential(options.password)
    } catch {
      throw new Error('系统安全存储不可用，无法安全创建带密码的解压任务')
    }
  }
  return result
}

/** Existing queued tasks can still carry their original plaintext password. */
export async function archiveTaskPassword(options: TaskOptions): Promise<string | undefined> {
  if (options.encryptedPassword !== undefined) {
    if (options.password !== undefined) throw new Error('解压任务密码格式无效')
    try {
      if (isWindowsTaskPassword(options.encryptedPassword)) {
        if (process.platform !== 'win32') throw new Error('Unsupported platform')
        return await unprotectWindowsTaskPassword(options.encryptedPassword)
      }
      return decryptCredential(options.encryptedPassword)
    } catch {
      throw new Error('无法解密解压任务密码，请重新创建任务')
    }
  }
  return options.password
}
