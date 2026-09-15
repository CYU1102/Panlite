import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AppUpdateController } from './app-update-controller'
import { updatesEnabled, validUpdateFeed } from '../shared/app-update'

function fixture() {
  const engine = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => { engine.emit('update-available', { version: '0.3.0' }); return {} }),
    downloadUpdate: vi.fn(async () => { engine.emit('update-downloaded', { version: '0.3.0' }); return [] }),
    quitAndInstall: vi.fn(),
  })
  const running = vi.fn(() => false)
  const confirm = vi.fn(async () => true)
  const notify = vi.fn()
  const controller = new AppUpdateController(engine, notify, running, confirm)
  return { engine, running, confirm, notify, controller }
}

describe('application update lifecycle', () => {
  it('keeps unsigned builds disabled and never prompts to install', async () => {
    const confirm = vi.fn()
    const controller = new AppUpdateController(null, vi.fn(), () => false, confirm)
    expect((await controller.check()).success).toBe(false)
    expect((await controller.download()).success).toBe(false)
    expect((await controller.install()).success).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })
  it('only downloads on request and installs after explicit confirmation', async () => {
    const { controller, engine, confirm } = fixture()
    await controller.check()
    expect(controller.getState().phase).toBe('available')
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    await controller.download()
    expect(controller.getState().phase).toBe('downloaded')
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    await controller.install()
    expect(confirm).toHaveBeenCalledOnce()
    expect(engine.quitAndInstall).toHaveBeenCalledWith(false, true)
  })
  it('rejects download and install before a checked update exists', async () => {
    const { controller, engine } = fixture()
    await controller.download(); await controller.install()
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
  })
  it('coalesces simultaneous checks without sending a second network request', async () => {
    const { controller, engine } = fixture()
    let finish!: (value: object) => void
    engine.checkForUpdates.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = controller.check()
    expect((await controller.check()).success).toBe(false)
    engine.emit('update-not-available'); finish({})
    await first
    expect(engine.checkForUpdates).toHaveBeenCalledOnce()
    expect(controller.getState().phase).toBe('current')
  })
  it('blocks duplicate downloads and clamps progress', async () => {
    const { controller, engine } = fixture()
    await controller.check()
    let finish!: (value: never[]) => void
    engine.downloadUpdate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = controller.download()
    await controller.download(); await controller.check()
    engine.emit('download-progress', { percent: 150 })
    expect(controller.getState().percent).toBe(100)
    engine.emit('download-progress', { percent: NaN })
    expect(controller.getState().percent).toBe(100)
    engine.emit('update-downloaded'); finish([])
    await first
    expect(engine.downloadUpdate).toHaveBeenCalledOnce()
    expect(engine.checkForUpdates).toHaveBeenCalledOnce()
  })
  it('does not install an unverified download after a signature failure', async () => {
    const { controller, engine } = fixture()
    await controller.check()
    engine.downloadUpdate.mockRejectedValueOnce(new Error('ERR_UPDATER_INVALID_SIGNATURE'))
    expect((await controller.download()).success).toBe(false)
    engine.emit('update-downloaded') // a late event cannot revive a failed operation
    await controller.install()
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    expect(controller.getState().phase).toBe('error')
    await controller.check()
    expect(controller.getState().phase).toBe('available')
  })
  it('blocks installation during a running task', async () => {
    const { controller, engine, running, confirm } = fixture()
    await controller.check(); await controller.download()
    running.mockReturnValue(true)
    expect((await controller.install()).success).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
  })
  it('checks task ownership again after the confirmation dialog', async () => {
    const { controller, engine, running, confirm } = fixture()
    await controller.check(); await controller.download()
    confirm.mockImplementationOnce(async () => { running.mockReturnValue(true); return true })
    expect((await controller.install()).success).toBe(false)
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
  })
  it('leaves the verified update ready when confirmation is cancelled', async () => {
    const { controller, engine, confirm } = fixture()
    await controller.check(); await controller.download()
    confirm.mockResolvedValueOnce(false)
    await controller.install()
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    expect(controller.getState().phase).toBe('downloaded')
  })
  it('surfaces synchronous installer errors instead of claiming installation', async () => {
    const { controller, engine } = fixture()
    await controller.check(); await controller.download()
    engine.quitAndInstall.mockImplementation(() => { engine.emit('error', new Error('spawn failure')) })
    expect((await controller.install()).success).toBe(false)
  })
})

it('requires a packaged Windows build and explicit signed-build metadata', () => {
  const policy = { enabled: true, provider: 'github', owner: 'CYU1102', repo: 'Panlite', publisher: 'Fixture' }
  expect(updatesEnabled(true, 'win32', policy)).toBe(true)
  expect(updatesEnabled(false, 'win32', policy)).toBe(false)
  expect(updatesEnabled(true, 'linux', policy)).toBe(false)
  expect(updatesEnabled(true, 'win32', { ...policy, enabled: false })).toBe(false)
  expect(updatesEnabled(true, 'win32', { ...policy, publisher: '' })).toBe(false)
  expect(updatesEnabled(true, 'win32', undefined)).toBe(false)
})

it('fails closed for absent publishers and mismatched update feeds', () => {
  const feed = { provider: 'github', owner: 'CYU1102', repo: 'Panlite', publisherName: ['Fixture'] }
  expect(validUpdateFeed(feed, 'Fixture')).toBe(true)
  expect(validUpdateFeed(undefined, 'Fixture')).toBe(false)
  expect(validUpdateFeed({ ...feed, publisherName: undefined }, 'Fixture')).toBe(false)
  expect(validUpdateFeed({ ...feed, publisherName: ['Someone else'] }, 'Fixture')).toBe(false)
  expect(validUpdateFeed({ ...feed, repo: 'Other' }, 'Fixture')).toBe(false)
})
