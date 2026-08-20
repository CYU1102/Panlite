import { BrowserWindow, session, ipcMain } from 'electron'
import { join } from 'path'
import log from 'electron-log'

export interface LoginWindowResult {
  success: boolean
  cookies?: string
  userAgent?: string
  nickname?: string
  refreshToken?: string
  accessToken?: string
  userId?: string
  error?: string
}

// 完全参照 QuarkPanTool 的 User-Agent
const QUARK_UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko)' +
  ' Chrome/94.0.4606.71 Safari/537.36 Core/1.94.225.400 QQBrowser/12.2.5544.400'

/**
 * 打开夸克网盘登录窗口
 * 完全参照 QuarkPanTool 的逻辑：
 * 1. 打开 pan.quark.cn
 * 2. 用户扫码登录
 * 3. 登录成功后用户点击"我已登录"按钮
 * 4. 获取 cookie 并用 account/info 接口验证
 */
export async function openQuarkLoginWindow(parentWindow: BrowserWindow): Promise<LoginWindowResult> {
  return new Promise((resolve) => {
    let resolved = false

    const loginWindow = new BrowserWindow({
      parent: parentWindow,
      width: 600,
      height: 800,
      modal: true,
      title: '夸克网盘登录 - 扫码后点击"我已登录"',
      show: false,
      webPreferences: {
        partition: 'persist:quark-login',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(__dirname, 'login-preload.js'),
      },
    })

    const quarkSession = session.fromPartition('persist:quark-login')

    quarkSession.webRequest.onBeforeSendHeaders((details, callback) => {
      details.requestHeaders['User-Agent'] = QUARK_UA
      callback({ requestHeaders: details.requestHeaders })
    })

    // 注入一个悬浮按钮到页面中，用户登录后点击
    loginWindow.webContents.on('did-finish-load', () => {
      log.info('Quark login window: page loaded:', loginWindow.webContents.getURL())
      loginWindow.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('__panlite_login_btn')) return;
          var btn = document.createElement('div');
          btn.id = '__panlite_login_btn';
          btn.innerHTML = '✅ 我已登录完成';
          btn.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999999;' +
            'background:#22c55e;color:white;padding:14px 32px;border-radius:12px;font-size:16px;font-weight:bold;' +
            'cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.3);text-align:center;';
          btn.onclick = function() {
            btn.innerHTML = '正在获取登录信息...';
            btn.style.background = '#94a3b8';
            window.electronAPI.confirmLogin();
          };
          document.body.appendChild(btn);
        })();
      `).catch(() => {})
    })

    // 监听用户点击"我已登录"按钮
    const onConfirm = async (_event: Electron.IpcMainEvent) => {
      if (resolved) return

      try {
        const allCookies = await quarkSession.cookies.get({})
        const cookieStr = allCookies
          .filter((c) => c.domain?.includes('quark.cn'))
          .map((c) => `${c.name}=${c.value}`)
          .join('; ')

        log.info(`Quark login: user confirmed, got ${allCookies.length} cookies, cookieStr length=${cookieStr.length}`)

        if (cookieStr.length < 50) {
          log.warn('Quark login: cookie string too short, probably not logged in')
          loginWindow.webContents.executeJavaScript(`
            var btn = document.getElementById('__panlite_login_btn');
            if (btn) { btn.innerHTML = '❌ 未检测到登录，请先扫码登录'; btn.style.background = '#ef4444'; }
            setTimeout(function() {
              if (btn) { btn.innerHTML = '✅ 我已登录完成'; btn.style.background = '#22c55e'; }
            }, 3000);
          `).catch(() => {})
          return
        }

        // 用 QuarkPanTool 的 account/info 接口验证（参照 quark.py get_user_info）
        const verifyUrl = `https://pan.quark.cn/account/info?fr=pc&platform=pc&t=${Date.now()}`
        log.info('Quark login: verifying with account/info API...')

        const verifyRes = await quarkSession.fetch(verifyUrl, {
          headers: {
            'User-Agent': QUARK_UA,
            'Cookie': cookieStr,
            'Referer': 'https://pan.quark.cn/',
            'Accept': 'application/json, text/plain, */*',
          },
        })
        const verifyData = await verifyRes.json() as { data?: { nickname?: string }; code?: number; message?: string }

        log.info('Quark login: account/info response:', JSON.stringify(verifyData).substring(0, 200))

        if (verifyData.data && verifyData.data.nickname) {
          resolved = true
          ipcMain.removeListener('__login_confirm', onConfirm)
          loginWindow.close()
          resolve({
            success: true,
            cookies: cookieStr,
            userAgent: QUARK_UA,
            nickname: verifyData.data.nickname,
          })
        } else {
          log.warn('Quark login: account/info returned no nickname, not logged in')
          loginWindow.webContents.executeJavaScript(`
            var btn = document.getElementById('__panlite_login_btn');
            if (btn) { btn.innerHTML = '❌ 登录验证失败，请确认已扫码'; btn.style.background = '#ef4444'; }
            setTimeout(function() {
              if (btn) { btn.innerHTML = '✅ 我已登录完成'; btn.style.background = '#22c55e'; }
            }, 3000);
          `).catch(() => {})
        }
      } catch (err) {
        log.error('Quark login confirm error:', String(err))
      }
    }

    ipcMain.on('__login_confirm', onConfirm)

    loginWindow.loadURL('https://pan.quark.cn/')

    loginWindow.once('ready-to-show', () => {
      log.info('Quark login window: ready-to-show')
      loginWindow.show()
    })

    loginWindow.on('closed', () => {
      ipcMain.removeListener('__login_confirm', onConfirm)
      if (!resolved) {
        resolved = true
        resolve({ success: false, error: '登录窗口已关闭' })
      }
    })
  })
}

/**
 * 清除夸克登录会话
 */
export async function clearQuarkLoginSession(): Promise<void> {
  const quarkSession = session.fromPartition('persist:quark-login')
  quarkSession.clearStorageData().catch(() => {})
  log.info('Quark login session cleared')
}

/**
 * 打开 UC 网盘登录窗口
 */
export async function openUcLoginWindow(parentWindow: BrowserWindow): Promise<LoginWindowResult> {
  return new Promise((resolve) => {
    let resolved = false

    const loginWindow = new BrowserWindow({
      parent: parentWindow,
      width: 600,
      height: 800,
      modal: true,
      title: 'UC网盘登录 - 扫码后点击"我已登录"',
      show: false,
      webPreferences: {
        partition: 'persist:uc-login',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(__dirname, 'login-preload.js'),
      },
    })

    loginWindow.webContents.on('did-finish-load', () => {
      loginWindow.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('__panlite_login_btn')) return;
          var btn = document.createElement('div');
          btn.id = '__panlite_login_btn';
          btn.innerHTML = '✅ 我已登录完成';
          btn.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999999;' +
            'background:#22c55e;color:white;padding:14px 32px;border-radius:12px;font-size:16px;font-weight:bold;' +
            'cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.3);text-align:center;';
          btn.onclick = function() {
            btn.innerHTML = '正在获取登录信息...';
            btn.style.background = '#94a3b8';
            window.electronAPI.confirmLogin();
          };
          document.body.appendChild(btn);
        })();
      `).catch(() => {})
    })

    const ucSession = session.fromPartition('persist:uc-login')

    const onConfirm = async (_event: Electron.IpcMainEvent) => {
      if (resolved) return
      try {
        const allCookies = await ucSession.cookies.get({})
        log.info(`UC login: total cookies=${allCookies.length}, domains=${[...new Set(allCookies.map(c => c.domain))].join(', ')}`)
        const ucCookies = allCookies.filter((c) => c.domain?.includes('uc.cn'))
        log.info(`UC login: uc.cn cookies=${ucCookies.length}, names=${ucCookies.map(c => c.name).join(', ')}`)
        let cookieStr = ucCookies
          .map((c) => `${c.name}=${c.value}`)
          .join('; ')

        if (cookieStr.length < 50) {
          loginWindow.webContents.executeJavaScript(`
            var btn = document.getElementById('__panlite_login_btn');
            if (btn) { btn.innerHTML = '❌ 未检测到登录'; btn.style.background = '#ef4444'; }
            setTimeout(function() { if (btn) { btn.innerHTML = '✅ 我已登录完成'; btn.style.background = '#22c55e'; } }, 3000);
          `).catch(() => {})
          return
        }

        // 从页面提取真实昵称
        let nickname = 'UC用户'
        try {
          nickname = await loginWindow.webContents.executeJavaScript(`
            (function() {
              var el = document.querySelector('.user-name')
                || document.querySelector('[class*="nickname"]')
                || document.querySelector('[class*="username"]')
                || document.querySelector('[class*="uname"]')
                || document.querySelector('.personal-name');
              if (el && el.textContent.trim()) return el.textContent.trim();
              try {
                if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user) {
                  return window.__INITIAL_STATE__.user.nickname || '';
                }
              } catch(e) {}
              return '';
            })()
          `)
          if (!nickname) nickname = 'UC用户'
          log.info('UC login: extracted nickname:', nickname)
        } catch {
          log.info('UC login: could not extract nickname from page')
        }

        // 调用一次 UC API 来获取服务端设置的 Cookie（如 tfstk）
        // 这些 Cookie 是分享等写操作必需的
        try {
          log.info('UC login: fetching API to get server cookies...')
          await ucSession.fetch('https://pc-api.uc.cn/1/clouddrive/member?pr=UCBrowser&fr=pc', {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36',
              'Referer': 'https://drive.uc.cn/',
              'Cookie': cookieStr,
            },
          })
          // 重新获取所有 Cookie（包括 API 服务端设置的）
          const allCookiesAfterApi = await ucSession.cookies.get({})
          const ucCookiesAfterApi = allCookiesAfterApi.filter((c) => c.domain?.includes('uc.cn'))
          const newCookieStr = ucCookiesAfterApi.map((c) => `${c.name}=${c.value}`).join('; ')
          log.info(`UC login: cookies after API call: ${ucCookiesAfterApi.length} (was ${ucCookies.length}), new names: ${ucCookiesAfterApi.filter(c => !ucCookies.some(oc => oc.name === c.name)).map(c => c.name).join(', ')}`)
          if (newCookieStr.length > cookieStr.length) {
            cookieStr = newCookieStr
            log.info(`UC login: updated cookie string, new length=${cookieStr.length}`)
          }
        } catch (err) {
          log.warn('UC login: failed to fetch API for extra cookies:', String(err))
        }

        resolved = true
        ipcMain.removeListener('__login_confirm', onConfirm)
        loginWindow.close()
        resolve({ success: true, cookies: cookieStr, nickname })
      } catch (err) {
        log.error('UC login confirm error:', String(err))
      }
    }

    ipcMain.on('__login_confirm', onConfirm)

    loginWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      log.error(`UC login window: page load failed: ${errorCode} ${errorDescription} for ${validatedURL}`)
    })

    loginWindow.loadURL('https://drive.uc.cn/')
    loginWindow.once('ready-to-show', () => {
      log.info('UC login window: ready-to-show, url:', loginWindow.webContents.getURL())
      loginWindow.show()
    })

    loginWindow.on('closed', () => {
      ipcMain.removeListener('__login_confirm', onConfirm)
      if (!resolved) {
        resolved = true
        resolve({ success: false, error: '登录窗口已关闭' })
      }
    })
  })
}

/**
 * 打开百度网盘登录窗口
 */
export async function openBaiduLoginWindow(parentWindow: BrowserWindow): Promise<LoginWindowResult> {
  return new Promise((resolve) => {
    let resolved = false

    const loginWindow = new BrowserWindow({
      parent: parentWindow,
      width: 600,
      height: 800,
      modal: true,
      title: '百度网盘登录 - 扫码后点击"我已登录"',
      show: false,
      webPreferences: {
        partition: 'persist:baidu-login',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(__dirname, 'login-preload.js'),
      },
    })

    loginWindow.webContents.on('did-finish-load', () => {
      loginWindow.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('__panlite_login_btn')) return;
          var btn = document.createElement('div');
          btn.id = '__panlite_login_btn';
          btn.innerHTML = '✅ 我已登录完成';
          btn.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999999;' +
            'background:#22c55e;color:white;padding:14px 32px;border-radius:12px;font-size:16px;font-weight:bold;' +
            'cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.3);text-align:center;';
          btn.onclick = function() {
            btn.innerHTML = '正在获取登录信息...';
            btn.style.background = '#94a3b8';
            window.electronAPI.confirmLogin();
          };
          document.body.appendChild(btn);
        })();
      `).catch(() => {})
    })

    const baiduSession = session.fromPartition('persist:baidu-login')

    const onConfirm = async (_event: Electron.IpcMainEvent) => {
      if (resolved) return
      try {
        const userAgent = loginWindow.webContents.getUserAgent()
        const allCookies = await baiduSession.cookies.get({})
        const cookieStr = allCookies
          .filter((c) => c.domain?.includes('baidu.com'))
          .map((c) => `${c.name}=${c.value}`)
          .join('; ')

        if (cookieStr.length < 50) {
          loginWindow.webContents.executeJavaScript(`
            var btn = document.getElementById('__panlite_login_btn');
            if (btn) { btn.innerHTML = '❌ 未检测到登录'; btn.style.background = '#ef4444'; }
            setTimeout(function() { if (btn) { btn.innerHTML = '✅ 我已登录完成'; btn.style.background = '#22c55e'; } }, 3000);
          `).catch(() => {})
          return
        }

        // 从页面提取真实昵称
        let nickname = '百度用户'
        try {
          nickname = await loginWindow.webContents.executeJavaScript(`
            (function() {
              // 百度网盘页面上的用户名元素
              var el = document.querySelector('.user-name')
                || document.querySelector('[class*="nickname"]')
                || document.querySelector('[class*="username"]')
                || document.querySelector('.header-user-name')
                || document.querySelector('[class*="user"] [class*="name"]')
                || document.querySelector('[class*="uname"]')
                || document.querySelector('.personal-name');
              if (el && el.textContent.trim()) return el.textContent.trim();
              // 尝试从页面变量获取
              try {
                if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user) {
                  return window.__INITIAL_STATE__.user.username || window.__INITIAL_STATE__.user.nickname || '';
                }
              } catch(e) {}
              // 尝试从 cookie 获取用户名
              try {
                var match = document.cookie.match(/STOKEN=([^;]+)/);
                if (match) return '百度用户';
              } catch(e) {}
              return '';
            })()
          `)
          if (!nickname) nickname = '百度用户'
          log.info('Baidu login: extracted nickname:', nickname)
        } catch {
          log.info('Baidu login: could not extract nickname from page')
        }

        resolved = true
        ipcMain.removeListener('__login_confirm', onConfirm)
        loginWindow.close()
        resolve({ success: true, cookies: cookieStr, userAgent, nickname })
      } catch (err) {
        log.error('Baidu login confirm error:', String(err))
      }
    }

    ipcMain.on('__login_confirm', onConfirm)

    loginWindow.loadURL('https://pan.baidu.com/')
    loginWindow.once('ready-to-show', () => { loginWindow.show() })

    loginWindow.on('closed', () => {
      ipcMain.removeListener('__login_confirm', onConfirm)
      if (!resolved) {
        resolved = true
        resolve({ success: false, error: '登录窗口已关闭' })
      }
    })
  })
}

// ── 迅雷网盘 ──

const XUNLEI_CLIENT_ID = 'Xqp0kJBXWhwaTpB6'
const XUNLEI_DEVICE_ID = '925b7631473a13716b791d7f28289cad'
const XUNLEI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 打开迅雷网盘登录窗口
 * 用户登录后自动从 localStorage 提取 refresh_token
 */
export async function openXunleiLoginWindow(parentWindow: BrowserWindow): Promise<LoginWindowResult> {
  return new Promise((resolve) => {
    let resolved = false

    const loginWindow = new BrowserWindow({
      parent: parentWindow,
      width: 600,
      height: 800,
      modal: true,
      title: '迅雷网盘登录 - 登录后点击"我已登录"',
      show: false,
      webPreferences: {
        partition: 'persist:xunlei-login',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(__dirname, 'login-preload.js'),
      },
    })

    loginWindow.webContents.on('did-finish-load', () => {
      log.info('Xunlei login window: page loaded:', loginWindow.webContents.getURL())
      loginWindow.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('__panlite_login_btn')) return;
          var btn = document.createElement('div');
          btn.id = '__panlite_login_btn';
          btn.innerHTML = '✅ 我已登录完成';
          btn.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999999;' +
            'background:#22c55e;color:white;padding:14px 32px;border-radius:12px;font-size:16px;font-weight:bold;' +
            'cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.3);text-align:center;';
          btn.onclick = function() {
            btn.innerHTML = '正在获取登录信息...';
            btn.style.background = '#94a3b8';
            window.electronAPI.confirmLogin();
          };
          document.body.appendChild(btn);
        })();
      `).catch(() => {})
    })

    loginWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      log.error(`Xunlei login window: page load failed: ${errorCode} ${errorDescription} for ${validatedURL}`)
    })

    const onConfirm = async (_event: Electron.IpcMainEvent) => {
      if (resolved) return
      try {
        // 从 localStorage 提取 refresh_token
        // 先列出所有 localStorage key 用于调试
        const allKeys = await loginWindow.webContents.executeJavaScript(`
          (function() {
            var keys = [];
            for (var i = 0; i < localStorage.length; i++) {
              var k = localStorage.key(i);
              var v = localStorage.getItem(k);
              keys.push(k + ' (' + (v ? v.length : 0) + ')');
            }
            return keys;
          })()
        `)
        log.info(`Xunlei login: localStorage keys: ${JSON.stringify(allKeys)}`)

        const refreshTokenRaw = await loginWindow.webContents.executeJavaScript(`
          (function() {
            // 优先找 credentials_* key（迅雷的凭证存储位置）
            for (var i = 0; i < localStorage.length; i++) {
              var key = localStorage.key(i);
              if (!key || !key.startsWith('credentials_')) continue;
              var val = localStorage.getItem(key);
              if (!val || !val.startsWith('{')) continue;
              try {
                var obj = JSON.parse(val);
                if (!obj || typeof obj !== 'object') continue;
                // credentials 对象中找 refresh_token
                if (obj.refresh_token && typeof obj.refresh_token === 'string') {
                  return JSON.stringify({ _token: obj.refresh_token, _accessToken: obj.token || obj.access_token || '', _source: key, _type: 'credentials' });
                }
                // 如果没有 refresh_token，返回 token 字段
                if (obj.token && typeof obj.token === 'string') {
                  return JSON.stringify({ _token: '', _accessToken: obj.token, _source: key, _type: 'credentials_no_refresh' });
                }
                // 返回整个对象供调试
                return JSON.stringify({ _token: '', _accessToken: '', _source: key, _type: 'credentials_unknown', _keys: Object.keys(obj) });
              } catch(e) {}
            }

            // 备选：遍历所有 key 找包含 refresh_token 的对象
            for (var j = 0; j < localStorage.length; j++) {
              var key2 = localStorage.key(j);
              if (!key2 || key2.startsWith('/track/') || key2 === 'deviceid' || key2 === 'xl_fp_rt') continue;
              var val2 = localStorage.getItem(key2);
              if (!val2 || !val2.startsWith('{')) continue;
              try {
                var obj2 = JSON.parse(val2);
                if (obj2 && typeof obj2 === 'object' && obj2.refresh_token && typeof obj2.refresh_token === 'string') {
                  return JSON.stringify({ _token: obj2.refresh_token, _accessToken: obj2.token || '', _source: key2, _type: 'other_key' });
                }
              } catch(e) {}
            }

            return '';
          })()
        `)

        let refreshToken = ''
        let accessToken = ''
        if (refreshTokenRaw) {
          try {
            const parsed = JSON.parse(refreshTokenRaw)
            refreshToken = parsed._token || ''
            accessToken = parsed._accessToken || ''
            log.info(`Xunlei login: token found in localStorage key="${parsed._source}", type="${parsed._type}", refreshToken_len=${refreshToken.length}, accessToken_len=${accessToken.length}`)

            // 如果没有 refresh_token，尝试从原始 JSON 中查找
            if (!refreshToken) {
              for (var idx = 0; idx < localStorage.length; idx++) {
                var k = localStorage.key(idx) || '';
                var v = localStorage.getItem(k);
                if (v && v.startsWith('{')) {
                  try {
                    var o = JSON.parse(v);
                    if (o && o.refresh_token) {
                      refreshToken = o.refresh_token;
                      log.info(`Xunlei login: found refresh_token in key="${k}", len=${refreshToken.length}`);
                      break;
                    }
                  } catch(e) {}
                }
              }
            }
          } catch {
            refreshToken = refreshTokenRaw
          }
        }
        refreshToken = refreshToken.trim()
        accessToken = accessToken.trim()
        // 去除可能的引号包裹
        if (refreshToken.startsWith('"') && refreshToken.endsWith('"')) {
          try { refreshToken = JSON.parse(refreshToken) } catch {}
        }
        if (accessToken.startsWith('"') && accessToken.endsWith('"')) {
          try { accessToken = JSON.parse(accessToken) } catch {}
        }

        log.info(`Xunlei login: refreshToken_len=${refreshToken.length}, accessToken_len=${accessToken.length}`)

        if (!refreshToken && !accessToken) {
          log.warn('Xunlei login: no token found in localStorage')
          loginWindow.webContents.executeJavaScript(`
            var btn = document.getElementById('__panlite_login_btn');
            if (btn) { btn.innerHTML = '❌ 未检测到登录，请先登录'; btn.style.background = '#ef4444'; }
            setTimeout(function() { if (btn) { btn.innerHTML = '✅ 我已登录完成'; btn.style.background = '#22c55e'; } }, 3000);
          `).catch(() => {})
          return
        }

        const xunleiSession = session.fromPartition('persist:xunlei-login')
        let finalAccessToken = accessToken
        let finalRefreshToken = refreshToken

        // 优先用 refresh_token 换取新 token
        if (refreshToken) {
          try {
            const tokenRes = await xunleiSession.fetch('https://xluser-ssl.xunlei.com/v1/auth/token', {
              method: 'POST',
              headers: {
                'User-Agent': XUNLEI_UA,
                'Content-Type': 'application/json',
                'x-client-id': XUNLEI_CLIENT_ID,
                'x-device-id': XUNLEI_DEVICE_ID,
              },
              body: JSON.stringify({
                client_id: XUNLEI_CLIENT_ID,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
              }),
            }).then(r => r.json()) as any

            if (tokenRes.access_token) {
              finalAccessToken = tokenRes.access_token
              finalRefreshToken = tokenRes.refresh_token || refreshToken
              log.info('Xunlei login: token exchange success')
            } else {
              log.warn('Xunlei login: token exchange failed (will try access_token directly):', tokenRes.error_description || JSON.stringify(tokenRes).substring(0, 200))
            }
          } catch (err) {
            log.warn('Xunlei login: token exchange error:', String(err))
          }
        }

        // 如果没有 access_token，无法继续
        if (!finalAccessToken) {
          log.warn('Xunlei login: no valid access_token')
          loginWindow.webContents.executeJavaScript(`
            var btn = document.getElementById('__panlite_login_btn');
            if (btn) { btn.innerHTML = '❌ Token 验证失败'; btn.style.background = '#ef4444'; }
            setTimeout(function() { if (btn) { btn.innerHTML = '✅ 我已登录完成'; btn.style.background = '#22c55e'; } }, 3000);
          `).catch(() => {})
          return
        }

        // 获取 captcha_token
        let captchaToken = ''
        try {
          const captchaRes = await xunleiSession.fetch('https://xluser-ssl.xunlei.com/v1/shield/captcha/init', {
            method: 'POST',
            headers: {
              'User-Agent': XUNLEI_UA,
              'Content-Type': 'application/json',
              'x-client-id': XUNLEI_CLIENT_ID,
              'x-device-id': XUNLEI_DEVICE_ID,
            },
            body: JSON.stringify({
              client_id: XUNLEI_CLIENT_ID,
              action: 'get:/drive/v1/about',
              device_id: XUNLEI_DEVICE_ID,
              meta: {
                username: '',
                phone_number: '',
                email: '',
                package_name: 'pan.xunlei.com',
                client_version: '1.45.0',
                captcha_sign: '1.fe2108ad808a74c9ac0243309242726c',
                timestamp: '1645241033384',
                user_id: '0',
              },
            }),
          }).then(r => r.json()) as any
          captchaToken = captchaRes.captcha_token || ''
          log.info(`Xunlei login: captcha_token obtained (len=${captchaToken.length})`)
        } catch (err) {
          log.warn('Xunlei login: captcha init failed:', String(err))
        }

        // 获取用户昵称（使用 /v1/user/me 接口）
        let nickname = '迅雷用户'
        let userId = ''
        try {
          log.info(`Xunlei login: getting user info with accessToken (len=${finalAccessToken.length}), captchaToken (len=${captchaToken.length})...`)
          const userHeaders: Record<string, string> = {
            'User-Agent': XUNLEI_UA,
            'x-client-id': XUNLEI_CLIENT_ID,
            'x-device-id': XUNLEI_DEVICE_ID,
            'Authorization': `Bearer ${finalAccessToken}`,
          }
          if (captchaToken) userHeaders['x-captcha-token'] = captchaToken

          const userRes = await xunleiSession.fetch('https://xluser-ssl.xunlei.com/v1/user/me', {
            method: 'GET',
            headers: userHeaders,
          })
          const userText = await userRes.text()
          log.info(`Xunlei login: /v1/user/me response (status=${userRes.status}): ${userText.substring(0, 300)}`)

          try {
            const userData = JSON.parse(userText)
            if (userData.name) {
              nickname = userData.name
              log.info('Xunlei login: got nickname:', nickname)
            }
            if (userData.id || userData.user_id || userData.sub) {
              userId = userData.id || userData.user_id || userData.sub
              log.info('Xunlei login: got userId:', userId)
            }
          } catch (parseErr) {
            log.warn('Xunlei login: failed to parse user response')
          }
        } catch (err) {
          log.warn('Xunlei login: getUserInfo failed:', String(err))
        }

        resolved = true
        ipcMain.removeListener('__login_confirm', onConfirm)
        loginWindow.close()
        // 返回 accessToken 和 userId 供适配器缓存
        resolve({ success: true, refreshToken: finalRefreshToken, nickname, accessToken: finalAccessToken, userId })
      } catch (err) {
        log.error('Xunlei login confirm error:', String(err))
      }
    }

    ipcMain.on('__login_confirm', onConfirm)

    loginWindow.loadURL('https://pan.xunlei.com/')
    loginWindow.once('ready-to-show', () => {
      log.info('Xunlei login window: ready-to-show')
      loginWindow.show()
    })

    loginWindow.on('closed', () => {
      ipcMain.removeListener('__login_confirm', onConfirm)
      if (!resolved) {
        resolved = true
        resolve({ success: false, error: '登录窗口已关闭' })
      }
    })
  })
}
