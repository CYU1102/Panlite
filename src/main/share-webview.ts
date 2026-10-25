import type { WebContents } from 'electron'
import { getShareBrowserUrl } from '../shared/share-browser'

/** Keep share-page navigation inside its sandboxed guest, including target=_blank. */
export function configureShareWebview(guest: WebContents): void {
  // The guest's allowpopups attribute lets Chromium deliver these requests;
  // every request is denied here and its URL is loaded in the existing guest.
  guest.setWindowOpenHandler(({ url }) => {
    const target = getShareBrowserUrl(url)
    if (target) void guest.loadURL(target).catch(() => { /* Guest reports did-fail-load to its host. */ })
    return { action: 'deny' }
  })
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (!getShareBrowserUrl(url)) event.preventDefault()
  }
  guest.on('will-navigate', guardNavigation)
  guest.on('will-redirect', guardNavigation)
  guest.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
}
