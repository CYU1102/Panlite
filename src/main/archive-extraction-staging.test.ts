import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stageArchiveExtraction } from './archive-extraction-staging'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'panlite-extract-stage-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const file = { name: 'sample.txt', path: 'sample.txt', size: 3, isDir: false }

describe('staged archive publication', () => {
  it('does not replace a file created while extraction is in progress', async () => {
    const target = join(root, 'target')
    await expect(stageArchiveExtraction(target, [file], async stage => {
      writeFileSync(join(stage, 'sample.txt'), 'new')
      writeFileSync(join(target, 'sample.txt'), 'other process')
    })).rejects.toThrow(/未覆盖/)
    expect(readFileSync(join(target, 'sample.txt'), 'utf8')).toBe('other process')
    expect(readdirSync(target)).toEqual(['sample.txt'])
  })

  it.each(['missing', 'wrong-size', 'extra'])('rejects staged contents inconsistent with metadata: %s', async variant => {
    const target = join(root, 'target')
    await expect(stageArchiveExtraction(target, [file], async stage => {
      if (variant !== 'missing') writeFileSync(join(stage, 'sample.txt'), variant === 'wrong-size' ? 'wrong' : 'new')
      if (variant === 'extra') writeFileSync(join(stage, 'extra.txt'), 'extra')
    })).rejects.toThrow()
    expect(readdirSync(target)).toEqual([])
  })

  it('rejects a staged directory link and does not follow it during cleanup', async () => {
    const target = join(root, 'target'), outside = join(root, 'outside')
    mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'keep')
    const nested = { name: 'nested', path: 'nested', size: 0, isDir: true }
    await expect(stageArchiveExtraction(target, [nested], async stage => {
      symlinkSync(outside, join(stage, 'nested'), process.platform === 'win32' ? 'junction' : 'dir')
    })).rejects.toThrow(/链接/)
    expect(readdirSync(target)).toEqual([])
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('rejects duplicate or conflicting archive paths before extraction starts', async () => {
    let invoked = false
    await expect(stageArchiveExtraction(join(root, 'target'), [file, { ...file }], async () => { invoked = true })).rejects.toThrow(/重复/)
    expect(invoked).toBe(false)
  })
})
