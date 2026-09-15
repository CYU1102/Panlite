import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { describe, expect, it } from 'vitest'
import { getExternalHttpUrl, getRendererIndexPath, isTrustedRendererUrl } from './ipc-security'

describe('IPC renderer origin policy', () => {
  const rendererIndexPath = resolve('dist/renderer/index.html')
  const rendererIndexUrl = pathToFileURL(rendererIndexPath).toString()

  it('allows only the canonical production renderer file', () => {
    expect(isTrustedRendererUrl(pathToFileURL(getRendererIndexPath()).toString())).toBe(true)
    expect(isTrustedRendererUrl(rendererIndexUrl, undefined, rendererIndexPath)).toBe(true)
    expect(isTrustedRendererUrl(`${rendererIndexUrl}?source=test#/files`, undefined, rendererIndexPath)).toBe(true)
    expect(isTrustedRendererUrl(
      pathToFileURL(resolve('dist/renderer/other.html')).toString(),
      undefined,
      rendererIndexPath,
    )).toBe(false)
    expect(isTrustedRendererUrl(
      pathToFileURL(resolve('malicious.html')).toString(),
      undefined,
      rendererIndexPath,
    )).toBe(false)
    expect(isTrustedRendererUrl('file://remote-host/share/index.html', undefined, rendererIndexPath)).toBe(false)
  })

  it('requires the configured Vite origin in development', () => {
    expect(isTrustedRendererUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/src/main.ts', 'http://localhost:5173')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false)
    expect(isTrustedRendererUrl('http://example.test/', 'http://localhost:5173')).toBe(false)
    expect(isTrustedRendererUrl(rendererIndexUrl, 'http://localhost:5173', rendererIndexPath)).toBe(false)
  })

  it('rejects external, privileged, and malformed URLs', () => {
    expect(isTrustedRendererUrl('https://localhost:5173/', 'http://localhost:5173')).toBe(false)
    expect(isTrustedRendererUrl('javascript:alert(1)', 'http://localhost:5173')).toBe(false)
    expect(isTrustedRendererUrl('not a URL', 'http://localhost:5173')).toBe(false)
  })

  it('only returns HTTP(S) URLs for external navigation', () => {
    expect(getExternalHttpUrl('https://example.com/a?q=1')).toBe('https://example.com/a?q=1')
    expect(getExternalHttpUrl('http://example.com/')).toBe('http://example.com/')
    expect(getExternalHttpUrl('file:///tmp/secret.txt')).toBeNull()
    expect(getExternalHttpUrl('javascript:alert(1)')).toBeNull()
    expect(getExternalHttpUrl('not a URL')).toBeNull()
  })
})
