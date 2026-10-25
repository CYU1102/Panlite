import { app, BrowserWindow, session, type WebContents } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { InlineLoginManager } from '../../src/main/inline-login'

const profile = process.env.PANLITE_INLINE_SMOKE_PROFILE!
const output = process.env.PANLITE_INLINE_SMOKE_OUTPUT!
if (!profile || !output) throw new Error('An isolated profile and output are required')
app.setPath('userData', profile)
const manager = new InlineLoginManager()
const requests: string[] = []
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  const guestBySession = new Map<Electron.Session, WebContents>()
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    if (!manager.allowsAttachment(win.webContents, params.partition, params.src)) { event.preventDefault(); return }
    delete preferences.preload
    preferences.sandbox = true; preferences.contextIsolation = true; preferences.nodeIntegration = false
  })
  win.webContents.on('did-attach-webview', (_event, guest) => {
    assert(manager.attach(win.webContents, guest)); guestBySession.set(guest.session, guest)
  })
  try {
    await win.loadURL('data:text/html,<html><body><main></main></body></html>')
    const results = []
    for (const platform of ['quark', 'uc'] as const) {
      const start = await manager.start(win.webContents, platform), descriptor = start.session!
      const ses = session.fromPartition(descriptor.partition)
      assert.equal(ses.isPersistent(), false)
      await ses.protocol.handle('https', request => {
        const url = new URL(request.url)
        requests.push(`${platform}:${url.hostname}${url.pathname}`)
        if (url.pathname === '/account/info') return new Response(JSON.stringify({ code: 0, success: true, data: { nickname: `Synthetic ${platform}` } }), { headers: { 'content-type': 'application/json' } })
        if (url.pathname === '/1/clouddrive/member') return new Response(JSON.stringify({ code: 0, data: {} }), { headers: { 'content-type': 'application/json' } })
        return new Response('<!doctype html><title>Synthetic official login</title><h1>Isolated login fixture</h1>', { headers: { 'content-type': 'text/html' } })
      })
      await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        document.querySelector('main').innerHTML = '';
        const view = document.createElement('webview');
        view.setAttribute('partition', ${JSON.stringify(descriptor.partition)});
        view.setAttribute('src', ${JSON.stringify(descriptor.url)});
        view.style.cssText = 'width:600px;height:450px;display:flex';
        view.addEventListener('dom-ready', () => resolve(true), {once:true});
        view.addEventListener('did-fail-load', event => { if (event.errorCode !== -3 && event.isMainFrame !== false) reject(new Error(event.errorDescription)); });
        document.querySelector('main').append(view);
      })`)
      const guest = guestBySession.get(ses)!
      assert(guest)
      const isolation = await guest.executeJavaScript(`({ node: typeof require, bridge: typeof window.electronAPI, title: document.title })`)
      assert.equal(isolation.node, 'undefined'); assert.equal(isolation.bridge, 'undefined')
      assert.equal(isolation.title, 'Synthetic official login')
      assert.equal(win.isVisible(), false)
      assert.equal((await manager.status(win.webContents, descriptor.id)).state, 'waiting')
      await ses.cookies.set({ url: descriptor.url, name: 'synthetic-auth', value: 'fixture', secure: true })
      const verified = await manager.status(win.webContents, descriptor.id)
      assert.equal(verified.state, 'success'); assert.equal(verified.nickname, `Synthetic ${platform}`)
      assert(verified.cookies?.includes('synthetic-auth=fixture'))
      await manager.cancel(win.webContents, descriptor.id)
      assert.equal((await manager.status(win.webContents, descriptor.id)).success, false)
      assert.equal((await ses.cookies.get({})).length, 0)
      results.push({ platform, temporarySession: true, actualGuestAttached: true, nodeAndBridgeAbsent: true, validatedSyntheticCredentials: true, cancelClearedCookies: true, windowVisible: win.isVisible() })
    }
    writeFileSync(join(output, 'report.json'), JSON.stringify({ passed: true, electron: process.versions.electron, network: 'All HTTPS handled in isolated sessions by synthetic responses; no real accounts', results, requests }, null, 2) + '\n')
    await manager.dispose(); win.destroy(); app.exit(0)
  } catch (error) {
    writeFileSync(join(output, 'report.json'), JSON.stringify({ passed: false, error: String(error), requests }, null, 2) + '\n')
    await manager.dispose(); win.destroy(); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
