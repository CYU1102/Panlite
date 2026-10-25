import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount, FileItem } from '../shared/types'
import { uploadPreservingExisting, withUploadReplacementLock } from './upload-replacement'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-safe-upload-'))
const source = path.join(scratch, 'report.txt')
const account = { id: 'synthetic', platform: 'quark' } as DriveAccount
interface RemoteFile extends FileItem { content: string }
let remote: RemoteFile[], adapter: DriveAdapter, aborted: boolean
const preserve = vi.fn(), cleanup = vi.fn()
function item(id: string, name: string, content: string): RemoteFile {
  return { id, name, content, size: Buffer.byteLength(content), isDir: false, parentId: 'target', platform: account.platform, accountId: account.id, createdAt: 1, updatedAt: 1 }
}
function execute(platform: DriveAccount['platform'] = 'quark') {
  return uploadPreservingExisting({ adapter, account: { ...account, platform }, localPath: source, parentId: 'target', existing: { ...remote[0] }, expectedSize: 3,
    uploadOptions: {}, assertActive() { if (aborted) throw new Error('cancelled') }, onPreserved: preserve, onCleanupError: cleanup })
}
beforeEach(() => {
  fs.writeFileSync(source, 'new'); aborted = false; preserve.mockClear(); cleanup.mockClear()
  remote = [item('original', 'report.txt', 'old')]
  adapter = {
    listFiles: vi.fn(async () => ({ files: remote.map(value => ({ ...value })), parentId: 'target', hasMore: false })),
    upload: vi.fn(async (_account, file, _parent, options) => {
      const uploaded = item('staged', options!.fileName!, fs.readFileSync(file, 'utf8')); remote.push(uploaded)
      return { success: true, fileId: uploaded.id }
    }),
    rename: vi.fn(async (_account, id, name) => { const value = remote.find(file => file.id === id)!; value.name = name; value.updatedAt++ }),
    delete: vi.fn(async (_account, ids) => {
      expect(remote.find(value => value.name === 'report.txt')?.content).toBe('new')
      remote = remote.filter(value => !ids.includes(value.id))
    }),
  } as unknown as DriveAdapter
})
afterAll(() => { if (path.basename(scratch).startsWith('panlite-safe-upload-')) fs.rmSync(scratch, { recursive: true, force: true }) })

describe('upload replacement preserves old bytes until a confirmed publish', () => {
  it('never changes the remote original when the queued source disappears', async () => {
    fs.unlinkSync(source)
    await expect(execute()).rejects.toThrow()
    expect(remote).toEqual([expect.objectContaining({ name: 'report.txt', content: 'old' })])
    expect(adapter.upload).not.toHaveBeenCalled(); expect(adapter.rename).not.toHaveBeenCalled(); expect(adapter.delete).not.toHaveBeenCalled()
  })
  it('never changes the remote original on a definite upload failure', async () => {
    adapter.upload = vi.fn(async () => ({ success: false, error: 'no space' }))
    await expect(execute()).rejects.toThrow('no space')
    expect(remote[0]).toMatchObject({ name: 'report.txt', content: 'old' }); expect(adapter.rename).not.toHaveBeenCalled(); expect(adapter.delete).not.toHaveBeenCalled()
  })
  it('keeps the original after an upload commits but its response is lost', async () => {
    const upload = adapter.upload!
    adapter.upload = vi.fn<NonNullable<DriveAdapter['upload']>>(async (...args) => { await upload(...args); throw new Error('response lost') })
    await expect(execute()).rejects.toThrow('response lost')
    expect(remote.some(value => value.name === 'report.txt' && value.content === 'old')).toBe(true)
    expect(adapter.rename).not.toHaveBeenCalled(); expect(adapter.delete).not.toHaveBeenCalled()
  })
  it.each(['quark', 'webdav', 'baidu'] as const)('publishes then cleans up with %s IDs', async platform => {
    if (platform !== 'quark') {
      remote[0].id = '/target/report.txt'
      adapter.rename = vi.fn(async (_account, id, name) => {
        const value = remote.find(file => file.id === id)!
        value.id = `/target/${name}`; value.name = name; value.updatedAt++
      })
    }
    await expect(execute(platform)).resolves.toMatchObject({ success: true, fileName: 'report.txt' })
    expect(remote).toEqual([expect.objectContaining({ name: 'report.txt', content: 'new' })])
    expect(adapter.delete).toHaveBeenCalledTimes(1)
    expect(adapter.upload).toHaveBeenCalledWith(expect.anything(), source, 'target', expect.objectContaining({ overwrite: false, fileName: expect.stringMatching(/^\.panlite-upload-/) }))
  })
  it('refuses ambiguous duplicate names without a mutation', async () => {
    remote.push(item('duplicate', 'report.txt', 'old'))
    await expect(execute()).rejects.toThrow('同名歧义')
    expect(adapter.upload).not.toHaveBeenCalled(); expect(adapter.rename).not.toHaveBeenCalled(); expect(adapter.delete).not.toHaveBeenCalled()
  })
  it('requires a complete authoritative directory listing', async () => {
    adapter.listFiles = vi.fn(async () => ({ files: remote, parentId: 'target', hasMore: true }))
    await expect(execute()).rejects.toThrow('未完整列出')
    expect(adapter.upload).not.toHaveBeenCalled(); expect(adapter.delete).not.toHaveBeenCalled()
  })
  it('does not touch the original if the provider ignores the staged filename', async () => {
    adapter.upload = vi.fn(async () => ({ success: true, fileId: 'invented' }))
    await expect(execute()).rejects.toThrow('未通过核对')
    expect(remote[0]).toMatchObject({ name: 'report.txt', content: 'old' }); expect(adapter.rename).not.toHaveBeenCalled(); expect(adapter.delete).not.toHaveBeenCalled()
  })
  it.each([1, 2])('retains original bytes when rename %s commits and then loses its response', async failure => {
    const rename = adapter.rename; let calls = 0
    adapter.rename = vi.fn<DriveAdapter['rename']>(async (...args) => { await rename(...args); if (++calls === failure) throw new Error('rename response lost') })
    await expect(execute()).rejects.toThrow('原内容保留名')
    expect(remote.some(value => value.content === 'old' && value.name.startsWith('.panlite-preserved-'))).toBe(true)
    expect(adapter.delete).not.toHaveBeenCalled()
  })
  it('leaves the original under its original name when cancellation follows staging', async () => {
    const upload = adapter.upload!
    adapter.upload = vi.fn<NonNullable<DriveAdapter['upload']>>(async (...args) => { const result = await upload(...args); aborted = true; return result })
    await expect(execute()).rejects.toThrow('cancelled')
    expect(remote[0]).toMatchObject({ name: 'report.txt', content: 'old' }); expect(adapter.rename).not.toHaveBeenCalled(); expect(adapter.delete).not.toHaveBeenCalled()
  })
  it('retains original bytes when cancellation follows preserving its name', async () => {
    const rename = adapter.rename
    adapter.rename = vi.fn<DriveAdapter['rename']>(async (...args) => { await rename(...args); aborted = true })
    await expect(execute()).rejects.toThrow('cancelled')
    expect(remote.some(value => value.content === 'old')).toBe(true); expect(adapter.delete).not.toHaveBeenCalled()
  })
  it('reports confirmed publish as success when old-copy cleanup fails', async () => {
    adapter.delete = vi.fn(async () => { throw new Error('cleanup unavailable') })
    await expect(execute()).resolves.toMatchObject({ success: true })
    expect(remote.find(value => value.name === 'report.txt')?.content).toBe('new')
    expect(remote.some(value => value.content === 'old')).toBe(true); expect(cleanup).toHaveBeenCalledWith(expect.stringMatching(/^\.panlite-preserved-/))
  })
  it('serializes replacements and releases the lock after a failed operation', async () => {
    let release!: () => void
    const order: number[] = []
    const first = withUploadReplacementLock('same-object', async () => { order.push(1); await new Promise<void>(resolve => { release = resolve }); throw new Error('first failed') })
    const failed = expect(first).rejects.toThrow('first failed')
    const second = withUploadReplacementLock('same-object', async () => { order.push(2) })
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); expect(order).toEqual([1])
    release(); await failed; await second; expect(order).toEqual([1, 2])
  })
})
