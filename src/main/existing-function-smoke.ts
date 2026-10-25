import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

// Opt-in isolated verification only. Active preview and file-understanding
// features are deliberately absent from this route inventory.
const ROUTES = [
  ['/accounts', '.account-manager'], ['/tasks', '.task-log'],
  ['/share-links', '.share-links'], ['/transfer-records', '.transfer-records'],
  ['/batch-transfer', '.batch-transfer'], ['/cloud-transfer', '.cloud-transfer'],
  ['/batch-share', '.batch-share'], ['/resource-search', '.resource-browser'],
  ['/global-search', '.global-search-page'], ['/backup-restore', '.module-page'],
  ['/security', '.security-page'], ['/dashboard', '.dashboard'], ['/settings', '.settings-page'],
] as const

export async function verifyExistingRoutes(window: BrowserWindow, output: string): Promise<Record<string, unknown>> {
  const rows: Record<string, unknown>[] = []
  const screenshotDir = path.join(path.dirname(output), 'existing-pages')
  fs.mkdirSync(screenshotDir, { recursive: true })
  await window.webContents.executeJavaScript(`(() => {
    window.__existingSmokeErrors = [];
    window.__existingSmokeWarnings = [];
    addEventListener('error', event => {
      if (!event.message) return;
      // CSS ResizeObserver processing reports deferred notifications with a
      // browser-generated ErrorEvent. Retain it separately from app exceptions;
      // rendered content and overflow remain independently checked below.
      // https://drafts.csswg.org/resize-observer/#deliver-resize-error
      if (event.message === 'ResizeObserver loop completed with undelivered notifications.') window.__existingSmokeWarnings.push(event.message);
      else window.__existingSmokeErrors.push(event.message);
    });
    addEventListener('unhandledrejection', event => window.__existingSmokeErrors.push(String(event.reason)));
  })()`)
  const navigate = async (route: string, selector: string): Promise<void> => {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      location.hash = ${JSON.stringify(`#${route}`)};
      const deadline = performance.now() + 12000;
      const timer = setInterval(() => {
        if (location.hash === ${JSON.stringify(`#${route}`)} && document.querySelector(${JSON.stringify(selector)})) {
          clearInterval(timer); requestAnimationFrame(() => requestAnimationFrame(resolve));
        } else if (performance.now() > deadline) { clearInterval(timer); reject(new Error('Route failed: ${route}')); }
      }, 30);
    })`)
    await new Promise(resolve => setTimeout(resolve, 220))
  }
  for (const theme of ['light', 'dark'] as const) {
    window.setSize(theme === 'light' ? 1280 : 960, 800)
    await navigate('/settings', '.settings-page')
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const wanted = ${JSON.stringify(theme)};
      if (document.documentElement.classList.contains('dark') === (wanted === 'dark')) { resolve(true); return; }
      const option = [...document.querySelectorAll('.el-radio-button')].find(element => element.textContent.trim() === (wanted === 'dark' ? '深色' : '浅色'));
      if (!option) { reject(new Error('Theme control missing')); return; }
      option.click();
      const deadline = performance.now() + 5000;
      const timer = setInterval(() => {
        if (document.documentElement.classList.contains('dark') === (wanted === 'dark')) { clearInterval(timer); resolve(true); }
        else if (performance.now() > deadline) { clearInterval(timer); reject(new Error('Theme did not change')); }
      }, 30);
    })`)
    for (const [route, selector] of ROUTES) {
      await navigate(route, selector)
      const state = await window.webContents.executeJavaScript(`(() => {
        const page = document.querySelector(${JSON.stringify(selector)});
        const area = document.querySelector('.content-area');
        return { route: location.hash, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          textLength: page?.textContent?.trim().length || 0,
          outerOverflow: document.documentElement.scrollWidth > innerWidth + 2,
          contentOverflow: area ? area.scrollWidth > area.clientWidth + 2 : false,
          errors: window.__existingSmokeErrors.splice(0), warnings: window.__existingSmokeWarnings.splice(0) };
      })()`)
      const screenshotPath = path.join(screenshotDir, `${theme}-${route.slice(1)}.png`)
      fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG())
      rows.push({ ...state, screenshotPath })
    }
  }
  // Exercise real preload -> trusted IPC -> SQLite/safeStorage in this
  // throwaway profile, using only synthetic credentials and local settings.
  const integration = await window.webContents.executeJavaScript(`(async () => {
    const api = window.electronAPI;
    const passed = [];
    const requireSuccess = (result, label) => { if (!result?.success) throw new Error(label + ': ' + (result?.error || 'missing success')); return result; };
    const initial = requireSuccess(await api.listAccounts(), 'list accounts');
    const created = requireSuccess(await api.addAccount({ platform: 'webdav', nickname: 'isolated fixture', loginType: 'password', credential: { webdavUrl: 'https://fixture.invalid/', username: 'fixture', password: 'synthetic-password' } }), 'add account');
    const listed = requireSuccess(await api.listAccounts(), 'list saved account');
    const saved = listed.accounts.find(account => account.id === created.accountId);
    if (!saved || saved.credential !== undefined) throw new Error('Account metadata missing or credentials leaked to renderer');
    requireSuccess(await api.deleteAccount(created.accountId), 'delete account');
    if ((await api.listAccounts()).accounts.length !== initial.accounts.length) throw new Error('Account deletion did not restore initial state');
    passed.push('account add/list/sanitization/delete through real SQLite and safeStorage');
    requireSuccess(await api.setSetting('requestDelayMs', '100'), 'save setting');
    const exported = requireSuccess(await api.exportConfigBackup(), 'export backup');
    requireSuccess(await api.setSetting('requestDelayMs', '200'), 'change setting');
    requireSuccess(await api.previewConfigBackup(exported.backup, { mode: 'merge' }), 'preview backup');
    requireSuccess(await api.importConfigBackup(exported.backup, { mode: 'merge' }), 'restore backup');
    if ((await api.getSetting('requestDelayMs')).value !== '100') throw new Error('Restored setting mismatch');
    passed.push('settings and backup export/preview/restore');
    requireSuccess(await api.configureAppLock({ password: 'isolated-lock-fixture', autoLockMs: 0 }), 'configure lock');
    requireSuccess(await api.lockApp(), 'lock app');
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!document.querySelector('.lock-screen')) throw new Error('Lock overlay did not appear');
    requireSuccess(await api.unlockApp('isolated-lock-fixture'), 'unlock app');
    requireSuccess(await api.appLockChangePassword('isolated-lock-fixture', 'changed-lock-fixture'), 'change lock password');
    requireSuccess(await api.unlockApp('changed-lock-fixture'), 'unlock changed password');
    requireSuccess(await api.appLockDisable('changed-lock-fixture'), 'disable lock');
    if ((await api.getAppLockStatus()).enabled) throw new Error('Lock did not disable');
    passed.push('application lock configure/overlay/unlock/change password/disable');
    return passed;
  })()`)
  const failed = rows.filter(row => !row.textLength || row.outerOverflow || row.contentOverflow || (row.errors as string[]).length)
  return { scenario: '13 existing routes, light 1280 and dark 960, isolated empty database, external HTTP blocked',
    excluded: ['file management preview', 'AI file understanding'], pages: rows, integration, passed: failed.length === 0, failures: failed }
}
