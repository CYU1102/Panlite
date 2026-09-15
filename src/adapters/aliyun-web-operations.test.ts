import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aliyunWebAdapter } from './aliyun-web'
import type { DriveAccount } from '../shared/types'
const network = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: network.fetch } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
let sequence = 0
const reply = (body: unknown) => network.fetch.mockResolvedValueOnce(new Response(JSON.stringify(body)))
const file = (id: string) => ({ file_id: id, name: `${id}.txt`, type: 'file', parent_file_id: 'root' })
function account(): DriveAccount {
  return { id: `aliweb-ops-${++sequence}`, platform: 'aliyun_web', loginType: 'token', nickname: 'fixture',
    credential: { refreshToken: 'refresh-fixture', accessToken: 'access-fixture', userId: 'drive|device|user', expiresAt: Date.now() + 3600000 }, status: 'active', createdAt: 0, updatedAt: 0 }
}
beforeEach(() => { network.fetch.mockReset(); reply({ result: true }) })

describe('Aliyun web actual adapter files and batch responses', () => {
  it.each(['listFiles', 'searchFiles'] as const)('%s reads every marker page', async method => {
    reply({ items: [file('a')], next_marker: 'next' }); reply({ items: [file('b')], next_marker: '' })
    const result = await aliyunWebAdapter[method]!(account(), '0')
    expect((Array.isArray(result) ? result : result.files).map(file => file.id)).toEqual(['a', 'b'])
    expect(JSON.parse(network.fetch.mock.calls[2][1].body).marker).toBe('next')
  })
  it.each(['listFiles', 'searchFiles'] as const)('%s rejects repeated markers', async method => {
    reply({ items: [file('a')], next_marker: 'same' }); reply({ items: [file('a')], next_marker: 'same' })
    await expect(aliyunWebAdapter[method]!(account(), '0')).rejects.toThrow(/分页.*重复/)
    expect(network.fetch).toHaveBeenCalledTimes(3)
  })
  it('rejects malformed file lists and missing created folder IDs', async () => {
    const current = account()
    reply({}); reply({})
    await expect(aliyunWebAdapter.listFiles(current, '0')).rejects.toThrow(/列表.*无效/)
    await expect(aliyunWebAdapter.mkdir(current, '0', 'Docs')).rejects.toThrow(/ID/)
  })
  it.each(['move', 'delete', 'copy'] as const)('%s rejects a failed batch member', async method => {
    reply({ responses: [{ id: '0', status: 403, body: { code: 'Forbidden', message: 'denied' } }] })
    const pending = method === 'delete' ? aliyunWebAdapter.delete(account(), ['a']) : aliyunWebAdapter[method]!(account(), ['a'], '0')
    await expect(pending).rejects.toThrow(/403|Forbidden|denied/)
  })
  it('rejects an incomplete batch response and accepts confirmed members', async () => {
    const current = account()
    reply({ responses: [] })
    await expect(aliyunWebAdapter.move(current, ['a'], '0')).rejects.toThrow(/批量.*不完整/)
    reply({ responses: [{ id: '0', status: 204 }] })
    await expect(aliyunWebAdapter.delete(current, ['a'])).resolves.toBeUndefined()
  })
  it('reports partial share saves without counting failed or missing file IDs as success', async () => {
    reply({ share_token: 'share-fixture' })
    reply({ items: [file('a'), file('b')], next_marker: '' })
    reply({ responses: [{ id: '0', status: 201, body: { file_id: 'saved-a' } }, { id: '1', status: 403, body: { code: 'Forbidden' } }] })
    expect(await aliyunWebAdapter.saveSharedFiles!(account(), { url: 'https://www.alipan.com/s/fixture' }, '0')).toMatchObject({ success: true, savedCount: 1, savedFileIds: ['saved-a'], error: '1 个文件保存失败' })
  })
})
