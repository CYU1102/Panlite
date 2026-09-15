import { describe, expect, it } from 'vitest'
import { QuarkCookieStore } from './quark-cookie'

const url = 'https://drive-pc.quark.cn/1/clouddrive/file/download'
const account = (id = 'a', cookies = 'sid=fixture; __puus=old') => ({ id, credential: { cookies } })
const headers = (value: string) => new Headers({ 'Set-Cookie': value })
const refresh = (value: string) => headers(`__puus=${value}; Domain=quark.cn; Path=/; Max-Age=86400`)

describe('isolated Quark response cookies', () => {
  it('uses API refresh for later calls without mutating persisted account credentials', () => {
    const store = new QuarkCookieStore(), a = account()
    expect(store.receive(store.begin(a), refresh('fresh'), url)).toBe('sid=fixture; __puus=fresh')
    expect(store.begin(a).cookie).toBe('sid=fixture; __puus=fresh')
    expect(a.credential.cookies).toBe('sid=fixture; __puus=old')
    expect(store.begin(account('b')).cookie).toBe('sid=fixture; __puus=old')
  })

  it('discards old credential generations and their late responses', () => {
    const store = new QuarkCookieStore(), a = account()
    const old = store.begin(a)
    store.receive(old, refresh('old-refresh'), url)
    a.credential.cookies = 'sid=relogin; __puus=new-login'
    expect(store.begin(a).cookie).toBe(a.credential.cookies)
    store.receive(old, refresh('late-old-refresh'), url)
    expect(store.begin(a).cookie).toBe(a.credential.cookies)
    a.credential.cookies = 'sid=fixture; __puus=old'
    expect(store.begin(a).cookie).toBe(a.credential.cookies)
  })

  it('binds concurrent results to their own refresh and does not roll later state back', () => {
    const store = new QuarkCookieStore(), a = account()
    const first = store.begin(a), second = store.begin(a), noHeader = store.begin(a)
    expect(store.receive(second, refresh('second'), url)).toContain('__puus=second')
    expect(store.receive(first, refresh('first'), url)).toContain('__puus=first')
    store.receive(noHeader, undefined, url)
    expect(store.begin(a).cookie).toContain('__puus=second')
  })

  it('preserves exact no-header credentials and safely parses a combined Expires header', () => {
    const store = new QuarkCookieStore(), a = account('a', 'sid=fixture;  __puus=old')
    expect(store.receive(store.begin(a), undefined, url)).toBe(a.credential.cookies)
    const combined = { get: () => 'unrelated=ignored; Expires=Wed, 09 Sep 2037 12:00:00 GMT, __puus=fresh==; Domain=.quark.cn; Path=/' } as unknown as Headers
    expect(store.receive(store.begin(a), combined, url)).toBe('sid=fixture; __puus=fresh==')
  })

  it.each([
    [url, '__puus=bad; Domain=evil.test; Path=/'],
    [url, '__puus=host-only; Path=/'],
    [url, '__puus=host-scoped; Domain=drive-pc.quark.cn; Path=/'],
    [url, '__puus=bad; Domain=quark.cn; Path=/private'],
    [url, '__puus=implicit-directory; Domain=quark.cn'],
    [url, '__puus=empty-path; Domain=quark.cn; Path='],
    [url, '__puus=invalid-path; Domain=quark.cn; Path=relative'],
    [url, 'sid=overwritten; Domain=quark.cn; Path=/'],
    ['https://quark.cn.evil.test/api', '__puus=bad; Domain=quark.cn; Path=/'],
    ['http://drive-pc.quark.cn/api', '__puus=bad; Domain=quark.cn; Path=/'],
  ])('rejects an unrelated cookie or untrusted scope (%s, %s)', (responseUrl, cookie) => {
    const store = new QuarkCookieStore(), a = account()
    expect(store.receive(store.begin(a), headers(cookie), responseUrl)).toBe(a.credential.cookies)
    expect(store.begin(a).cookie).toBe(a.credential.cookies)
  })

  it('accepts an explicit shared domain when the response URL gives a root default path', () => {
    const store = new QuarkCookieStore(), a = account()
    expect(store.receive(store.begin(a), headers('__puus=root-default; Domain=quark.cn'), 'https://drive-pc.quark.cn/api'))
      .toBe('sid=fixture; __puus=root-default')
  })

  it('honors explicit expiration and bounds the memory cache', () => {
    const store = new QuarkCookieStore(), a = account()
    expect(store.receive(store.begin(a), headers('__puus=deleted; Domain=quark.cn; Path=/; Max-Age=0'), url)).toBe('sid=fixture')
    for (let index = 0; index < 128; index++) store.begin(account(`other-${index}`))
    expect(store.begin(a).cookie).toBe(a.credential.cookies)
  })
})
