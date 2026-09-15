import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface DavHttpRequest { method: string; path: string; depth?: string; status?: number; bytes: number; committed: boolean; authenticated: boolean; ifNoneMatch?: string }
export interface DavHttpFault {
  method: 'PUT' | 'GET' | 'DELETE' | 'PROPFIND' | 'MKCOL'
  path?: string
  mode: 'drop-after-commit' | 'http-503' | 'truncated-get' | 'truncated-multistatus' | 'failed-resource' | 'truncated-mutation' | 'malformed-multistatus' | 'missing-resource-href'
}
const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const encodePath = (value: string): string => value.split('/').map(encodeURIComponent).join('/')

/** A real HTTP/1.1 DAV endpoint, restricted to one loopback listener and one isolated on-disk tree. */
export async function startDavHttpServer(root: string) {
  await fs.mkdir(root, { recursive: true })
  const mount = '/dav/备份 空间', username = 'isolated', password = randomUUID(), authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const requests: DavHttpRequest[] = [], faults: DavHttpFault[] = [], errors: unknown[] = []
  let origin = ''
  const local = (relative: string): string => {
    if (!relative.startsWith('/') || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(segment => segment === '..' || segment === '.')) throw new Error('Invalid fixture DAV path')
    const absolute = path.resolve(root, `.${relative}`), within = path.relative(path.resolve(root), absolute)
    if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new Error('Fixture path escaped its isolated tree')
    return absolute
  }
  const exists = async (file: string): Promise<boolean> => { try { await fs.lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
  const responseXml = async (relative: string): Promise<string> => {
    const stat = await fs.stat(local(relative)), directory = stat.isDirectory()
    const href = origin + encodePath(mount + (relative === '/' ? '/' : relative + (directory ? '/' : '')))
    return `<d:response><d:href>${xml(href)}</d:href><d:propstat><d:prop><d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${directory ? 0 : stat.size}</d:getcontentlength><d:getlastmodified>${stat.mtime.toUTCString()}</d:getlastmodified><d:creationdate>${stat.birthtime.toISOString()}</d:creationdate></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  }
  const server = http.createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url!, origin).pathname)
      if (pathname !== mount && !pathname.startsWith(mount + '/')) { response.writeHead(404).end(); return }
      const relative = (pathname.slice(mount.length) || '/').replace(/\/+$/, '') || '/', absolute = local(relative)
      const entry: DavHttpRequest = { method: request.method!, path: relative, depth: typeof request.headers.depth === 'string' ? request.headers.depth : undefined, bytes: 0, committed: false,
        authenticated: request.headers.authorization === authorization, ifNoneMatch: request.headers['if-none-match'] }
      requests.push(entry)
      const send = (status: number, body?: string | Buffer): void => { entry.status = status; response.writeHead(status).end(body) }
      if (!entry.authenticated) { send(401); return }
      const faultIndex = faults.findIndex(fault => fault.method === entry.method && (fault.path === undefined || fault.path === relative))
      const fault = faultIndex < 0 ? undefined : faults.splice(faultIndex, 1)[0]
      if (fault?.mode === 'http-503') { request.resume(); send(503, 'Fixture unavailable'); return }
      if (fault?.mode === 'truncated-mutation') {
        send(207, `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${xml(origin + encodePath(mount + relative))}</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response><d:response>`); return
      }
      if (entry.method === 'PROPFIND') {
        if (!await exists(absolute)) { send(404); return }
        let body = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' + await responseXml(relative)
        if (fault?.mode === 'failed-resource') body += `<d:response><d:href>${xml(origin + encodePath(mount + relative + '/unreadable'))}</d:href><d:status>HTTP/1.1 503 Service Unavailable</d:status></d:response>`
        else if (fault?.mode !== 'truncated-multistatus' && request.headers.depth !== '0' && (await fs.stat(absolute)).isDirectory()) {
          for (const child of (await fs.readdir(absolute)).sort()) body += await responseXml((relative === '/' ? '' : relative) + '/' + child)
        }
        if (fault?.mode === 'truncated-multistatus') body += '<d:response><d:href>'
        else {
          if (fault?.mode === 'malformed-multistatus') body += '<d:response><d:href>/unfinished</d:response>'
          if (fault?.mode === 'missing-resource-href') body += '<d:response><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
          body += '</d:multistatus>'
        }
        entry.status = 207; response.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' }).end(body); return
      }
      if (entry.method === 'MKCOL') {
        if (await exists(absolute)) { send(405); return }
        if (!await exists(path.dirname(absolute))) { send(409); return }
        await fs.mkdir(absolute); entry.committed = true
        if (fault?.mode === 'drop-after-commit') { request.socket.destroy(); return }
        send(201); return
      }
      if (entry.method === 'PUT') {
        const chunks: Buffer[] = []
        for await (const chunk of request) { chunks.push(Buffer.from(chunk)); entry.bytes += chunk.length }
        if (entry.bytes !== Number(request.headers['content-length'])) { send(400); return }
        if (!await exists(path.dirname(absolute))) { send(409); return }
        if (entry.ifNoneMatch === '*' && await exists(absolute)) { send(412); return }
        await fs.writeFile(absolute, Buffer.concat(chunks), { flag: entry.ifNoneMatch === '*' ? 'wx' : 'w' }); entry.committed = true
        if (fault?.mode === 'drop-after-commit') { request.socket.destroy(); return }
        send(201); return
      }
      if (entry.method === 'GET' || entry.method === 'HEAD') {
        if (!await exists(absolute) || !(await fs.stat(absolute)).isFile()) { send(404); return }
        const body = await fs.readFile(absolute)
        entry.status = 200; response.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' })
        if (fault?.mode === 'truncated-get') { response.write(body.subarray(0, Math.max(1, Math.floor(body.length / 2)))); setImmediate(() => response.destroy()); return }
        entry.bytes = entry.method === 'HEAD' ? 0 : body.length; response.end(entry.method === 'HEAD' ? undefined : body); return
      }
      if (entry.method === 'DELETE') {
        if (!await exists(absolute)) { send(404); return }
        if ((await fs.stat(absolute)).isDirectory()) { send(405); return }
        await fs.unlink(absolute); entry.committed = true
        if (fault?.mode === 'drop-after-commit') { request.socket.destroy(); return }
        send(204); return
      }
      send(405)
    })().catch(error => { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No isolated HTTP port')
  origin = `http://127.0.0.1:${address.port}`
  return { root, origin, url: origin + encodePath(mount), username, password, requests, errors,
    fault: (fault: DavHttpFault): void => { faults.push(fault) },
    read: (relative: string): Promise<Buffer> => fs.readFile(local(relative)),
    exists: (relative: string): Promise<boolean> => exists(local(relative)),
    async close(): Promise<void> { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}
