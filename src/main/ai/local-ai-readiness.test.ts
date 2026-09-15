import { EventEmitter } from 'node:events'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ config: {} as Record<string, string>, files: new Set<string>(), languages: 'eng\nchi_sim\n', failed: new Set<string>() }))
vi.mock('../db', () => ({ getSetting: () => ({ value: JSON.stringify(fixture.config) }), setSetting: vi.fn() }))
vi.mock('node:fs', () => ({ default: {
  existsSync: (file: string) => fixture.files.has(file),
  statSync: (file: string) => { if (!fixture.files.has(file)) throw new Error('missing'); return { isFile: () => true, size: 100 } },
} }))
vi.mock('node:child_process', () => ({ spawn: (executable: string, args: string[]) => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(args[0] === '--list-langs' ? fixture.languages : 'tool version 1.0'))
    child.emit('close', fixture.failed.has(executable) ? 1 : 0)
  })
  return child
} }))

import { listAiLocalToolStatuses, ocrPdfLocally } from './local-ai-tools'
const executable = (name: string) => path.resolve('tool-fixtures', process.platform === 'win32' ? `${name}.exe` : name)
beforeEach(() => {
  fixture.config = { ocrLanguage: 'chi_sim+eng', whisperModel: 'small' }
  fixture.files.clear()
  fixture.failed.clear()
  fixture.languages = 'List of available languages (2):\neng\nchi_sim\n'
})
function install(field: string, name: string) {
  const file = executable(name)
  fixture.config[field] = file
  fixture.files.add(file)
  return file
}

describe('local capability dependency detection', () => {
  it('reports no optional tools as ready when none is installed', async () => {
    expect((await listAiLocalToolStatuses()).every(tool => !tool.available && !tool.ready)).toBe(true)
  })
  it('checks the selected OCR languages, not just the Tesseract executable', async () => {
    install('tesseractPath', 'tesseract')
    fixture.languages = 'eng\n'
    let tool = (await listAiLocalToolStatuses()).find(tool => tool.key === 'tesseract')!
    expect(tool.available).toBe(true)
    expect(tool.ready).toBe(false)
    expect(tool.message).toContain('chi_sim')
    fixture.languages = 'chi_sim\neng\n'
    tool = (await listAiLocalToolStatuses()).find(tool => tool.key === 'tesseract')!
    expect(tool.ready).toBe(true)
  })
  it('requires both Poppler and the configured Tesseract languages for local scanned PDF readiness', async () => {
    install('pdftoppmPath', 'pdftoppm')
    let pdf = (await listAiLocalToolStatuses()).find(tool => tool.key === 'pdftoppm')!
    expect(pdf.available).toBe(true)
    expect(pdf.ready).toBe(false)
    await expect(ocrPdfLocally('unused.pdf', undefined, [1])).resolves.toBeNull()
    install('tesseractPath', 'tesseract')
    fixture.languages = 'eng\n'
    expect((await listAiLocalToolStatuses()).find(tool => tool.key === 'pdftoppm')?.ready).toBe(false)
    await expect(ocrPdfLocally('unused.pdf', undefined, [1])).rejects.toThrow('chi_sim')
    fixture.languages = 'chi_sim\neng\n'
    pdf = (await listAiLocalToolStatuses()).find(tool => tool.key === 'pdftoppm')!
    expect(pdf.ready).toBe(true)
  })

  it('does not claim OCR readiness for empty language tokens or orientation-only configuration', async () => {
    install('tesseractPath', 'tesseract')
    install('pdftoppmPath', 'pdftoppm')
    for (const language of ['+++', 'osd']) {
      fixture.config.ocrLanguage = language
      const statuses = await listAiLocalToolStatuses()
      expect(statuses.find(tool => tool.key === 'tesseract')?.ready).toBe(false)
      expect(statuses.find(tool => tool.key === 'pdftoppm')?.ready).toBe(false)
    }
  })
  it('keeps audio extraction available without claiming embedded subtitles work without FFprobe', async () => {
    install('ffmpegPath', 'ffmpeg')
    const tool = (await listAiLocalToolStatuses()).find(tool => tool.key === 'ffmpeg')!
    expect(tool.ready).toBe(true)
    expect(tool.subtitleAvailable).toBe(false)
    fixture.files.add(executable('ffprobe'))
    expect((await listAiLocalToolStatuses()).find(tool => tool.key === 'ffmpeg')?.subtitleAvailable).toBe(true)
  })
  it('requires a model file and working FFmpeg for whisper.cpp', async () => {
    install('whisperPath', 'whisper-cli')
    let tool = (await listAiLocalToolStatuses()).find(tool => tool.key === 'whisper')!
    expect(tool.available).toBe(true)
    expect(tool.ready).toBe(false)
    expect(tool.message).toContain('模型文件')
    fixture.config.whisperModelPath = path.resolve('tool-fixtures', 'ggml-small.bin')
    fixture.files.add(fixture.config.whisperModelPath)
    const ffmpeg = install('ffmpegPath', 'ffmpeg')
    expect((await listAiLocalToolStatuses()).find(tool => tool.key === 'whisper')?.ready).toBe(true)
    fixture.failed.add(ffmpeg)
    tool = (await listAiLocalToolStatuses()).find(tool => tool.key === 'whisper')!
    expect(tool.ready).toBe(false)
    expect(tool.message).toContain('FFmpeg')
  })
})
