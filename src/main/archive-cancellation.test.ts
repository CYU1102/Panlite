import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { createArchive, extractArchive } from './archive'

describe('archive task cancellation', () => {
  it('rejects before reading an archive when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(extractArchive('missing.zip', mkdtempSync(join(tmpdir(), 'panlite-cancel-')), undefined, undefined, {
      signal: controller.signal,
    })).rejects.toThrow('操作已取消')
  })

  it('rejects before creating an archive when the signal is already aborted', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'panlite-cancel-source-'))
    const outputPath = join(sourceDir, 'out.zip')
    writeFileSync(join(sourceDir, 'file.txt'), 'test')
    const controller = new AbortController()
    controller.abort()
    await expect(createArchive(sourceDir, outputPath, 'zip', undefined, { signal: controller.signal }))
      .rejects.toThrow('操作已取消')
  })
})
