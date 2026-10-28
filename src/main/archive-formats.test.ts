import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractArchive, listArchiveFiles, resolve7ZipExecutablePath } from './archive'

const { path7za } = require('7zip-bin')
const workDir = mkdtempSync(join(tmpdir(), 'panlite-archive-test-'))
const sourcePath = join(workDir, 'hello.txt')
const archivePath = join(workDir, 'sample.7z')
const unicodeDir = join(workDir, '目录')
const encryptedPath = join(workDir, 'encrypted.7z')
const encryptedHeadersPath = join(workDir, 'encrypted-headers.7z')

beforeAll(() => {
  writeFileSync(sourcePath, 'hello PanLite', 'utf8')
  execFileSync(path7za, ['a', archivePath, sourcePath], { cwd: workDir })
  mkdirSync(unicodeDir)
  writeFileSync(join(unicodeDir, '中文 文件.txt'), '加密样本', 'utf8')
  execFileSync(path7za, ['a', encryptedPath, '目录', '-p1234'], { cwd: workDir, windowsHide: true })
  execFileSync(path7za, ['a', encryptedHeadersPath, '目录', '-p1234', '-mhe=on'], { cwd: workDir, windowsHide: true })
})

afterAll(() => rmSync(workDir, { recursive: true, force: true }))

describe('7z runtime integration', () => {
  it('resolves only packaged 7zip executables outside app.asar and preserves development paths', () => {
    expect(resolve7ZipExecutablePath('C:\\PanLite\\resources\\app.asar\\node_modules\\7zip-bin\\win\\x64\\7za.exe'))
      .toBe('C:\\PanLite\\resources\\app.asar.unpacked\\node_modules\\7zip-bin\\win\\x64\\7za.exe')
    expect(resolve7ZipExecutablePath('/apps/PanLite/resources/app.asar/node_modules/7zip-bin/linux/x64/7za'))
      .toBe('/apps/PanLite/resources/app.asar.unpacked/node_modules/7zip-bin/linux/x64/7za')
    for (const original of [path7za, '7za', '/dev/node_modules/7zip-bin/win/x64/7za.exe', '/apps/app.asar.unpacked/node_modules/7zip-bin/win/x64/7za.exe', '/dev/app.asar/my-files/7za.exe']) {
      expect(resolve7ZipExecutablePath(original)).toBe(original)
    }
  })
  it('lists and extracts a 7z archive with the packaged runtime API', async () => {
    const meta = await listArchiveFiles(archivePath)
    expect(meta.isEncrypted).toBe(false)
    expect(meta.files.some((file) => file.name === 'hello.txt')).toBe(true)

    const outputDir = join(workDir, 'output')
    await extractArchive(archivePath, outputDir)
    const extractedPath = join(outputDir, 'hello.txt')
    expect(existsSync(extractedPath)).toBe(true)
    expect(readFileSync(extractedPath, 'utf8')).toBe('hello PanLite')
  })

  it('detects encrypted contents and preserves Unicode paths and sizes', async () => {
    const meta = await listArchiveFiles(encryptedPath)
    expect(meta.isEncrypted).toBe(true)
    expect(meta.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '目录', isDir: true }),
      expect.objectContaining({ path: '目录/中文 文件.txt', isDir: false, size: Buffer.byteLength('加密样本') }),
    ]))
    await expect(extractArchive(encryptedPath, join(workDir, 'missing-password-output'))).rejects.toThrow(/解压7z/)
    const output = join(workDir, 'encrypted-output')
    await extractArchive(encryptedPath, output, '1234')
    expect(readFileSync(join(output, '目录', '中文 文件.txt'), 'utf8')).toBe('加密样本')
  })

  it('rejects missing or incorrect header passwords without an interactive prompt and accepts the correct one', async () => {
    await expect(listArchiveFiles(encryptedHeadersPath)).rejects.toThrow(/无法读取7z/)
    await expect(listArchiveFiles(encryptedHeadersPath, 'wrong')).rejects.toThrow(/无法读取7z/)
    const meta = await listArchiveFiles(encryptedHeadersPath, '1234')
    expect(meta.isEncrypted).toBe(true)
    expect(meta.files.some(file => file.path === '目录/中文 文件.txt')).toBe(true)
    const output = join(workDir, 'encrypted-header-output')
    await extractArchive(encryptedHeadersPath, output, '1234')
    expect(readFileSync(join(output, '目录', '中文 文件.txt'), 'utf8')).toBe('加密样本')
  }, 15000)
})
