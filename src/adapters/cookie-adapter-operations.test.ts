import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuarkAdapter } from './quark'
import { UcAdapter } from './uc'
import type { DriveAccount } from '../shared/types'

const network = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ session: { fromPartition: () => ({ fetch: network.fetch, cookies: { set: vi.fn() } }) } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../main/request-settings', () => ({ getRequestSettings: () => ({ quarkPageSize: 2, requestDelayMs: 0 }) }))
const file = (fid: string) => ({ fid, pdir_fid: '0', file_name: `${fid}.txt`, file_type: 1, size: 3, created_at: 1, updated_at: 1 })
const reply = (body: unknown, status = 200) => network.fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))

beforeEach(() => network.fetch.mockReset())

describe.each([
  ['quark', () => new QuarkAdapter()], ['uc', () => new UcAdapter()],
] as const)('%s actual cookie adapter operations', (platform, createAdapter) => {
  const account: DriveAccount = { id: `${platform}-fixture`, platform, nickname: 'fixture', loginType: 'cookie', credential: { cookies: 'session=fixture' }, status: 'active', createdAt: 0, updatedAt: 0 }
  it('does not accept HTTP 500 as successful login even when the JSON code is zero', async () => {
    reply({ code: 0, data: { member_type: 1 } }, 500)
    expect(await createAdapter().checkLogin(account)).toBe(false)
  })
  it.each(['rename', 'move', 'delete'] as const)('rejects HTTP failure during %s', async operation => {
    reply({ code: 0 }, 403)
    const adapter = createAdapter()
    const pending = operation === 'rename' ? adapter.rename(account, 'a', 'b') : operation === 'move' ? adapter.move(account, ['a'], '0') : adapter.delete(account, ['a'])
    await expect(pending).rejects.toThrow(/403/)
  })
  it.each(['listFiles', 'searchFiles'] as const)('%s obtains subsequent pages and preserves real file IDs', async method => {
    reply({ code: 0, data: { list: [file('a'), file('b')] } })
    reply({ code: 0, data: { list: [file('c')] } })
    const result = await createAdapter()[method](account, '0')
    expect((Array.isArray(result) ? result : result.files).map(file => file.id)).toEqual(['a', 'b', 'c'])
    const [url, init] = network.fetch.mock.calls[1]
    expect(method === 'listFiles' || platform === 'quark' ? new URL(url).searchParams.get('_page') : String(JSON.parse(init.body)._page)).toBe('2')
    expect(new Headers(init.headers).get('cookie')).toBe('session=fixture')
  })
  it.each(['listFiles', 'searchFiles'] as const)('%s rejects malformed success bodies', async method => {
    reply({ code: 0, data: {} })
    await expect(createAdapter()[method](account, '0')).rejects.toThrow(/列表.*无效/)
  })
  it.each(['listFiles', 'searchFiles'] as const)('%s reports reaching the page bound rather than returning truncated success', async method => {
    network.fetch.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: { list: [file('a'), file('b')] } })))
    await expect(createAdapter()[method](account, '0')).rejects.toThrow(/上限.*不完整/)
    expect(network.fetch).toHaveBeenCalledTimes(100)
  })
  it('validates mkdir response IDs and preserves mutation request contracts', async () => {
    reply({ code: 0, data: {} })
    await expect(createAdapter().mkdir(account, '0', 'Docs')).rejects.toThrow(/ID/)
    reply({ code: 0, data: { ...file('folder'), file_type: 0, file_name: 'Docs' } })
    expect(await createAdapter().mkdir(account, '0', 'Docs')).toMatchObject({ id: 'folder', isDir: true })
    expect(JSON.parse(network.fetch.mock.calls[1][1].body)).toMatchObject({ pdir_fid: '0', file_name: 'Docs' })
  })
  it('uses the original file rename and move endpoints and payloads', async () => {
    reply({ code: 0 }); reply({ code: 0 })
    const adapter = createAdapter()
    await adapter.rename(account, 'a', 'new.txt')
    await adapter.move(account, ['a', 'b'], 'folder')
    expect(new URL(network.fetch.mock.calls[0][0]).pathname).toBe('/1/clouddrive/file/rename')
    expect(new URL(network.fetch.mock.calls[1][0]).pathname).toBe('/1/clouddrive/file/move')
    expect(JSON.parse(network.fetch.mock.calls[1][1].body)).toEqual({ action_type: 1, exclude_fids: [], filelist: ['a', 'b'], to_pdir_fid: 'folder' })
  })
  it('maps the native file boolean for directories', async () => {
    reply({ code: 0, data: { list: [{ fid: 'folder', file_name: 'Docs', file: false }] } })
    expect((await createAdapter().listFiles(account, '0')).files[0].isDir).toBe(true)
  })
})
