import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ config: {} as Record<string, string>, onSpawn: undefined as undefined | ((child: any, args: string[]) => void), spawn: vi.fn(), killedWhileDirectoryExists: false }))
vi.mock('../db', () => ({ getSetting: () => ({ value: JSON.stringify(fixture.config) }), setSetting: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: (...input: unknown[]) => fixture.spawn(...input) }))
import { ocrPdfLocally, transcribeMediaLocally } from './local-ai-tools'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-local-command-'))
  fixture.config = { pdftoppmPath: path.join(root, 'pdftoppm.exe'), tesseractPath: path.join(root, 'tesseract.exe'), ocrLanguage: 'eng' }
  for (const name of ['pdftoppm.exe', 'tesseract.exe', 'fixture.pdf']) fs.writeFileSync(path.join(root, name), 'fixture')
  fixture.killedWhileDirectoryExists = false
  fixture.spawn.mockReset()
  fixture.spawn.mockImplementation((_executable: string, args: string[], options: unknown) => {
    expect(options).toMatchObject({ shell: false, windowsHide: true })
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => {
      if (args[0] === '-f') fixture.killedWhileDirectoryExists = fs.existsSync(path.dirname(args[args.length - 1]))
      queueMicrotask(() => child.emit('close', null))
      return true
    }) })
    queueMicrotask(() => {
      if (args[0] === '--list-langs') { child.stdout.emit('data', Buffer.from('eng\n')); child.emit('close', 0) }
      else fixture.onSpawn?.(child, args)
    })
    return child
  })
})
afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }) })

describe('local subprocess cancellation and limits', () => {
  it.each(['whisper-cli.exe', 'whisper.exe'])('preserves real segment timestamps from %s and cleans its temporary output', async executable => {
    fixture.config.ffmpegPath = path.join(root, 'ffmpeg.exe')
    fixture.config.whisperPath = path.join(root, executable)
    fixture.config.whisperModelPath = path.join(root, 'model.bin')
    for (const file of [fixture.config.ffmpegPath, fixture.config.whisperPath, fixture.config.whisperModelPath]) fs.writeFileSync(file, 'fixture')
    const subtitle = '1\n00:00:12,500 --> 00:00:15,000\nCited speech'
    let directory = ''
    fixture.onSpawn = (child, args) => {
      if (args[0] === '-y') fs.writeFileSync(args[args.length - 1], 'wav')
      else if (args.includes('-of')) {
        expect(args).toContain('-osrt')
        const base = args[args.indexOf('-of') + 1]
        directory = path.dirname(base)
        fs.writeFileSync(`${base}.srt`, subtitle)
      } else {
        expect(args[args.indexOf('--output_format') + 1]).toBe('srt')
        directory = args[args.indexOf('--output_dir') + 1]
        fs.writeFileSync(path.join(directory, 'audio.srt'), subtitle)
      }
      child.emit('close', 0)
    }
    expect(await transcribeMediaLocally(path.join(root, 'fixture.pdf'))).toBe(subtitle)
    expect(fixture.spawn).toHaveBeenCalledTimes(2)
    expect(directory).not.toBe('')
    expect(fs.existsSync(directory)).toBe(false)
  })

  it('does not spawn a subprocess for an already cancelled request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(ocrPdfLocally(path.join(root, 'fixture.pdf'), controller.signal, [1])).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('waits for process close before deleting its workspace on cancellation', async () => {
    const controller = new AbortController()
    let directory = ''
    fixture.onSpawn = (_child, args) => { directory = path.dirname(args[args.length - 1]); controller.abort() }
    await expect(ocrPdfLocally(path.join(root, 'fixture.pdf'), controller.signal, [1])).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.killedWhileDirectoryExists).toBe(true)
    expect(fs.existsSync(directory)).toBe(false)
  })

  it('kills a stalled renderer at its step deadline and then cleans output', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let directory = ''
    fixture.onSpawn = (_child, args) => { directory = path.dirname(args[args.length - 1]) }
    const pending = ocrPdfLocally(path.join(root, 'fixture.pdf'), undefined, [1])
    await vi.advanceTimersByTimeAsync(45_000)
    expect((await pending)?.[0].warnings?.join()).toContain('执行超时')
    expect(fixture.killedWhileDirectoryExists).toBe(true)
    expect(fs.existsSync(directory)).toBe(false)
  })
})
