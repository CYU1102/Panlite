import type { SharedDirectoryEntry } from '../shared/subscription-types'

/** Reject repeated pages and inconsistent totals instead of accepting a partial baseline. */
export class SharedDirectoryPages {
  private readonly seen = new Set<string>()
  private count = 0
  private pages = 0
  private total?: number

  constructor(private readonly label = '分享目录', private readonly zeroTotalUnknown = false) {}

  accept(ids: string[], pageSize: number, metadata?: { _total?: number; _size?: number }): boolean {
    if (++this.pages > 1000) throw new Error(`${this.label}分页超过安全上限，请缩小范围`)
    if (ids.length > pageSize || (metadata?._size !== undefined && metadata._size !== pageSize)) throw new Error(`${this.label}分页大小与请求不一致，请重新检查`)
    if (ids.some(id => !id || this.seen.has(id)) || new Set(ids).size !== ids.length) {
      throw new Error(`${this.label}分页重复或文件标识无效，请稍后重新检查`)
    }
    ids.forEach(id => this.seen.add(id))
    this.count += ids.length
    const declaredTotal = metadata?._total
    // Native Quark/UC listings use zero as an unknown-total sentinel. Shared
    // directories keep their stricter contract unless explicitly opted in.
    if (declaredTotal !== undefined && !(this.zeroTotalUnknown && declaredTotal === 0)) {
      if (!Number.isSafeInteger(declaredTotal) || declaredTotal < 0 || (this.total !== undefined && declaredTotal !== this.total)) {
        throw new Error(`${this.label}在分页期间发生变化，请重新检查`)
      }
      this.total = declaredTotal
    }
    // A later page omitting metadata cannot erase a previously known total.
    const total = this.total
    if (total !== undefined) {
      if (this.count > total || (ids.length < pageSize && this.count < total)) throw new Error(`${this.label}分页不完整，请重新检查`)
      return this.count < total
    }
    return ids.length === pageSize
  }
}

export function sharedEntry(raw: Record<string, unknown>, provider: 'pan' | 'aliyun'): SharedDirectoryEntry {
  const size = typeof raw.size === 'number' && Number.isSafeInteger(raw.size) && raw.size >= 0 ? raw.size : undefined
  const hash = provider === 'aliyun' && typeof raw.content_hash === 'string' && /^[a-f\d]{40}$/i.test(raw.content_hash)
    && (!raw.content_hash_name || String(raw.content_hash_name).toLowerCase() === 'sha1')
    ? { algorithm: 'sha1' as const, value: raw.content_hash.toLowerCase() } : undefined
  return {
    fileId: String(provider === 'pan' ? raw.fid ?? '' : raw.file_id ?? ''),
    name: String(provider === 'pan' ? raw.file_name ?? '' : raw.name ?? ''),
    isDir: provider === 'pan' ? raw.dir === 1 || raw.is_dir === 1 : raw.type === 'folder',
    size, contentHash: hash, raw,
  }
}
