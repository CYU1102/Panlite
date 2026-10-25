import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArchive, extractArchive, listArchiveFiles } from './archive'

// Keep the real filesystem, but route ESM imports through the live functions so
// each test can observe and delay the underlying descriptors deterministically.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('fs')
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => require('node:fs').createReadStream(...args),
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => require('node:fs').createWriteStream(...args),
  }
})

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'panlite-zip-')) })
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function trackReaders(onRead?: () => void) {
  const fs = require('node:fs') as typeof import('node:fs')
  const readers: import('node:fs').ReadStream[] = []
  // Include unzipper/archiver's graceful-fs readers as well as our owned readers.
  for (const implementation of new Set([fs, require('graceful-fs') as typeof fs])) {
    const original = implementation.createReadStream
    vi.spyOn(implementation, 'createReadStream').mockImplementation((path, options) => {
      const reader = original(path, {
        ...(typeof options === 'string' ? { encoding: options } : options),
        fs: {
          open: fs.open,
          read: fs.read,
          // Keep the real descriptor open until close completes, making the race deterministic.
          close: (fd, callback) => { setTimeout(() => fs.close(fd, callback), 20) },
        },
      })
      readers.push(reader)
      if (onRead) reader.once('data', onRead)
      return reader
    })
  }
  return readers
}

describe('archive local filesystem workflows', () => {
  it('excludes its output and temporary directory when creating ZIP inside the source directory', async () => {
    writeFileSync(join(root, 'input.txt'), 'input')
    const output = join(root, 'inside.zip')
    await createArchive(root, output)
    expect((await listArchiveFiles(output)).files.map(file => file.path)).toEqual(['input.txt'])
    expect(readdirSync(root).sort()).toEqual(['input.txt', 'inside.zip'])
  })

  it.each(['zip', 'tar'])('round trips nested UTF-8 files and reports their actual size (%s)', async format => {
    const source = join(root, 'source')
    mkdirSync(join(source, 'nested'), { recursive: true })
    const content = '中文归档内容'
    writeFileSync(join(source, 'nested', '文档.txt'), content)
    const archive = join(root, `result.${format}`)
    await createArchive(source, archive, format, [{ relativePath: 'nested/文档.txt', fullPath: join(source, 'nested', '文档.txt') }])
    const meta = await listArchiveFiles(archive)
    expect(meta.files.find(file => file.path === 'nested/文档.txt')?.size).toBe(Buffer.byteLength(content))
    expect(meta.totalSize).toBe(Buffer.byteLength(content))
    const output = join(root, 'output')
    await extractArchive(archive, output)
    expect(readFileSync(join(output, 'nested', '文档.txt'), 'utf8')).toBe(content)
  })

  it('rejects missing ZIP inputs without an uncaught event or replacing the existing archive', async () => {
    const output = join(root, 'existing.zip')
    writeFileSync(output, 'existing')
    await expect(createArchive(root, output, 'zip', [{ relativePath: 'missing.txt', fullPath: join(root, 'missing.txt') }]))
      .rejects.toThrow('创建ZIP文件失败')
    expect(readFileSync(output, 'utf8')).toBe('existing')
    expect(readdirSync(root)).toEqual(['existing.zip'])
  })

  it('settles and removes temporary files when cancelled while ZIP entries are being written', async () => {
    const files = Array.from({ length: 8 }, (_, index) => {
      const relativePath = `${index}.txt`
      const fullPath = join(root, relativePath)
      writeFileSync(fullPath, Buffer.alloc(100_000, index))
      return { relativePath, fullPath }
    })
    const controller = new AbortController()
    await expect(createArchive(root, join(root, 'cancel.zip'), 'zip', files, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })).rejects.toThrow('创建ZIP文件失败')
    expect(readdirSync(root).sort()).toEqual(files.map(file => file.relativePath).sort())
  })

  it('closes ZIP metadata readers before returning the file list', async () => {
    writeFileSync(join(root, 'input.txt'), 'input')
    const output = join(root, 'result.zip')
    await createArchive(root, output)
    const readers = trackReaders()
    expect((await listArchiveFiles(output)).files.map(file => file.path)).toEqual(['input.txt'])
    expect(readers.length).toBeGreaterThan(0)
    expect(readers.every(reader => reader.closed)).toBe(true)
  })

  it('closes an active ZIP input before rejecting cancellation and never opens queued inputs', async () => {
    const files = Array.from({ length: 3 }, (_, index) => {
      const relativePath = `${index}.bin`
      const fullPath = join(root, relativePath)
      writeFileSync(fullPath, Buffer.alloc(1_000_000, index))
      return { relativePath, fullPath }
    })
    const controller = new AbortController()
    const readers = trackReaders(() => controller.abort())
    await expect(createArchive(root, join(root, 'cancel.zip'), 'zip', files, { signal: controller.signal }))
      .rejects.toThrow('创建ZIP文件失败')
    expect(readers).toHaveLength(1)
    expect(readers[0].closed).toBe(true)
    expect(readdirSync(root).sort()).toEqual(files.map(file => file.relativePath).sort())
  })

  it('closes ZIP source readers when extraction is cancelled', async () => {
    writeFileSync(join(root, 'input.txt'), 'input')
    const archive = join(root, 'result.zip')
    await createArchive(root, archive)
    const controller = new AbortController()
    const readers = trackReaders()
    // Abort after metadata has been read, as the first output file is written.
    const fs = require('node:fs') as typeof import('node:fs')
    const createOutput = fs.createWriteStream
    vi.spyOn(fs, 'createWriteStream').mockImplementation((path, options) => {
      const output = createOutput(path, options)
      output.once('open', () => controller.abort())
      return output
    })
    await expect(extractArchive(archive, join(root, 'output'), undefined, undefined, { signal: controller.signal }))
      .rejects.toThrow('解压ZIP文件失败')
    expect(readers.length).toBeGreaterThan(0)
    expect(readers.every(reader => reader.closed)).toBe(true)
  })

  it('preserves empty directories when creating ZIP from a directory', async () => {
    const source = join(root, 'source')
    mkdirSync(join(source, 'empty'), { recursive: true })
    const output = join(root, 'empty.zip')
    await createArchive(source, output)
    expect((await listArchiveFiles(output)).files.map(file => [file.path, file.isDir])).toEqual([['empty/', true]])
  })
})
