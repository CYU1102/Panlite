import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertPathInside,
  createFilePreviewIpcHandlers,
  detectFilePreviewType,
  FilePreviewService,
  readTextPreview,
  type FilePreviewDownloadContext,
  type FilePreviewRequest,
} from './file-preview'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'panlite-preview-test-'))
  roots.push(root)
  return root
}

const request: FilePreviewRequest = {
  accountId: 'account-1',
  fileId: 'file-1',
  fileName: 'notes.txt',
  fileSize: 12,
}

describe('preview type detection', () => {
  it.each([
    ['photo.JPEG', 'image'],
    ['movie.mp4', 'video'],
    ['sound.flac', 'audio'],
    ['manual.pdf', 'pdf'],
    ['README.md', 'markdown'],
    ['config.json', 'text'],
    ['backup.tar.gz', 'archive'],
    ['backup.7z', 'archive'],
  ] as const)('detects %s as %s', (fileName, kind) => {
    expect(detectFilePreviewType(fileName).kind).toBe(kind)
  })

  it('does not embed active SVG content as an image', () => {
    expect(detectFilePreviewType('untrusted.svg')).toMatchObject({ kind: 'text', mimeType: 'text/plain; charset=utf-8' })
  })

  it('identifies unsupported archives without claiming the archive engine can open them', () => {
    expect(detectFilePreviewType('disk.iso')).toMatchObject({ kind: 'archive', supported: false })
  })
})

describe('path and text safety', () => {
  it('accepts descendants and rejects root or traversal paths', () => {
    const root = path.join(temporaryRoot(), 'root')
    expect(assertPathInside(root, path.join(root, 'session', 'file.txt'))).toContain('file.txt')
    expect(() => assertPathInside(root, root)).toThrow(/越界/)
    expect(() => assertPathInside(root, path.join(root, '..', 'outside.txt'))).toThrow(/越界/)
  })

  it('reads only the configured amount and reports truncation', () => {
    const filePath = path.join(temporaryRoot(), 'large.txt')
    writeFileSync(filePath, 'abcdefghijklmnop')
    expect(readTextPreview(filePath, 5)).toEqual({ content: 'abcde', truncated: true })
  })

  it('decodes UTF-16LE text and rejects binary-looking content', () => {
    const root = temporaryRoot()
    const utf16Path = path.join(root, 'utf16.txt')
    writeFileSync(utf16Path, Buffer.from([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59]))
    expect(readTextPreview(utf16Path, 100).content).toBe('你好')

    const binaryPath = path.join(root, 'binary.txt')
    writeFileSync(binaryPath, Buffer.from([0, 0, 0, 1, 2, 3]))
    expect(() => readTextPreview(binaryPath, 100)).toThrow(/不是可安全预览的文本/)
  })
})

describe('preview sessions', () => {
  it('creates a capped text session and removes it on cleanup', async () => {
    const service = new FilePreviewService({ tempRoot: temporaryRoot(), maxTextBytes: 5 })
    let downloadedPath = ''
    const preview = await service.createSession(request, async (_source, context) => {
      downloadedPath = path.join(context.directory, context.fileName)
      writeFileSync(downloadedPath, 'hello world')
      return { success: true, localPath: downloadedPath }
    })

    expect(preview).toMatchObject({ kind: 'text', content: 'hello', truncated: true })
    expect(service.getSessionFilePath(preview.sessionId)).toBe(downloadedPath)
    expect(service.cleanupSession(preview.sessionId)).toBe(true)
    expect(existsSync(downloadedPath)).toBe(false)
    expect(() => service.getSessionFilePath(preview.sessionId)).toThrow(/不存在或已过期/)
  })

  it('rejects a downloader path outside its session without deleting that file', async () => {
    const root = temporaryRoot()
    const outsidePath = path.join(root, 'outside.txt')
    writeFileSync(outsidePath, 'keep me')
    const service = new FilePreviewService({ tempRoot: path.join(root, 'sessions') })

    await expect(service.createSession(request, async () => ({ success: true, localPath: outsidePath }))).rejects.toThrow(/越界/)
    expect(readFileSync(outsidePath, 'utf8')).toBe('keep me')
  })

  it('rejects a linked directory that resolves outside the session', async () => {
    const root = temporaryRoot()
    const outsideDirectory = path.join(root, 'outside')
    mkdirSync(outsideDirectory)
    const outsidePath = path.join(outsideDirectory, 'outside.txt')
    writeFileSync(outsidePath, 'secret')
    const service = new FilePreviewService({ tempRoot: path.join(root, 'sessions') })

    const action = service.createSession(request, async (_source, context) => {
      const linkedDirectory = path.join(context.directory, 'linked')
      symlinkSync(outsideDirectory, linkedDirectory, 'junction')
      return { success: true, localPath: path.join(linkedDirectory, 'outside.txt') }
    })
    await expect(action).rejects.toThrow(/越界/)
  })

  it('enforces declared and downloaded size limits', async () => {
    const root = temporaryRoot()
    const service = new FilePreviewService({ tempRoot: root, maxDownloadBytes: 4 })
    const downloader = async (_source: FilePreviewRequest, context: FilePreviewDownloadContext) => {
      const localPath = path.join(context.directory, context.fileName)
      writeFileSync(localPath, '12345')
      return { success: true, localPath }
    }

    await expect(service.createSession({ ...request, fileSize: 5 }, downloader)).rejects.toThrow(/超过预览下载大小限制/)
    await expect(service.createSession({ ...request, fileSize: 4 }, downloader)).rejects.toThrow(/下载文件超过预览大小限制/)
  })

  it('expires sessions and cleans their directories', async () => {
    let now = 100
    const service = new FilePreviewService({ tempRoot: temporaryRoot(), sessionTtlMs: 10, now: () => now })
    let downloadedPath = ''
    const preview = await service.createSession(request, async (_source, context) => {
      downloadedPath = path.join(context.directory, context.fileName)
      writeFileSync(downloadedPath, 'content')
      return { success: true, localPath: downloadedPath }
    })
    now = 111

    expect(service.cleanupExpiredSessions()).toBe(1)
    expect(service.getSession(preview.sessionId)).toBeUndefined()
    expect(existsSync(downloadedPath)).toBe(false)
  })

  it('wraps errors for direct IPC wiring', async () => {
    const service = new FilePreviewService({ tempRoot: temporaryRoot() })
    const handlers = createFilePreviewIpcHandlers(service, async () => ({ success: false, error: 'network failed' }))
    await expect(handlers.create(request)).resolves.toEqual({ success: false, error: 'network failed' })
    expect(handlers.cleanup('missing')).toEqual({ success: true, cleaned: false })
  })
})
