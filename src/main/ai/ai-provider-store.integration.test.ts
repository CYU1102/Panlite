import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderDraftInput, AiProviderSaveInput, AiProviderType } from '../../shared/ai-types'

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), encrypt: vi.fn() }))

// All rows and credentials in this suite are synthetic, in an in-memory DB.
// Real SQLite transactions exercise rollback without accessing user settings.
vi.mock('../db', () => ({
  getDb: mocks.getDb,
  getSetting: (key: string) => mocks.getDb().prepare('SELECT value, encrypted FROM settings WHERE key = ?').get(key),
  setSetting: (key: string, value: string, encrypted = false) => {
    mocks.getDb().prepare(`INSERT INTO settings (key, value, encrypted) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted`).run(key, value, Number(encrypted))
  },
  deleteSetting: (key: string) => mocks.getDb().prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0,
}))
vi.mock('../crypto', () => ({
  encryptCredential: mocks.encrypt,
  decryptCredential: (value: string) => Buffer.from(value.slice('sealed:'.length), 'base64').toString(),
}))

import { getSetting, setSetting } from '../db'
import {
  activateAiProviderProfile,
  defaultAiProviderBaseUrl,
  duplicateAiProviderProfile,
  getActiveAiProvider,
  getAiProviderKeys,
  listAiProviderProfiles,
  resolveAiProviderDraftKeys,
  saveAiProviderProfile,
} from './ai-provider-store'

let database: Database.Database

function input(overrides: Partial<AiProviderSaveInput> = {}): AiProviderSaveInput {
  return {
    id: 'fixture-profile', name: 'Fixture profile', type: 'openai-compatible',
    baseUrl: 'https://models.example.test/v1', model: 'fixture-model', ...overrides,
  }
}

function draft(overrides: Partial<AiProviderDraftInput> = {}): AiProviderDraftInput {
  return { profileId: 'fixture-profile', type: 'openai-compatible', baseUrl: 'https://models.example.test/v1', ...overrides }
}

function snapshot(): unknown[] {
  return database.prepare('SELECT * FROM settings ORDER BY key').all()
}

beforeEach(() => {
  database = new Database(':memory:')
  database.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL DEFAULT 0)')
  mocks.getDb.mockReset().mockReturnValue(database)
  mocks.encrypt.mockReset().mockImplementation((value: string) => `sealed:${Buffer.from(value).toString('base64')}`)
})

afterEach(() => database.close())

describe('AI provider profile persistence', () => {
  it('persists deduplicated keys and accurate masked metadata, enabling by default', () => {
    const profile = saveAiProviderProfile(input({ apiKey: ' key-alpha-fixture ', appendKeys: ['key-beta-fixture', 'key-alpha-fixture', ' '] }))

    expect(getAiProviderKeys(profile.id)).toEqual(['key-alpha-fixture', 'key-beta-fixture'])
    expect(profile.keyCount).toBe(2)
    expect(profile.keyPreviews).toHaveLength(2)
    expect(getActiveAiProvider().config.id).toBe(profile.id)
    expect(getSetting(`aiProviderKeysV2:${profile.id}`)?.encrypted).toBe(1)
    expect(getSetting(`aiProviderApiKeyV2:${profile.id}`)?.encrypted).toBe(1)
    expect(JSON.stringify(listAiProviderProfiles())).not.toContain('key-alpha-fixture')
    expect(getSetting('aiProviderProfilesV2')?.value).not.toContain('key-alpha-fixture')
  })

  it('saves a non-active profile without switching and activates only on request', () => {
    const first = saveAiProviderProfile(input({ id: 'first' }))
    const second = saveAiProviderProfile(input({ id: 'second', activate: false }))
    expect(getActiveAiProvider().config.id).toBe(first.id)
    saveAiProviderProfile(input({ id: second.id, model: 'updated-model', activate: false }))
    expect(getActiveAiProvider().config.id).toBe(first.id)
    activateAiProviderProfile(second.id)
    expect(getActiveAiProvider().config).toMatchObject({ id: second.id, model: 'updated-model' })
  })

  it('preserves an initial inactive default when the first named profile is only saved', () => {
    saveAiProviderProfile(input({ activate: false }))
    expect(getActiveAiProvider().config.id).toBe('default')
    expect(listAiProviderProfiles()).toHaveLength(2)
  })

  it('does not write any keys or metadata when HTTPS validation fails', () => {
    saveAiProviderProfile(input({ apiKey: 'original-fixture-key' }))
    const before = snapshot()
    mocks.encrypt.mockClear()
    expect(() => saveAiProviderProfile(input({ baseUrl: 'http://remote.example.test/v1', apiKey: 'replacement-fixture-key' })))
      .toThrow('必须使用 HTTPS')
    expect(snapshot()).toEqual(before)
    expect(mocks.encrypt).not.toHaveBeenCalled()
  })

  it.each(['?api-version=2026-01-01', '#models', '?', '#'])('rejects root URL suffix %s for both drafts and saves without changing credentials', (suffix) => {
    saveAiProviderProfile(input({ apiKey: 'original-fixture-key' }))
    const before = snapshot()
    const baseUrl = `https://models.example.test/v1${suffix}`
    mocks.encrypt.mockClear()
    expect(() => resolveAiProviderDraftKeys(draft({ baseUrl, apiKey: 'replacement-fixture-key' })))
      .toThrow('不能包含查询参数或片段')
    expect(() => saveAiProviderProfile(input({ baseUrl, apiKey: 'replacement-fixture-key' })))
      .toThrow('不能包含查询参数或片段')
    expect(snapshot()).toEqual(before)
    expect(mocks.encrypt).not.toHaveBeenCalled()
  })

  it('can repair an old root URL with a query when new credentials are explicitly supplied', () => {
    saveAiProviderProfile(input({ apiKey: 'original-fixture-key' }))
    const profiles = JSON.parse(getSetting('aiProviderProfilesV2')!.value)
    profiles[0].baseUrl = 'https://models.example.test/v1?old-option=1'
    setSetting('aiProviderProfilesV2', JSON.stringify(profiles))
    expect(() => saveAiProviderProfile(input())).toThrow('请提供新 API Key')
    saveAiProviderProfile(input({ apiKey: 'replacement-fixture-key' }))
    expect(getActiveAiProvider().config.baseUrl).toBe('https://models.example.test/v1')
    expect(getAiProviderKeys('fixture-profile')).toEqual(['replacement-fixture-key'])
  })

  it('rolls back the key pool, legacy key, metadata, and active selection after a late DB error', () => {
    saveAiProviderProfile(input({ apiKey: 'original-fixture-key' }))
    saveAiProviderProfile(input({ id: 'active-other' }))
    const before = snapshot()
    database.exec(`CREATE TRIGGER reject_active BEFORE INSERT ON settings
      WHEN NEW.key = 'aiProviderActiveProfileV2' BEGIN SELECT RAISE(ABORT, 'fixture active write failure'); END`)

    expect(() => saveAiProviderProfile(input({ model: 'replacement-model', apiKey: 'replacement-fixture-key' })))
      .toThrow('fixture active write failure')
    expect(snapshot()).toEqual(before)
  })

  it('leaves the previous pool untouched if encrypting either stored representation fails', () => {
    saveAiProviderProfile(input({ apiKey: 'original-fixture-key' }))
    const before = snapshot()
    mocks.encrypt.mockImplementationOnce((value: string) => `sealed:${Buffer.from(value).toString('base64')}`)
      .mockImplementationOnce(() => { throw new Error('fixture encryption failure') })
    expect(() => saveAiProviderProfile(input({ apiKey: 'replacement-fixture-key' }))).toThrow('fixture encryption failure')
    expect(snapshot()).toEqual(before)
  })

  it('duplicates metadata and encrypted keys under a unique name without changing the active profile', () => {
    const original = saveAiProviderProfile(input({ apiKey: 'source-fixture-key', embeddingModel: 'fixture-embed' }))
    saveAiProviderProfile(input({ id: 'other-profile' }))
    const firstCopy = duplicateAiProviderProfile(original.id)
    const secondCopy = duplicateAiProviderProfile(original.id)

    expect(firstCopy.id).not.toBe(original.id)
    expect(firstCopy).toMatchObject({ name: 'Fixture profile（副本）', model: original.model, embeddingModel: 'fixture-embed', keyCount: 1 })
    expect(secondCopy.name).toBe('Fixture profile（副本 2）')
    expect(getAiProviderKeys(firstCopy.id)).toEqual(['source-fixture-key'])
    expect(getSetting(`aiProviderKeysV2:${firstCopy.id}`)?.encrypted).toBe(1)
    expect(getActiveAiProvider().config.id).toBe('other-profile')
    saveAiProviderProfile(input({ id: firstCopy.id, apiKey: 'copy-only-fixture-key', activate: false }))
    expect(getAiProviderKeys(original.id)).toEqual(['source-fixture-key'])
  })

  it('rolls back a duplicate if profile persistence fails after encrypting its keys', () => {
    saveAiProviderProfile(input({ apiKey: 'source-fixture-key' }))
    const before = snapshot()
    database.exec(`CREATE TRIGGER reject_profiles BEFORE INSERT ON settings
      WHEN NEW.key = 'aiProviderProfilesV2' BEGIN SELECT RAISE(ABORT, 'fixture profile write failure'); END`)
    expect(() => duplicateAiProviderProfile('fixture-profile')).toThrow('fixture profile write failure')
    expect(snapshot()).toEqual(before)
  })
})

describe('AI draft keys and saved key changes', () => {
  const cases: Array<{ name: string; changes: Partial<AiProviderSaveInput>; expected: string[] }> = [
    { name: 'retain the pool', changes: {}, expected: ['fixture-a', 'fixture-b', 'fixture-c'] },
    { name: 'replace and append together', changes: { apiKey: 'replacement', appendKeys: ['extra', 'replacement'] }, expected: ['replacement', 'extra'] },
    { name: 'clear and append together', changes: { clearApiKey: true, appendKeys: ['extra', 'extra'] }, expected: ['extra'] },
    { name: 'remove multiple original indices', changes: { removeKeyAt: 0, removeKeyIndices: [2, 0], appendKeys: ['extra'] }, expected: ['fixture-b', 'extra'] },
    { name: 'clear all keys', changes: { clearApiKey: true }, expected: [] },
    { name: 'replace after clearing', changes: { clearApiKey: true, apiKey: 'replacement' }, expected: ['replacement'] },
  ]

  it.each(cases)('uses identical draft and save semantics: $name', ({ changes, expected }) => {
    saveAiProviderProfile(input({ appendKeys: ['fixture-a', 'fixture-b', 'fixture-c'] }))
    const before = snapshot()
    expect(resolveAiProviderDraftKeys(draft(changes))).toEqual(expected)
    expect(snapshot()).toEqual(before)
    const saved = saveAiProviderProfile(input(changes))
    expect(getAiProviderKeys(saved.id)).toEqual(expected)
    expect(saved.keyCount).toBe(expected.length)
    expect(saved.keyPreviews).toHaveLength(expected.length)
  })

  it('reuses saved keys when normalized addresses match exactly', () => {
    saveAiProviderProfile(input({ apiKey: 'saved-fixture-key' }))
    expect(resolveAiProviderDraftKeys(draft({ baseUrl: ' https://MODELS.example.test:443/v1/ ' }))).toEqual(['saved-fixture-key'])
  })

  it.each([
    { baseUrl: 'https://different.example.test/v1' },
    { baseUrl: 'https://models.example.test/other' },
    { type: 'anthropic' as const },
  ])('does not reuse credentials for another endpoint or protocol: %j', (changes) => {
    saveAiProviderProfile(input({ apiKey: 'saved-fixture-key' }))
    const before = snapshot()
    expect(() => resolveAiProviderDraftKeys(draft(changes))).toThrow('请提供新 API Key')
    expect(() => saveAiProviderProfile(input(changes))).toThrow('请提供新 API Key')
    expect(snapshot()).toEqual(before)
  })

  it('starts with an empty key pool when explicitly appending keys at a new endpoint', () => {
    saveAiProviderProfile(input({ apiKey: 'saved-fixture-key' }))
    const changes = { baseUrl: 'https://different.example.test/v1', appendKeys: ['new-endpoint-key'] }
    expect(resolveAiProviderDraftKeys(draft(changes))).toEqual(['new-endpoint-key'])
    saveAiProviderProfile(input(changes))
    expect(getAiProviderKeys('fixture-profile')).toEqual(['new-endpoint-key'])
  })

  it('permits explicit clearing when switching to an unauthenticated endpoint', () => {
    saveAiProviderProfile(input({ apiKey: 'saved-fixture-key' }))
    const changes = { baseUrl: 'http://unauthenticated.example.test/v1', clearApiKey: true }
    expect(resolveAiProviderDraftKeys(draft(changes))).toEqual([])
    saveAiProviderProfile(input(changes))
    expect(getAiProviderKeys('fixture-profile')).toEqual([])
  })

  it('allows authenticated IPv6 loopback endpoints and rejects unknown protocols', () => {
    saveAiProviderProfile(input({ type: 'ollama', baseUrl: 'http://[::1]:11434', apiKey: 'loopback-fixture-key' }))
    expect(resolveAiProviderDraftKeys(draft({ type: 'ollama', baseUrl: 'http://[::1]:11434' }))).toEqual(['loopback-fixture-key'])
    const before = snapshot()
    expect(() => saveAiProviderProfile(input({ type: 'unknown' as AiProviderType }))).toThrow('不支持')
    expect(() => resolveAiProviderDraftKeys(draft({ type: 'unknown' as AiProviderType }))).toThrow('不支持')
    expect(snapshot()).toEqual(before)
  })
})

describe('AI protocol persistence and defaults', () => {
  it.each([
    ['openai-compatible', 'https://api.openai.com/v1', 'gpt-4o-mini-transcribe'],
    ['openai-responses', 'https://api.openai.com/v1', ''],
    ['anthropic', 'https://api.anthropic.com/v1', ''],
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta', ''],
    ['ollama', 'http://127.0.0.1:11434', ''],
  ] as const)('round trips %s with safe auxiliary model defaults', (type, baseUrl, transcriptionModel) => {
    const profile = saveAiProviderProfile(input({ type, baseUrl: '' }))
    expect(defaultAiProviderBaseUrl(type)).toBe(baseUrl)
    expect(profile).toMatchObject({ type, baseUrl, transcriptionModel, embeddingModel: '' })
    expect(getActiveAiProvider().config).toMatchObject({ type, baseUrl, transcriptionModel, embeddingModel: '' })
  })

  it('does not carry auxiliary models across a protocol change', () => {
    saveAiProviderProfile(input({ embeddingModel: 'embedding-fixture' }))
    const changed = saveAiProviderProfile(input({ type: 'gemini', baseUrl: '' }))
    expect(changed).toMatchObject({ transcriptionModel: '', embeddingModel: '' })
  })

  it('retains explicitly disabled transcription models and reads legacy provider records', () => {
    saveAiProviderProfile(input({ transcriptionModel: '' }))
    expect(getActiveAiProvider().config.transcriptionModel).toBe('')
    database.exec('DELETE FROM settings')
    setSetting('aiProviderType', 'legacy-unknown')
    setSetting('aiProviderModel', 'legacy-model')
    expect(getActiveAiProvider().config).toMatchObject({ type: 'openai-compatible', model: 'legacy-model' })
  })
})
