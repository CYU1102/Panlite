import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ root: '', account: vi.fn(), download: vi.fn(), imported: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
vi.mock('../db', () => ({ getAccountById: fixture.account }))
vi.mock('../crypto', () => ({ decryptCredential: () => '{}' }))
vi.mock('../../adapters/registry', () => ({ getAdapter: () => ({ download: fixture.download }) }))
vi.mock('./ai-service', () => ({ importAiFiles: fixture.imported }))

import { importAiCloudFiles } from './cloud-import'

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-cloud-import-test-'))
  vi.clearAllMocks()
  fixture.account.mockReturnValue({ id: 'account', platform: 'quark', status: 'active', created_at: 1, updated_at: 1 })
  fixture.imported.mockResolvedValue({ success: true, documents: [], taskIds: [] })
})
afterEach(() => {
  const root = path.resolve(fixture.root)
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('panlite-cloud-import-test-')) throw new Error('Unexpected fixture root')
  fs.rmSync(root, { recursive: true, force: true })
})

const request = { accountId: 'account', fileId: 'file', fileName: 'document.txt' }

describe('cloud AI import source protection', () => {
  it('does not remove an old downloaded source that an AI document may still reference', async () => {
    const oldDirectory = path.join(fixture.root, 'ai-cloud-downloads', 'item-old')
    fs.mkdirSync(oldDirectory, { recursive: true })
    const source = path.join(oldDirectory, 'source.txt')
    fs.writeFileSync(source, 'retained source')
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    fs.utimesSync(oldDirectory, old, old)
    fixture.account.mockReturnValueOnce(null)
    await importAiCloudFiles([request])
    expect(fs.readFileSync(source, 'utf8')).toBe('retained source')
  })

  it('rejects a downloaded path outside the owned request directory', async () => {
    const outside = path.join(fixture.root, 'outside.txt')
    fs.writeFileSync(outside, 'outside data')
    fixture.download.mockResolvedValue({ success: true, localPath: outside })
    const result = await importAiCloudFiles([request])
    expect(result.success).toBe(false)
    expect(fixture.imported).not.toHaveBeenCalled()
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside data')
  })

  it('rejects a linked managed source root without writing to its target', async () => {
    const outside = path.join(fixture.root, 'outside')
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside data')
    fs.symlinkSync(outside, path.join(fixture.root, 'ai-attachments'), process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expect(importAiCloudFiles([request])).rejects.toThrow(/链接|联接/)
      expect(fixture.download).not.toHaveBeenCalled()
      expect(fs.readdirSync(outside)).toEqual(['keep.txt'])
    } finally {
      fs.unlinkSync(path.join(fixture.root, 'ai-attachments'))
    }
  })

  it('rejects a link in the returned download path without touching its target', async () => {
    const outside = path.join(fixture.root, 'outside')
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'document.txt'), 'outside data')
    fixture.download.mockImplementation(async (_account, _id, directory: string) => {
      fs.symlinkSync(outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
      return { success: true, localPath: path.join(directory, 'linked', 'document.txt') }
    })
    const result = await importAiCloudFiles([request])
    expect(result.success).toBe(false)
    expect(fixture.imported).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(outside, 'document.txt'), 'utf8')).toBe('outside data')
  })

  it('does not follow a directory link during failed download cleanup', async () => {
    const outside = path.join(fixture.root, 'outside')
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside data')
    fixture.download.mockImplementation(async (_account, _id, directory: string) => {
      fs.symlinkSync(outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
      return { success: false, error: 'synthetic failure' }
    })
    const result = await importAiCloudFiles([request])
    expect(result.success).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('outside data')
  })

  it('does not delete a replacement directory after a failed download', async () => {
    let replaced = ''
    fixture.download.mockImplementation(async (_account, _id, directory: string) => {
      replaced = directory
      fs.renameSync(directory, `${directory}-original`)
      fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'keep.txt'), 'replacement data')
      return { success: false, error: 'synthetic failure' }
    })
    const result = await importAiCloudFiles([request])
    expect(result.success).toBe(false)
    expect(fs.readFileSync(path.join(replaced, 'keep.txt'), 'utf8')).toBe('replacement data')
  })

  it('rechecks earlier downloads after later downloads before sending them to the importer', async () => {
    let firstDirectory = ''
    fixture.download.mockImplementation(async (_account, id: string, directory: string, options: { fileName: string }) => {
      if (id === 'first') firstDirectory = directory
      else {
        fs.renameSync(firstDirectory, `${firstDirectory}-original`)
        fs.mkdirSync(firstDirectory); fs.writeFileSync(path.join(firstDirectory, 'document.txt'), 'replacement data')
      }
      const localPath = path.join(directory, options.fileName)
      fs.writeFileSync(localPath, id)
      return { success: true, localPath }
    })
    const result = await importAiCloudFiles([{ ...request, fileId: 'first' }, { ...request, fileId: 'second' }])
    expect(result.success).toBe(true)
    expect(fixture.imported).toHaveBeenCalledOnce()
    expect(fixture.imported.mock.calls[0][0]).toHaveLength(1)
    expect(fixture.imported.mock.calls[0][0][0].sourceFileId).toBe('second')
    expect(fs.readFileSync(path.join(firstDirectory, 'document.txt'), 'utf8')).toBe('replacement data')
  })

  it('passes a successfully downloaded owned file to the AI importer', async () => {
    fixture.download.mockImplementation(async (_account, _id, directory: string, options: { fileName: string }) => {
      const localPath = path.join(directory, options.fileName)
      fs.writeFileSync(localPath, 'cloud data')
      return { success: true, localPath }
    })
    const result = await importAiCloudFiles([request])
    expect(result.success).toBe(true)
    const input = fixture.imported.mock.calls[0][0][0]
    expect(input).toMatchObject({ fileName: 'document.txt', sourceAccountId: 'account', sourceFileId: 'file' })
    expect(fs.readFileSync(input.localPath, 'utf8')).toBe('cloud data')
  })
})
