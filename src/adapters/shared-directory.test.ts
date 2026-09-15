import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAccount } from '../shared/types'
import { QuarkAdapter } from './quark'
import { UcAdapter } from './uc'
import { aliyunWebAdapter } from './aliyun-web'
import { SharedDirectoryPages } from './shared-directory'

const network = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: network.fetch }, session: { fromPartition: () => ({ fetch: network.fetch }) } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../shared/utils', async original => ({ ...await original<typeof import('../shared/utils')>(), sleep: async () => {} }))
let sequence = 0
function account(platform: 'quark' | 'uc' | 'aliyun_web'): DriveAccount {
  return { id: `directoryfixture${++sequence}`, platform, loginType: 'cookie', nickname: 'fixture',
    credential: { cookies: 'fixture=value', refreshToken: 'refresh', accessToken: 'access', userId: 'drive|device|user', expiresAt: Date.now() + 3600000 }, status: 'active', createdAt: 0, updatedAt: 0 }
}
const reply = (body: unknown) => network.fetch.mockResolvedValueOnce(new Response(JSON.stringify(body)))
const token = () => reply({ code: 0, data: { stoken: 'token', token_info: { stoken: 'token' } } })
const entry = (id: string) => ({ fid: id, file_name: `${id}.mkv`, is_dir: 0, size: 100, share_fid_token: `token-${id}` })
beforeEach(() => network.fetch.mockReset())

describe.each(['quark', 'uc'] as const)('%s shared-directory contract', platform => {
  const adapter = platform === 'quark' ? new QuarkAdapter() : new UcAdapter()
  it('pages a child directory using its real parent parameter', async () => {
    const current = account(platform); token()
    reply({ code: 0, data: { list: Array.from({ length: 50 }, (_, i) => entry(`a${i}`)) }, metadata: { _total: 51 } })
    reply({ code: 0, data: { list: [entry('last')] }, metadata: { _total: 51 } })
    const result = await adapter.listSharedDirectory(current, { url: `https://${platform === 'quark' ? 'pan.quark.cn' : 'drive.uc.cn'}/s/${current.id}` }, { parentId: 'nested' })
    expect(result.complete).toBe(true); expect(result.entries).toHaveLength(51)
    const detail = network.fetch.mock.calls.filter(call => String(call[0]).includes('/share/sharepage/detail'))
    expect(detail).toHaveLength(2)
    expect(detail.every(call => new URL(call[0]).searchParams.get('pdir_fid') === 'nested')).toBe(true)
  })
  it('does not accept a missing or truncated page as an empty baseline', async () => {
    const current = account(platform); token(); reply({ code: 0, data: { list: [entry('one')] }, metadata: { _total: 2 } })
    await expect(adapter.listSharedDirectory(current, { url: `https://${platform === 'quark' ? 'pan.quark.cn' : 'drive.uc.cn'}/s/${current.id}` })).rejects.toThrow(/不完整/)
  })
  it('looks up and saves a selected nested file using the same source parent', async () => {
    const current = account(platform); token()
    reply({ code: 0, data: { list: [entry('source'), entry('other')], is_owner: 0 } })
    reply({ code: 0, data: { task_id: 'save-task' } })
    reply({ code: 0, data: { status: 2, save_as: { save_as_top_fids: ['target-source'] } } })
    await adapter.saveSharedFiles(current, { url: `https://${platform === 'quark' ? 'pan.quark.cn' : 'drive.uc.cn'}/s/${current.id}`, fileIds: ['source'] }, 'target-dir', { sourceParentId: 'nested' })
    const call = network.fetch.mock.calls.find(call => String(call[0]).includes('/share/sharepage/save'))!
    expect(JSON.parse(call[1].body)).toMatchObject({ pdir_fid: 'nested', fid_list: ['source'], fid_token_list: ['token-source'], to_pdir_fid: 'target-dir' })
  })
  it('stops before mutation when a selected source disappeared', async () => {
    const current = account(platform); token(); reply({ code: 0, data: { list: [entry('other')] } })
    await expect(adapter.saveSharedFiles(current, { url: `https://${platform === 'quark' ? 'pan.quark.cn' : 'drive.uc.cn'}/s/${current.id}`, fileIds: ['missing'] }, 'target', { sourceParentId: 'nested' })).rejects.toThrow(/发生变化/)
    expect(network.fetch.mock.calls.some(call => String(call[0]).includes('/share/sharepage/save'))).toBe(false)
  })
})

describe('Aliyun web shared-directory contract', () => {
  it('pages the requested parent and retains a validated full-file digest', async () => {
    const current = account('aliyun_web'); reply({ result: true }); reply({ share_token: 'share-token' })
    reply({ items: [{ file_id: 'a', name: 'a.mkv', size: 100, type: 'file', content_hash: 'a'.repeat(40) }], next_marker: 'next' })
    reply({ items: [{ file_id: 'b', name: 'b', type: 'folder' }], next_marker: '' })
    const result = await aliyunWebAdapter.listSharedDirectory!(current, { url: `https://www.alipan.com/s/${current.id}` }, { parentId: 'nested' })
    expect(result.entries[0].contentHash).toEqual({ algorithm: 'sha1', value: 'a'.repeat(40) })
    const pages = network.fetch.mock.calls.filter(call => String(call[0]).includes('/list_by_share'))
    expect(pages.map(call => JSON.parse(call[1].body))).toMatchObject([{ parent_file_id: 'nested', marker: '' }, { parent_file_id: 'nested', marker: 'next' }])
  })
  it('rejects a repeated marker without returning a partial directory', async () => {
    const current = account('aliyun_web'); reply({ result: true }); reply({ share_token: 'share-token' })
    reply({ items: [{ file_id: 'a', name: 'a', type: 'file' }], next_marker: 'same' })
    reply({ items: [{ file_id: 'b', name: 'b', type: 'file' }], next_marker: 'same' })
    await expect(aliyunWebAdapter.listSharedDirectory!(current, { url: `https://www.alipan.com/s/${current.id}` }, { parentId: 'nested' })).rejects.toThrow(/分页.*重复/)
  })
})

it('rejects repeated numeric pages and changing totals', () => {
  const pages = new SharedDirectoryPages(); expect(pages.accept(['a'], 1, { _total: 2 })).toBe(true)
  expect(() => pages.accept(['a'], 1, { _total: 2 })).toThrow(/重复/)
  const changing = new SharedDirectoryPages(); changing.accept(['a'], 1, { _total: 2 })
  expect(() => changing.accept(['b'], 1, { _total: 3 })).toThrow(/发生变化/)
})
