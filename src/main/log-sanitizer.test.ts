import { describe, expect, it } from 'vitest'
import { REDACTED, createLogSanitizer, sanitizeLogText, sanitizeLogValue } from './log-sanitizer'

describe('log sanitizer', () => {
  it('redacts authorization, cookie, tokens, passwords and extraction codes in text', () => {
    const source = [
      'Authorization: Bearer bearer-secret',
      'Authorization: OSS access-key-id:signature-secret',
      'Cookie: BDUSS=cookie-secret; sid=other-secret',
      'access_token=access-secret refresh_token="refresh-secret"',
      'X-Captcha-Token: captcha-header-secret',
      'x-oss-security-token=oss-security-secret',
      'pass_code_token: restore-secret client_secret=client-secret',
      'password: p@ssword 提取码=1234',
    ].join('\n')
    const sanitized = sanitizeLogText(source)

    expect(sanitized).not.toMatch(/bearer-secret|signature-secret|cookie-secret|other-secret|access-secret|refresh-secret|captcha-header-secret|oss-security-secret|restore-secret|client-secret|p@ssword|1234/)
    expect(sanitized).toContain(`Authorization: ${REDACTED}`)
    expect(sanitized).toContain(`Cookie: ${REDACTED}`)
    expect(sanitized).toContain(`X-Captcha-Token: ${REDACTED}`)
  })

  it('redacts every URL query value while keeping the route and parameter names readable', () => {
    const sanitized = sanitizeLogText('GET https://api.example.test/files?page=2&access_token=secret#token=hash failed with 401')
    expect(sanitized).toContain('https://api.example.test/files?page=[REDACTED]&access_token=[REDACTED]#[REDACTED]')
    expect(sanitized).toContain('failed with 401')
    expect(sanitized).not.toContain('secret')
  })

  it('recursively sanitizes JSON objects without mutating the input', () => {
    const input = {
      request: { headers: { Authorization: 'Bearer abc', Cookie: 'sid=123', 'X-Captcha-Token': 'captcha-secret' } },
      response: { data: { access_token: 'token', profile: { password: 'pw', name: 'Alice' } } },
      upload: { access_key_id: 'key-id', access_key_secret: 'key-secret', security_token: 'security-secret' },
      restore: { pass_code_token: 'restore-secret' },
      share: { 提取码: '9999', url: 'https://example.test/s/abc?pwd=9999' },
    }
    const sanitized = sanitizeLogValue(input)

    expect(sanitized).toEqual({
      request: { headers: { Authorization: REDACTED, Cookie: REDACTED, 'X-Captcha-Token': REDACTED } },
      response: { data: { access_token: REDACTED, profile: { password: REDACTED, name: 'Alice' } } },
      upload: { access_key_id: REDACTED, access_key_secret: REDACTED, security_token: REDACTED },
      restore: { pass_code_token: REDACTED },
      share: { 提取码: REDACTED, url: 'https://example.test/s/abc?pwd=[REDACTED]' },
    })
    expect(input.request.headers.Authorization).toBe('Bearer abc')
  })

  it('keeps Error details useful while sanitizing message, stack, cause, and metadata', () => {
    const cause = new Error('refresh_token=refresh-value rejected')
    const error = new Error('Request https://api.test/me?token=abc returned 401') as Error & { context: unknown; cause?: unknown }
    error.cause = cause
    error.context = { accountId: 'a1', password: 'secret-password' }
    const sanitized = sanitizeLogValue(error)

    expect(sanitized).toBeInstanceOf(Error)
    expect(sanitized.message).toContain('returned 401')
    expect(sanitized.message).not.toContain('abc')
    expect((sanitized as Error & { context: unknown }).context).toEqual({ accountId: 'a1', password: REDACTED })
    expect(String((sanitized as Error & { cause?: unknown }).cause)).not.toContain('refresh-value')
  })

  it('handles JSON strings, circular references and electron-log transform messages', () => {
    const circular: Record<string, unknown> = { token: 'secret' }
    circular.self = circular
    expect(sanitizeLogValue(circular)).toEqual({ token: REDACTED, self: '[CIRCULAR]' })
    expect(sanitizeLogText('{"nested":{"password":"secret"},"status":401}')).toBe(`{"nested":{"password":"${REDACTED}"},"status":401}`)

    const transform = createLogSanitizer()
    expect(transform({ level: 'info', data: ['ok', { Cookie: 'secret' }] })).toEqual({
      level: 'info',
      data: ['ok', { Cookie: REDACTED }],
    })
  })

  it('sanitizes embedded Xunlei response payloads without hiding useful status fields', () => {
    const source = 'Xunlei response (status=200): {"captcha_token":"captcha-secret","accessToken":"access-secret","refreshToken":"refresh-secret","expires_in":3600}'
    const sanitized = sanitizeLogText(source)

    expect(sanitized).toContain('status=200')
    expect(sanitized).toContain('"expires_in":3600')
    expect(sanitized).not.toMatch(/captcha-secret|access-secret|refresh-secret/)
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(3)
  })
})
