import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractArchive, listArchiveFiles, resolve7ZipExecutablePath } from './archive'

const { path7za } = require('7zip-bin')
const workDir = mkdtempSync(join(tmpdir(), 'panlite-archive-test-'))
const sourcePath = join(workDir, 'hello.txt')
const archivePath = join(workDir, 'sample.7z')

beforeAll(() => {
  writeFileSync(sourcePath, 'hello PanLite', 'utf8')
  execFileSync(path7za, ['a', archivePath, sourcePath], { cwd: workDir })
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
    expect(meta.files.some((file) => file.name === 'hello.txt')).toBe(true)

    const outputDir = join(workDir, 'output')
    await extractArchive(archivePath, outputDir)
    const extractedPath = join(outputDir, 'hello.txt')
    expect(existsSync(extractedPath)).toBe(true)
    expect(readFileSync(extractedPath, 'utf8')).toBe('hello PanLite')
  })
})
