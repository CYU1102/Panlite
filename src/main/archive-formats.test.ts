import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractArchive, listArchiveFiles } from './archive'

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
