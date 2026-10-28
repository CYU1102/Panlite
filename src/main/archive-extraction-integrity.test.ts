import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createArchive, extractArchive } from './archive'

const { path7za } = require('7zip-bin')
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'panlite-extract-integrity-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function zipWithFile(): Promise<string> {
  const input = join(root, 'source')
  mkdirSync(join(input, 'folder'), { recursive: true })
  writeFileSync(join(input, 'folder', 'document.txt'), 'new content')
  const archive = join(root, 'sample.zip')
  await createArchive(input, archive)
  return archive
}

describe('archive extraction integrity', () => {
  it('does not overwrite an existing destination file', async () => {
    const archive = await zipWithFile()
    const target = join(root, 'target')
    mkdirSync(join(target, 'folder'), { recursive: true })
    writeFileSync(join(target, 'folder', 'document.txt'), 'original content')
    await expect(extractArchive(archive, target)).rejects.toThrow()
    expect(readFileSync(join(target, 'folder', 'document.txt'), 'utf8')).toBe('original content')
  })

  it('does not follow a destination junction into another directory', async () => {
    const archive = await zipWithFile()
    const target = join(root, 'target'), outside = join(root, 'outside')
    mkdirSync(target); mkdirSync(outside)
    symlinkSync(outside, join(target, 'folder'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(extractArchive(archive, target)).rejects.toThrow()
    expect(readdirSync(outside)).toEqual([])
  })

  it('does not damage an existing file when an encrypted ZIP password is wrong', async () => {
    const input = join(root, 'document.txt'), archive = join(root, 'encrypted.zip'), target = join(root, 'target')
    writeFileSync(input, 'new content'); mkdirSync(target)
    execFileSync(path7za, ['a', '-tzip', archive, input, '-p1234', '-mem=ZipCrypto'], { cwd: root, windowsHide: true })
    writeFileSync(join(target, 'document.txt'), 'original content')
    await expect(extractArchive(archive, target, 'wrong')).rejects.toThrow()
    expect(readFileSync(join(target, 'document.txt'), 'utf8')).toBe('original content')
    expect(readdirSync(target)).toEqual(['document.txt'])
  })

  it('cleans the staged partial output after a wrong password and extracts successfully with the right one', async () => {
    const input = join(root, 'document.txt'), archive = join(root, 'encrypted.zip'), target = join(root, 'target')
    writeFileSync(input, 'new content'); mkdirSync(target)
    execFileSync(path7za, ['a', '-tzip', archive, input, '-p1234', '-mem=ZipCrypto'], { cwd: root, windowsHide: true })
    await expect(extractArchive(archive, target, 'wrong')).rejects.toThrow()
    expect(readdirSync(target)).toEqual([])
    await extractArchive(archive, target, '1234')
    expect(readFileSync(join(target, 'document.txt'), 'utf8')).toBe('new content')
    expect(readdirSync(target)).toEqual(['document.txt'])
  })

  it('rejects a ZIP whose listed CRC does not match the extracted bytes', async () => {
    const archive = await zipWithFile(), data = readFileSync(archive)
    const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
    let central = -1, offset = 0
    while ((offset = data.indexOf(signature, offset)) !== -1) {
      const length = data.readUInt16LE(offset + 28)
      if (data.subarray(offset + 46, offset + 46 + length).toString('utf8') === 'folder/document.txt') { central = offset; break }
      offset += 46 + length
    }
    expect(central).toBeGreaterThanOrEqual(0)
    data[central + 16] ^= 0xff
    writeFileSync(archive, data)
    const target = join(root, 'target')
    await expect(extractArchive(archive, target)).rejects.toThrow()
    expect(existsSync(join(target, 'folder', 'document.txt'))).toBe(false)
  })
})
