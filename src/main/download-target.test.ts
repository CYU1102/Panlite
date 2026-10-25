import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assertSafeDownloadTarget, prepareSafeDownloadRoot } from './download-target'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-download-target-'))
const root = path.join(scratch, 'downloads'), outside = path.join(scratch, 'outside')
fs.mkdirSync(root); fs.mkdirSync(outside)
afterAll(() => {
  // Unlink exact junctions first; a self-referencing ancestor fixture must never be recursively followed.
  for (const candidate of [path.join(root, 'linked'), path.join(root, 'inner-link'), path.join(scratch, 'root-link'), path.join(scratch, 'ancestor-link')]) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) fs.unlinkSync(candidate)
  }
  if (path.basename(scratch).startsWith('panlite-download-target-')) fs.rmSync(scratch, { recursive: true, force: true })
})
describe('download target filesystem containment', () => {
  it('accepts ordinary roots, existing files and missing nested outputs', () => {
    fs.writeFileSync(path.join(root, 'ordinary.txt'), 'old')
    expect(() => assertSafeDownloadTarget(root)).not.toThrow()
    expect(() => assertSafeDownloadTarget(root, path.join(root, 'ordinary.txt'))).not.toThrow()
    expect(() => assertSafeDownloadTarget(root, path.join(root, 'missing', 'new.txt'))).not.toThrow()
  })
  it('creates a new ordinary target root after checking its existing ancestors', () => {
    const fresh = path.join(scratch, 'first-download', 'new-root')
    expect(fs.existsSync(fresh)).toBe(false)
    expect(() => prepareSafeDownloadRoot(fresh)).not.toThrow()
    expect(fs.statSync(fresh).isDirectory()).toBe(true)
    expect(() => assertSafeDownloadTarget(fresh, path.join(fresh, 'new.txt'))).not.toThrow()
  })
  it('rejects lexical siblings and parent escapes', () => {
    expect(() => assertSafeDownloadTarget(root, path.join(outside, 'file.txt'))).toThrow('越界')
    expect(() => assertSafeDownloadTarget(root, path.join(root, '..', 'file.txt'))).toThrow('越界')
  })
  it('rejects an existing junction before following it to an outside output', () => {
    const junction = path.join(root, 'linked'); fs.symlinkSync(outside, junction, 'junction')
    expect(() => assertSafeDownloadTarget(root, path.join(junction, 'new.txt'))).toThrow('目录联接')
    expect(() => prepareSafeDownloadRoot(path.join(junction, 'must-not-create'))).toThrow('目录联接')
    expect(fs.readdirSync(outside)).toEqual([])
  })
  it('rejects the selected root when it is a junction', () => {
    const junction = path.join(scratch, 'root-link'); fs.symlinkSync(root, junction, 'junction')
    expect(() => assertSafeDownloadTarget(junction)).toThrow('目录联接')
  })
  it('rejects a normal selected root beneath a junction ancestor', () => {
    const junction = path.join(scratch, 'ancestor-link'); fs.symlinkSync(scratch, junction, 'junction')
    expect(() => assertSafeDownloadTarget(path.join(junction, 'downloads'))).toThrow('目录联接')
  })
  it('rejects an existing destination symlink, even if it points inside the root', () => {
    const directory = path.join(root, 'inner'); fs.mkdirSync(directory)
    const linked = path.join(root, 'inner-link'); fs.symlinkSync(directory, linked, 'junction')
    expect(() => assertSafeDownloadTarget(root, linked)).toThrow('目录联接')
  })
  it('rejects a file used as the target root or an intermediate directory', () => {
    const file = path.join(root, 'not-a-directory'); fs.writeFileSync(file, 'old')
    expect(() => assertSafeDownloadTarget(file)).toThrow('普通目录')
    expect(() => assertSafeDownloadTarget(root, path.join(file, 'new.txt'))).toThrow('上级不是普通目录')
  })
})
