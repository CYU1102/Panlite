import { describe, expect, it } from 'vitest'
import { getSetCookieHeaders, mergeSetCookieHeaders } from './baidu-cookie'

describe('baidu cookie rotation', () => {
  it('merges rotated cookies without losing existing credentials', () => {
    expect(mergeSetCookieHeaders('BDUSS=old; STOKEN=stable', [
      'BDCLND=fresh; Path=/; HttpOnly',
      'BDUSS=new; Path=/; Secure',
    ])).toBe('BDUSS=new; STOKEN=stable; BDCLND=fresh')
  })

  it('removes cookies explicitly deleted by the server', () => {
    expect(mergeSetCookieHeaders('BDUSS=old; BDCLND=old', ['BDCLND=deleted; Max-Age=0']))
      .toBe('BDUSS=old')
  })

  it('removes cookies expired with an empty value and an old expiry date', () => {
    expect(mergeSetCookieHeaders('BDUSS=old; BDCLND=old', [
      'BDCLND=; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ])).toBe('BDUSS=old')
  })

  it('reads set-cookie headers case-insensitively', () => {
    expect(getSetCookieHeaders({ 'Set-Cookie': ['A=1', 'B=2'] })).toEqual(['A=1', 'B=2'])
  })
})
