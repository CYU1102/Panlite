import type { DriveAccount, FileItem, FileListResult, ShareInfo, ShareOptions, ShareDetail, ShareTaskPayload, TransferLinkInput, TransferResult, ParsedShareLink, UploadOptions, UploadResult, DownloadOptions, DownloadResult, QuotaInfo } from '../shared/types'
import type { MembershipInfo } from '../shared/membership'

export interface DriveAdapter {
  /** Verify the account is still logged in */
  checkLogin(account: DriveAccount): Promise<boolean>

  /** Get user info (nickname, avatar, etc.) */
  getUserInfo(account: DriveAccount): Promise<{ nickname: string; avatar?: string }>

  /** Get storage quota info (optional) */
  getQuota?(account: DriveAccount): Promise<QuotaInfo>

  /** Query the provider's current membership/VIP state when available. */
  getMembership?(account: DriveAccount): Promise<MembershipInfo>

  /** List files in a directory (auto-paging, returns all files) */
  listFiles(account: DriveAccount, parentId: string): Promise<FileListResult>

  /** Search files by keyword (auto-paging, returns all results) */
  searchFiles(account: DriveAccount, keyword: string): Promise<FileItem[]>

  /** Create a new folder */
  mkdir(account: DriveAccount, parentId: string, name: string): Promise<FileItem>

  /** Rename a file or folder */
  rename(account: DriveAccount, fileId: string, newName: string): Promise<void>

  /** Move files to a target directory */
  move(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void>

  /** Delete files */
  delete(account: DriveAccount, fileIds: string[]): Promise<void>

  /** Copy files (optional) */
  copy?(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void>

  /** Create a share link for files */
  createShare?(account: DriveAccount, items: ShareTaskPayload['items'], options?: ShareOptions): Promise<ShareInfo>

  /** Parse a share link to extract share ID / token */
  parseShareLink?(url: string, password?: string): Promise<ParsedShareLink>

  /** Get share detail (file list) from a share link */
  getShareDetail?(account: DriveAccount, input: TransferLinkInput): Promise<ShareDetail>

  /** Save shared files to the account's drive */
  saveSharedFiles?(account: DriveAccount, input: TransferLinkInput, targetDirId: string): Promise<TransferResult>

  /** Upload a local file to the drive (optional) */
  upload?(
    account: DriveAccount,
    localFilePath: string,
    targetDirId: string,
    options?: UploadOptions,
  ): Promise<UploadResult>

  /** Get download URL for a file (optional) */
  getDownloadUrl?(account: DriveAccount, fileId: string): Promise<string>

  /** Download a file to local path (optional) */
  download?(
    account: DriveAccount,
    fileId: string,
    localDirPath: string,
    options?: DownloadOptions,
  ): Promise<DownloadResult>
}
