import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webdavAdapter } from './webdav'
import type { DriveAccount } from '../shared/types'

const network = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: network.fetch } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const account: DriveAccount = {
  id: 'dav-fixture', platform: 'webdav', nickname: 'DAV', loginType: 'password',
  credential: { serverUrl: 'https://dav.example.test/dav', username: 'fixture', password: 'fixture' },
  status: 'active', createdAt: 0, updatedAt: 0,
}
const entry = (href: string, collection = false) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${collection ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>3</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
const multistatus = (...entries: string[]) => `<d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`
const davReply = (...entries: string[]) => new Response(multistatus(...entries), { status: 207 })
let temporaryDirectory: string | undefined

beforeEach(() => { network.fetch.mockReset() })
afterEach(async () => {
  vi.restoreAllMocks()
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

describe('WebDAV actual adapter response and file operations', () => {
  it('rejects an HTML login page returned with HTTP 200', async () => {
    network.fetch.mockResolvedValue(new Response('<html>Sign in</html>', { status: 200 }))
    expect(await webdavAdapter.checkLogin(account)).toBe(false)
  })

  it('accepts a DAV root response and lists paths relative to the configured root', async () => {
    network.fetch.mockResolvedValueOnce(davReply(entry('/dav/', true)))
      .mockResolvedValueOnce(davReply(entry('/dav/', true), entry('/dav/a.txt'), entry('/dav/Docs/', true)))
    expect(await webdavAdapter.checkLogin(account)).toBe(true)
    const result = await webdavAdapter.listFiles(account, '0')
    expect(result.files.map(file => [file.id, file.name, file.isDir])).toEqual([
      ['/a.txt', 'a.txt', false], ['/Docs', 'Docs', true],
    ])
    expect(result.hasMore).toBe(false)
    expect(network.fetch.mock.calls[1][0]).toBe('https://dav.example.test/dav/')
    expect(network.fetch.mock.calls[1][1].headers.Depth).toBe('1')
  })

  it('rejects malformed directory and quota responses instead of reporting empty success', async () => {
    network.fetch.mockImplementation(async () => new Response('<html>Proxy error</html>', { status: 200 }))
    await expect(webdavAdapter.listFiles(account, '0')).rejects.toThrow(/WebDAV.*响应/)
    await expect(webdavAdapter.getQuota!(account)).rejects.toThrow(/WebDAV.*响应/)
  })

  it('does not hide a failed search subtree behind empty search results', async () => {
    network.fetch.mockResolvedValueOnce(davReply(entry('/dav/', true), entry('/dav/Docs/', true)))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
    await expect(webdavAdapter.searchFiles!(account, 'report')).rejects.toThrow('没有权限')
  })

  it('reports bounded search exhaustion rather than claiming complete results', async () => {
    network.fetch.mockImplementation(async (url: string) => {
      const current = new URL(url).pathname
      return davReply(entry(current, true), entry(`${current}child/`, true))
    })
    await expect(webdavAdapter.searchFiles!(account, 'report')).rejects.toThrow(/搜索.*上限/)
    expect(network.fetch).toHaveBeenCalledTimes(7)
  })

  it('renames root files without inserting an extra slash and forbids overwrite', async () => {
    network.fetch.mockResolvedValue(new Response(null, { status: 204 }))
    await webdavAdapter.rename(account, '/old.txt', '新 名.txt')
    expect(network.fetch.mock.calls[0][1]).toMatchObject({ method: 'MOVE', headers: {
      Destination: 'https://dav.example.test/dav/%E6%96%B0%20%E5%90%8D.txt', Overwrite: 'F',
    } })
  })

  it.each(['rename', 'move', 'delete'] as const)('rejects partial 207 failures during %s', async operation => {
    network.fetch.mockResolvedValue(new Response(multistatus('<d:response><d:href>/dav/a.txt</d:href><d:status>HTTP/1.1 423 Locked</d:status></d:response>'), { status: 207 }))
    const pending = operation === 'rename' ? webdavAdapter.rename(account, '/a.txt', 'b.txt')
      : operation === 'move' ? webdavAdapter.move(account, ['/a.txt'], '/Docs')
        : webdavAdapter.delete(account, ['/a.txt'])
    await expect(pending).rejects.toThrow('423')
  })

  it('does not claim a 405 MKCOL succeeded when the existing resource is a file', async () => {
    network.fetch.mockResolvedValueOnce(new Response('', { status: 405 }))
      .mockResolvedValueOnce(davReply(entry('/dav/Docs')))
    await expect(webdavAdapter.mkdir(account, '0', 'Docs')).rejects.toThrow(/文件夹|目录/)
  })

  it('allows an existing collection and creates its child', async () => {
    network.fetch.mockResolvedValueOnce(new Response('', { status: 405 }))
      .mockResolvedValueOnce(davReply(entry('/dav/Docs/', true)))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
    expect(await webdavAdapter.mkdir(account, '/Docs', 'Child')).toMatchObject({ id: '/Docs/Child', isDir: true })
  })

  it.each([201, 507])('streams real file bytes and reports 100 only after HTTP %s confirms success', async status => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'panlite-dav-'))
    const file = path.join(temporaryDirectory, 'payload.txt')
    await fs.writeFile(file, 'payload')
    const progress: number[] = []
    network.fetch.mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get('If-None-Match')).toBe('*')
        expect(await new Response(init.body).text()).toBe('payload')
        expect(progress.every(percent => percent < 100)).toBe(true)
        return new Response(null, { status })
      })
    const pending = webdavAdapter.upload!(account, file, '0', { onProgress: value => progress.push(value.percent) })
    if (status === 201) {
      expect(await pending).toMatchObject({ success: true, fileId: '/payload.txt' })
      expect(progress[progress.length - 1]).toBe(100)
    } else {
      await expect(pending).rejects.toThrow('空间不足')
      expect(progress).not.toContain(100)
    }
  })

  it('does not start PUT after a failed overwrite preflight', async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'panlite-dav-'))
    const file = path.join(temporaryDirectory, 'payload.txt')
    await fs.writeFile(file, 'payload')
    network.fetch.mockResolvedValue(new Response('', { status: 403 }))
    await expect(webdavAdapter.upload!(account, file, '0')).rejects.toThrow('没有权限')
    expect(network.fetch).toHaveBeenCalledTimes(1)
  })
})
