import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractArchive, listArchiveFiles } from '../archive'
import { parseAiDocument } from './document-parser'

// RAR listing, extraction and document parsing are real implementations.
// Prevent accidental external-model or optional executable fallback in this offline test.
vi.mock('./local-ai-tools', () => ({
  convertLegacyOfficeLocally: vi.fn(() => { throw new Error('Unexpected Office fallback') }),
  extractEmbeddedSubtitle: vi.fn(() => { throw new Error('Unexpected subtitle fallback') }),
  ocrImageLocally: vi.fn(() => { throw new Error('Unexpected OCR fallback') }),
  transcribeMediaLocally: vi.fn(() => { throw new Error('Unexpected transcription fallback') }),
}))
vi.mock('./ai-provider', () => ({
  getAiProviderConfig: vi.fn(() => { throw new Error('Unexpected provider access') }),
  extractTextFromVisualFile: vi.fn(() => { throw new Error('Unexpected remote OCR') }),
  transcribeMediaFile: vi.fn(() => { throw new Error('Unexpected remote transcription') }),
}))

const fixtureDir = join(__dirname, 'test-fixtures', 'node-unrar')
const fixture = join(fixtureDir, 'FolderTest.rar')
const encryptedFixture = join(fixtureDir, 'HeaderEnc1234.rar')
const tempDirs: string[] = []
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function expectedLongText(): string {
  let expected = ''
  for (let zeros = 0; expected.length < 1024 * 1024; zeros++) expected += `1${'0'.repeat(zeros)}`
  return expected
}

describe('official RAR fixtures: real archive and AI parser integration', () => {
  it('verifies the vendored upstream fixture integrity and lists Unicode paths accurately', async () => {
    expect(createHash('sha256').update(readFileSync(fixture)).digest('hex')).toBe('aa9c77fd07e992cf3ef2f464382353841747532cfa03726bfcde0ff3884013ff')
    expect(createHash('sha256').update(readFileSync(encryptedFixture)).digest('hex')).toBe('e481752a64e68afc6d5d67710493faf1a36cc1fb2e24eb286ba1d790013ef45c')
    const meta = await listArchiveFiles(fixture)
    expect(meta.format).toBe('rar')
    expect(meta.isEncrypted).toBe(false)
    expect(meta.files.filter(file => !file.isDir).map(file => ({ path: file.path.replace(/\\/g, '/'), size: file.size }))).toEqual([
      { path: 'Folder1/Folder Space/long.txt', size: 1049076 },
      { path: 'Folder1/Folder 中文/2中文.txt', size: 15 },
    ])
    expect(meta.files.filter(file => file.isDir)).toHaveLength(3)
  })

  it('extracts original bytes including BOM, Chinese text, spaces and the entire long payload', async () => {
    const output = mkdtempSync(join(tmpdir(), 'panlite-real-rar-'))
    tempDirs.push(output)
    await extractArchive(fixture, output)
    expect(readFileSync(join(output, 'Folder1', 'Folder Space', 'long.txt'), 'utf8')).toBe(expectedLongText())
    expect(readFileSync(join(output, 'Folder1', 'Folder 中文', '2中文.txt'))).toEqual(Buffer.from('\uFEFF中文中文', 'utf8'))
  })

  it('indexes both real RAR text members without altering their text or losing provenance', async () => {
    const parsed = await parseAiDocument(fixture, 'rar')
    expect(parsed.status).toBe('ready')
    expect(parsed.partial).not.toBe(true)
    expect(parsed.sections).toHaveLength(2)
    const chinese = parsed.sections!.find(section => section.section?.includes('2中文.txt'))!
    const long = parsed.sections!.find(section => section.section?.includes('long.txt'))!
    expect(chinese.content).toBe('中文中文')
    expect(chinese.section?.replace(/\\/g, '/')).toContain('Folder1/Folder 中文/2中文.txt')
    expect(long.content).toBe(expectedLongText())
    expect(long.section?.replace(/\\/g, '/')).toContain('Folder1/Folder Space/long.txt')
  })

  it('does not claim successful AI parsing when the RAR headers require a password', async () => {
    await expect(listArchiveFiles(encryptedFixture)).rejects.toThrow()
    const parsed = await parseAiDocument(encryptedFixture, 'rar')
    expect(parsed.status).toBe('failed')
    expect(parsed.sections?.length || 0).toBe(0)
    expect(parsed.message).toBeTruthy()
  })
})
