import { app, BrowserWindow, session, type WebContents } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { configureResourceWebview } from '../../src/main/resource-webview'
import { RESOURCE_BROWSER_PARTITION_PREFIX } from '../../src/shared/resource-browser'

const profile = process.env.PANLITE_RESOURCE_SMOKE_PROFILE!
const output = process.env.PANLITE_RESOURCE_SMOKE_OUTPUT!
if (!profile || !output) throw new Error('An isolated profile and output are required')
app.setPath('userData', profile)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  const partition = `${RESOURCE_BROWSER_PARTITION_PREFIX}synthetic-runtime`
  const ses = session.fromPartition(partition)
  const external: string[] = [], requests: string[] = []
  let guest: WebContents | undefined
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    if (params.partition !== partition || params.src !== 'https://source.example.test/') { event.preventDefault(); return }
    delete preferences.preload; preferences.sandbox = true; preferences.contextIsolation = true; preferences.nodeIntegration = false
  })
  win.webContents.on('did-attach-webview', (_event, attached) => {
    guest = attached
    configureResourceWebview(win.webContents, attached, 'https://source.example.test', () => true, url => { external.push(url) })
  })
  try {
    await ses.protocol.handle('https', request => {
      const url = new URL(request.url); requests.push(url.toString())
      if (url.pathname === '/redirect') return Response.redirect('https://drive.uc.cn/s/Runtime42?pwd=Cd34')
      return new Response('<!doctype html><title>Synthetic resource source</title><h1>Resource fixture</h1>', { headers: { 'content-type': 'text/html' } })
    })
    await win.loadURL('data:text/html,<html><body><main></main></body></html>')
    await win.webContents.executeJavaScript(`window.__shareEvents = []; window.__stopShare = window.electronAPI.onResourceShareOpen(payload => window.__shareEvents.push(payload)); true`)
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const view = document.createElement('webview'); view.setAttribute('partition', ${JSON.stringify(partition)});
      view.setAttribute('src','https://source.example.test/'); view.setAttribute('allowpopups','');
      view.style.cssText='width:600px;height:450px;display:flex';
      view.addEventListener('dom-ready', () => resolve(true), {once:true});
      view.addEventListener('did-fail-load', event => { if (event.errorCode !== -3 && event.isMainFrame !== false) reject(new Error(event.errorDescription)); });
      document.querySelector('main').append(view);
    })`)
    assert(guest)
    const waitForCount = async (count: number) => {
      const deadline = Date.now() + 5000
      while (await win.webContents.executeJavaScript('window.__shareEvents.length') < count) {
        if (Date.now() > deadline) throw new Error(`Expected ${count} share events`)
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    await guest.executeJavaScript(`window.open('https://pan.quark.cn/s/Runtime42?pwd=Ab12','_blank')`, true)
    await waitForCount(1)
    await guest.executeJavaScript(`location.href = 'https://source.example.test/redirect'`, true).catch(() => {})
    await waitForCount(2)
    await guest.executeJavaScript(`window.open('https://docs.example.test/help','_blank')`, true)
    const received = await win.webContents.executeJavaScript('window.__shareEvents')
    assert.equal(received[0].guestId, guest.id); assert.equal(received[0].password, 'Ab12')
    assert.equal(received[1].url, 'https://drive.uc.cn/s/Runtime42?pwd=Cd34')
    assert.deepEqual(external, ['https://docs.example.test/help'])
    assert.equal(BrowserWindow.getAllWindows().length, 1); assert.equal(win.isVisible(), false)
    const isolation = await guest.executeJavaScript(`({node:typeof require,bridge:typeof window.electronAPI})`)
    assert.deepEqual(isolation, { node: 'undefined', bridge: 'undefined' })
    await win.webContents.executeJavaScript('window.__stopShare(); document.querySelector("main").innerHTML = ""')
    await ses.clearStorageData(); await ses.clearCache()
    writeFileSync(join(output, 'report.json'), JSON.stringify({ passed: true, electron: process.versions.electron,
      windowVisible: false, extraWindowsCreated: false, actualWindowOpenCaptured: true, actualShareRedirectCaptured: true,
      ordinaryExternalPolicyRetained: true, guestHasNoNodeOrPrivilegedBridge: true,
      network: 'All HTTPS intercepted within isolated synthetic session; external opens recorded, never dispatched', received, external, requests }, null, 2) + '\n')
    win.destroy(); app.exit(0)
  } catch (error) {
    writeFileSync(join(output, 'report.json'), JSON.stringify({ passed: false, error: String(error), requests, external }, null, 2) + '\n')
    win.destroy(); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
