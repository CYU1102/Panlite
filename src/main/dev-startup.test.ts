import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(path.resolve('package.json'))
const { runDevelopment, checkServer } = require('./scripts/wait-and-start.js')
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

function fixture() {
  const children: EventEmitter[] = []
  const spawnProcess = vi.fn<(command: string, args: string[], options: { env: Record<string, string>; windowsHide: boolean; cwd: string; stdio: string }) => EventEmitter>(() => { const child = new EventEmitter(); children.push(child); return child })
  const wait = vi.fn(async () => true)
  const environment = { ELECTRON_RUN_AS_NODE: '1', VITE_PORT: '5379', PRESERVE: 'fixture' }
  const result = runDevelopment({ spawnProcess, wait, workspaceDir: process.cwd(), nodePath: 'fixture-node', electronPath: 'fixture-electron', environment })
  return { children, spawnProcess, wait, environment, result }
}

describe('development startup', () => {
  it('builds current main sources before starting Electron and retains its exit status', async () => {
    const f = fixture()
    expect(f.spawnProcess).toHaveBeenCalledTimes(1)
    expect(f.spawnProcess.mock.calls[0]).toEqual(['fixture-node', [path.resolve('scripts/build-main.mjs')], expect.objectContaining({ windowsHide: true })])
    f.children[0].emit('exit', 0); await vi.waitFor(() => expect(f.spawnProcess).toHaveBeenCalledTimes(2))
    expect(f.wait).toHaveBeenCalledWith('5379')
    expect(f.spawnProcess.mock.calls[1]).toMatchObject(['fixture-electron', ['.'], { env: { VITE_DEV_SERVER_URL: 'http://localhost:5379', PRESERVE: 'fixture' }, windowsHide: true }])
    expect(f.spawnProcess.mock.calls[1][2].env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(f.environment.ELECTRON_RUN_AS_NODE).toBe('1')
    f.children[1].emit('exit', 7)
    await expect(f.result).resolves.toBe(7)
  })
  it('never launches an old build if the current main build fails', async () => {
    const f = fixture(), rejected = expect(f.result).rejects.toThrow('主进程构建失败')
    f.children[0].emit('exit', 1); await rejected
    expect(f.wait).not.toHaveBeenCalled()
    expect(f.spawnProcess).toHaveBeenCalledTimes(1)
  })
  it('reports build process launch errors without an unhandled error event', async () => {
    const f = fixture(), rejected = expect(f.result).rejects.toThrow('fixture build launch failure')
    f.children[0].emit('error', new Error('fixture build launch failure')); await rejected
    expect(f.spawnProcess).toHaveBeenCalledTimes(1)
  })
  it('does not open Electron while the development server is unavailable', async () => {
    const f = fixture()
    f.wait.mockResolvedValue(false)
    const rejected = expect(f.result).rejects.toThrow('Vite 开发服务未就绪')
    f.children[0].emit('exit', 0); await rejected
    expect(f.spawnProcess).toHaveBeenCalledTimes(1)
  })
  it('handles an Electron launch error after a successful build', async () => {
    const f = fixture(), rejected = expect(f.result).rejects.toThrow('fixture Electron launch failure')
    f.children[0].emit('exit', 0); await vi.waitFor(() => expect(f.spawnProcess).toHaveBeenCalledTimes(2))
    f.children[1].emit('error', new Error('fixture Electron launch failure')); await rejected
  })
  it('rejects a stalled local HTTP probe instead of waiting indefinitely', async () => {
    const server = createServer(() => {}); servers.push(server)
    await new Promise<void>(resolve => server.listen(0, 'localhost', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    expect(await checkServer(String(address.port), 50)).toBe(false)
  })
  it.each([
    { body: { app: 'PanLite', projectRoot: process.cwd() }, expected: true },
    { body: { app: 'Other', projectRoot: process.cwd() }, expected: false },
    { body: { app: 'PanLite', projectRoot: path.resolve('another-checkout') }, expected: false },
    { body: '<html>another development server</html>', expected: false },
  ])('only trusts the current project health response: $expected / $body', async ({ body, expected }) => {
    let requestedUrl = ''
    const server = createServer((request, response) => { requestedUrl = request.url || ''; response.end(typeof body === 'string' ? body : JSON.stringify(body)) }); servers.push(server)
    await new Promise<void>(resolve => server.listen(0, 'localhost', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    expect(await checkServer(String(address.port))).toBe(expected)
    expect(requestedUrl).toBe('/__panlite_health')
  })
})
