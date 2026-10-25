import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.profile } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
import { getDb, initDatabase } from './db'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-release-gates-'))
const repository = path.join(directory, 'source')
const manifest = path.join(directory, 'provenance.json')
const profileManifest = path.join(directory, 'profile-fixture.json')
let provenance: any
const profileFixture = require(path.resolve('scripts/fixtures/install-profile.cjs'))
const git = (args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true, stdio: 'pipe' })

beforeAll(async () => {
  provenance = await import(pathToFileURL(path.resolve('scripts/write-build-provenance.mjs')).href)
  fs.mkdirSync(repository)
  fs.mkdirSync(path.join(repository, 'src'))
  fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({ version: '0.2.1' }))
  fs.writeFileSync(path.join(repository, 'package-lock.json'), '{}')
  fs.writeFileSync(path.join(repository, 'src/main.ts'), 'export const marker = 1\n')
  git(['init'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'add', '.'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-m', 'fixture'])
})
afterAll(() => {
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('panlite-release-gates-')) throw new Error('Unexpected test directory')
  // Git object files are read-only on Windows; Electron's fs.rm leaves those
  // behind unless their owner-write bit is restored in this owned fixture.
  const writable = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) writable(file)
      else if (entry.isFile()) fs.chmodSync(file, 0o666)
    }
  }
  writable(directory)
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('release source provenance', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(repository, 'src/main.ts'), 'export const marker = 1\n')
    fs.rmSync(path.join(repository, 'src/new.ts'), { force: true })
  })
  it('records a clean committed source, lockfile hash and version', async () => {
    const report = await provenance.writeBuildProvenance(manifest, { root: repository, requireClean: true })
    expect(report).toMatchObject({ version: '0.2.1', dirty: false, releaseEligibleSource: true, channel: 'windows-unsigned' })
    expect(report.lockfileSha256).toMatch(/^[a-f0-9]{64}$/)
    await expect(provenance.verifyBuildProvenance(manifest, { root: repository, requireClean: true })).resolves.toMatchObject({ revision: report.revision })
  })
  it('detects source changes and includes newly added source files', async () => {
    const before = await provenance.writeBuildProvenance(manifest, { root: repository })
    fs.writeFileSync(path.join(repository, 'src/new.ts'), 'new implementation')
    const after = await provenance.collectSourceProvenance(repository)
    expect(after.sourceSha256).not.toBe(before.sourceSha256)
    expect(after.files).toContainEqual(expect.objectContaining({ path: 'src/new.ts' }))
    await expect(provenance.verifyBuildProvenance(manifest, { root: repository })).rejects.toThrow('Source changed')
    await expect(provenance.writeBuildProvenance(manifest, { root: repository, requireClean: true })).rejects.toThrow('clean committed')
  })
  it('excludes unrelated local user files even when Git considers them untracked', async () => {
    const before = await provenance.collectSourceProvenance(repository)
    fs.mkdirSync(path.join(repository, 'tmp'))
    fs.writeFileSync(path.join(repository, 'tmp/private-paper.txt'), 'private local document')
    try {
      const after = await provenance.collectSourceProvenance(repository)
      expect(after.sourceSha256).toBe(before.sourceSha256)
      expect(after.files.some((file: { path: string }) => file.path.startsWith('tmp/'))).toBe(false)
    } finally { fs.rmSync(path.join(repository, 'tmp'), { recursive: true }) }
  })
  it('rejects a mismatched CI commit and unrelated local paths', async () => {
    await expect(provenance.writeBuildProvenance(manifest, { root: repository, expectedRevision: 'wrong-commit' })).rejects.toThrow('CI source revision')
    expect(provenance.isReleaseSourcePath('tmp/user-document.docx')).toBe(false)
    expect(provenance.isReleaseSourcePath('docs/RELEASE.md')).toBe(true)
  })
  it('refuses a profile outside the owned disposable directory before launching an application', () => {
    const result = spawnSync(process.execPath, [path.resolve('scripts/check-install-profile.mjs'), 'launch', 'missing-app.exe', os.tmpdir(), manifest], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 10000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Profile must belong to the disposable installation test directory')
  })
})

describe('installed profile upgrade evidence', () => {
  beforeEach(() => {
    fixture.profile = fs.mkdtempSync(path.join(directory, 'profile-'))
    fs.rmSync(profileManifest, { force: true })
    vi.useFakeTimers(); initDatabase(); vi.clearAllTimers(); vi.useRealTimers()
  })
  afterEach(() => { try { if (getDb().open) getDb().close() } catch {} })
  it('verifies seeded account/settings/task/AI source bytes after actual migrations rerun', () => {
    expect(profileFixture.seed(getDb(), fixture.profile, profileManifest)).toMatchObject({ passed: true, seededRows: 4 })
    getDb().close()
    vi.useFakeTimers(); initDatabase(); vi.clearAllTimers(); vi.useRealTimers()
    expect(profileFixture.verify(getDb(), fixture.profile, profileManifest)).toMatchObject({ passed: true, accountCredentialBytesPreserved: true,
      settingsPreserved: true, pausedTaskPreserved: true, aiDocumentPreserved: true, realLoginTested: false })
    getDb().close()
  })
  it('fails if a credential or task payload changes instead of accepting a row count', () => {
    profileFixture.seed(getDb(), fixture.profile, profileManifest)
    getDb().prepare('UPDATE accounts SET encrypted_credential=?').run('changed')
    expect(() => profileFixture.verify(getDb(), fixture.profile, profileManifest)).toThrow('changed during upgrade/rollback')
    getDb().close()
  })
  it('fails if an AI attachment has changed bytes', () => {
    profileFixture.seed(getDb(), fixture.profile, profileManifest)
    const data = JSON.parse(fs.readFileSync(profileManifest, 'utf8'))
    fs.writeFileSync(path.join(fixture.profile, data.attachment.name), 'corrupted')
    expect(() => profileFixture.verify(getDb(), fixture.profile, profileManifest)).toThrow('AI attachment bytes changed')
    getDb().close()
  })
  it('refuses to overwrite an existing fixture or silently omit AI tables', () => {
    profileFixture.seed(getDb(), fixture.profile, profileManifest)
    expect(() => profileFixture.seed(getDb(), fixture.profile, profileManifest)).toThrow('existing upgrade fixture')
    getDb().exec('DROP TABLE ai_documents')
    expect(() => profileFixture.verify(getDb(), fixture.profile, profileManifest)).toThrow()
    getDb().close()
  })
})
