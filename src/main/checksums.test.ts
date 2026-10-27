import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const temp = fs.realpathSync.native(os.tmpdir())
const scratch = fs.mkdtempSync(path.join(temp, 'panlite-checksums-test-'))
let release: string
let caseNumber = 0
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const manifest = (rows: Array<[string, string]>) => fs.writeFileSync(path.join(release, 'SHA256SUMS.txt'), rows.map(([file, hash]) => `${hash}  ${file}`).join('\n') + '\n')
const run = (script: string, args: string[]) => spawnSync(process.execPath, [path.resolve('scripts', script), ...args], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 10000,
})
const verify = () => run('verify-checksums.mjs', [release])

beforeEach(() => {
  release = path.join(scratch, `release-${++caseNumber}`)
  fs.mkdirSync(release)
})
afterAll(() => {
  if (path.dirname(scratch) !== temp || !path.basename(scratch).startsWith('panlite-checksums-test-') || fs.realpathSync.native(scratch) !== scratch) throw new Error('Unsafe checksum test cleanup path')
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('release checksum CLI', () => {
  it('verifies actual binary, nested and Chinese filenames without mutating the release', () => {
    const data: Array<[string, Buffer]> = [['candidate.exe', Buffer.from([0, 127, 255, 42])], ['nested/config.json', Buffer.from('{"valid":true}')], ['说明 文档.txt', Buffer.from('只读校验')]]
    for (const [file, bytes] of data) {
      fs.mkdirSync(path.dirname(path.join(release, file)), { recursive: true })
      fs.writeFileSync(path.join(release, file), bytes)
    }
    manifest(data.map(([file, bytes]) => [file, digest(bytes)]))
    const before = fs.readFileSync(path.join(release, 'SHA256SUMS.txt'))
    const result = verify()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ passed: true, verifiedFiles: 3, manifestSha256: digest(before) })
    expect(fs.readFileSync(path.join(release, 'SHA256SUMS.txt'))).toEqual(before)
    for (const [file, bytes] of data) expect(fs.readFileSync(path.join(release, file))).toEqual(bytes)
  })

  it('fails when an advertised delivery file is missing', () => {
    manifest([['missing.blockmap', digest('expected')]])
    const result = verify()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Missing checksum file: missing.blockmap')
  })

  it('rejects tampered bytes', () => {
    fs.writeFileSync(path.join(release, 'candidate.exe'), 'modified')
    manifest([['candidate.exe', digest('original')]])
    const result = verify()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Checksum mismatch: candidate.exe')
  })

  it.each(['../outside.txt', '/outside.txt', 'C:/outside.txt', 'nested/../outside.txt', 'nested\\outside.txt', 'nested//outside.txt', 'candidate.exe:stream', 'folder./candidate.exe', 'NUL.txt'])('rejects non-portable or escaping manifest path %s', (file) => {
    const outside = path.join(scratch, 'outside.txt')
    fs.writeFileSync(outside, 'external marker')
    manifest([[file, digest('external marker')]])
    const result = verify()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unsafe checksum path')
    expect(fs.readFileSync(outside, 'utf8')).toBe('external marker')
  })

  it.each([['candidate.exe', 'candidate.exe'], ['candidate.exe', 'CANDIDATE.EXE']])('rejects duplicate Windows path identities %j', (first, second) => {
    fs.writeFileSync(path.join(release, first), 'same bytes')
    manifest([[first, digest('same bytes')], [second, digest('same bytes')]])
    const result = verify()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Duplicate checksum path')
  })

  it('refuses directory entries and junction ancestors', () => {
    fs.mkdirSync(path.join(release, 'directory'))
    manifest([['directory', digest('directory bytes')]])
    expect(verify().stderr).toContain('not an ordinary file')
    const outside = path.join(scratch, `outside-${caseNumber}`)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'data.txt'), 'linked bytes')
    fs.symlinkSync(outside, path.join(release, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    manifest([['linked/data.txt', digest('linked bytes')]])
    const result = verify()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('symbolic links or junctions')
  })

  it.each(['', '\n\n', '1234  candidate.exe\n', `${'a'.repeat(64)} *candidate.exe\n`])('refuses empty or malformed checksum manifests', (content) => {
    fs.writeFileSync(path.join(release, 'SHA256SUMS.txt'), content)
    expect(verify().status).toBe(1)
  })

  it('preserves the writer default and recursive delivery sets, both accepted by the verifier', () => {
    fs.writeFileSync(path.join(release, 'candidate.exe'), Buffer.from([0, 1, 2, 3]))
    fs.writeFileSync(path.join(release, 'builder-debug.yml'), 'internal debug')
    fs.mkdirSync(path.join(release, 'nested'))
    fs.writeFileSync(path.join(release, 'nested/data.txt'), 'nested payload')
    const first = run('write-checksums.mjs', [release])
    expect(first.status, first.stderr).toBe(0)
    expect(JSON.parse(verify().stdout).files.map((file: { path: string }) => file.path)).toEqual(['candidate.exe'])
    const recursive = run('write-checksums.mjs', [release, '--recursive'])
    expect(recursive.status, recursive.stderr).toBe(0)
    const verified = verify()
    expect(verified.status, verified.stderr).toBe(0)
    expect(JSON.parse(verified.stdout).files.map((file: { path: string }) => file.path)).toEqual(['candidate.exe', 'nested/data.txt'])
  })
})
