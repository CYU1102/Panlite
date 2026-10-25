import type { WebContents } from 'electron'
import { getExternalHttpUrl } from './ipc-security'
import { getResourceShareTarget, RESOURCE_SHARE_OPEN_CHANNEL } from '../shared/resource-browser'

/** Bound by main after an approved attachment; the guest receives no privileged IPC bridge. */
export function configureResourceWebview(owner: WebContents, guest: WebContents, allowedOrigin: string,
  isTrustedOwner: () => boolean, openExternal: (url: string) => unknown): () => void {
  let disposed = false
  const owned = () => !disposed && !owner.isDestroyed() && !guest.isDestroyed() && guest.hostWebContents === owner && isTrustedOwner()
  const openTarget = (value: string) => {
    if (!owned()) return
    const share = getResourceShareTarget(value)
    if (share) owner.send(RESOURCE_SHARE_OPEN_CHANNEL, { guestId: guest.id, ...share })
    else {
      const target = getExternalHttpUrl(value)
      if (target) void openExternal(target)
    }
  }
  guest.setWindowOpenHandler(({ url }) => { openTarget(url); return { action: 'deny' } })
  const navigate = (event: Electron.Event, url: string) => {
    const share = getResourceShareTarget(url)
    const target = getExternalHttpUrl(url)
    if (share || !target || new URL(target).origin !== allowedOrigin) {
      event.preventDefault()
      openTarget(url)
    }
  }
  guest.on('will-navigate', navigate)
  guest.on('will-redirect', navigate)
  const ownerNavigation = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => { if (isMainFrame) dispose() }
  const dispose = () => {
    if (disposed) return
    disposed = true
    guest.removeListener('will-navigate', navigate); guest.removeListener('will-redirect', navigate)
    guest.removeListener('destroyed', dispose); owner.removeListener('destroyed', dispose)
    owner.removeListener('render-process-gone', dispose); owner.removeListener('did-start-navigation', ownerNavigation)
  }
  guest.once('destroyed', dispose); owner.once('destroyed', dispose); owner.once('render-process-gone', dispose)
  owner.on('did-start-navigation', ownerNavigation)
  guest.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  guest.session.setPermissionCheckHandler(() => false)
  return dispose
}
