import crypto from 'node:crypto'
import { decryptCredential, encryptCredential } from '../crypto'
import { deleteSetting, getDb, getSetting, setSetting } from '../db'
import type { AiProviderConfig, AiProviderDraftInput, AiProviderSaveInput, AiProviderType, AiProviderUsage } from '../../shared/ai-types'

const PROFILES_KEY = 'aiProviderProfilesV2'
const ACTIVE_PROFILE_KEY = 'aiProviderActiveProfileV2'
const USAGE_KEY = 'aiProviderUsageV2'
const LEGACY_TYPE_KEY = 'aiProviderType'
const LEGACY_BASE_URL_KEY = 'aiProviderBaseUrl'
const LEGACY_MODEL_KEY = 'aiProviderModel'
const LEGACY_API_KEY = 'aiProviderApiKey'
const DEFAULT_PROFILE_ID = 'default'
const PROVIDER_TYPES: readonly AiProviderType[] = ['openai-compatible', 'openai-responses', 'anthropic', 'gemini', 'ollama']

export function normalizeAiProviderType(value: unknown): AiProviderType {
  if (typeof value === 'string' && PROVIDER_TYPES.includes(value as AiProviderType)) return value as AiProviderType
  throw new Error('不支持的模型接口协议')
}

function storedProviderType(value: unknown): AiProviderType {
  try { return normalizeAiProviderType(value) } catch { return 'openai-compatible' }
}

function settingValue(key: string): string {
  const row = getSetting(key)
  if (!row) return ''
  if (!row.encrypted) return row.value
  try {
    return decryptCredential(row.value)
  } catch {
    return ''
  }
}

function apiKeySetting(id: string): string {
  return id === DEFAULT_PROFILE_ID ? LEGACY_API_KEY : `aiProviderApiKeyV2:${id}`
}

const KEY_POOL_SETTING = (id: string): string => `aiProviderKeysV2:${id}`

export function getAiProviderApiKey(id: string): string {
  return getAiProviderKeys(id)[0] || ''
}

/** 读取一个配置的 Key 池；兼容旧版单 Key 存储 */
export function getAiProviderKeys(id: string): string[] {
  const trimmed = String(id || '').trim()
  if (!trimmed) return []
  const raw = settingValue(KEY_POOL_SETTING(trimmed))
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const keys = cleanApiKeys(parsed.filter((item): item is string => typeof item === 'string'))
        if (keys.length) return keys
      }
    } catch {
      // 池数据损坏时回退旧版单 Key
    }
  }
  const legacy = settingValue(apiKeySetting(trimmed))
  return legacy ? [legacy] : []
}

export function setAiProviderKeys(id: string, keys: string[]): void {
  const clean = cleanApiKeys(keys)
  const encryptedPool = clean.length ? encryptCredential(JSON.stringify(clean)) : ''
  const encryptedPrimary = clean.length ? encryptCredential(clean[0]) : ''
  getDb().transaction(() => {
    if (clean.length) setSetting(KEY_POOL_SETTING(id), encryptedPool, true)
    else deleteSetting(KEY_POOL_SETTING(id))
    // 同步旧版单 Key 存储，保证回滚/旧逻辑兼容。
    if (clean.length) setSetting(apiKeySetting(id), encryptedPrimary, true)
    else deleteSetting(apiKeySetting(id))
  }).immediate()
}

function cleanApiKeys(keys: string[]): string[] {
  return [...new Set(keys.map(item => item.trim()).filter(Boolean))]
}

type AiProviderKeyChanges = Pick<AiProviderSaveInput, 'apiKey' | 'clearApiKey' | 'appendKeys' | 'removeKeyAt' | 'removeKeyIndices'>

/** Shared by saving and draft requests: clear, remove old indices, replace, append. */
export function applyAiProviderKeyChanges(existing: string[], input: AiProviderKeyChanges): string[] {
  const removed = [...(input.removeKeyIndices || []), ...(input.removeKeyAt === undefined ? [] : [input.removeKeyAt])]
  if (removed.some(index => !Number.isInteger(index) || index < 0)) throw new Error('待移除的 API Key 下标无效')
  const removalSet = new Set(removed)
  let keys = input.clearApiKey ? [] : existing.filter((_, index) => !removalSet.has(index))
  if (input.apiKey?.trim()) keys = [input.apiKey.trim()]
  return cleanApiKeys([...keys, ...(input.appendKeys || [])])
}

export function maskApiKey(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 2)}***`
  return `${key.slice(0, 6)}***${key.slice(-4)}`
}

export function defaultAiProviderBaseUrl(type: AiProviderType): string {
  if (type === 'ollama') return 'http://127.0.0.1:11434'
  if (type === 'anthropic') return 'https://api.anthropic.com/v1'
  if (type === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta'
  return 'https://api.openai.com/v1'
}

function defaultTranscriptionModel(type: AiProviderType): string {
  return type === 'openai-compatible' ? 'gpt-4o-mini-transcribe' : ''
}

function legacyProfile(): AiProviderConfig {
  const type = storedProviderType(settingValue(LEGACY_TYPE_KEY))
  const keys = getAiProviderKeys(DEFAULT_PROFILE_ID)
  return {
    id: DEFAULT_PROFILE_ID,
    name: type === 'ollama' ? '本地 Ollama' : '默认模型',
    type,
    baseUrl: settingValue(LEGACY_BASE_URL_KEY) || defaultAiProviderBaseUrl(type),
    model: settingValue(LEGACY_MODEL_KEY),
    transcriptionModel: defaultTranscriptionModel(type),
    embeddingModel: '',
    hasApiKey: keys.length > 0,
    keyCount: keys.length,
    keyPreviews: keys.map(maskApiKey),
  }
}

function storedProfiles(): AiProviderConfig[] {
  const raw = settingValue(PROFILES_KEY)
  if (!raw) return [legacyProfile()]
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [legacyProfile()]
    const profiles = parsed.filter(item => item && typeof item === 'object').map((item): AiProviderConfig => {
      const value = item as Partial<AiProviderConfig>
      const type = storedProviderType(value.type)
      const id = String(value.id || '').trim()
      const keys = getAiProviderKeys(id)
      return {
        id,
        name: String(value.name || '未命名模型'),
        type,
        baseUrl: String(value.baseUrl || defaultAiProviderBaseUrl(type)),
        model: String(value.model || ''),
        transcriptionModel: String(value.transcriptionModel ?? defaultTranscriptionModel(type)),
        embeddingModel: String(value.embeddingModel || ''),
        hasApiKey: keys.length > 0,
        keyCount: keys.length,
        keyPreviews: keys.map(maskApiKey),
      }
    }).filter(item => item.id)
    return profiles.length ? profiles : [legacyProfile()]
  } catch {
    return [legacyProfile()]
  }
}

function persistProfiles(profiles: AiProviderConfig[]): void {
  const safe = profiles.map(({ hasApiKey: _hasApiKey, keyCount: _keyCount, keyPreviews: _keyPreviews, ...profile }) => profile)
  setSetting(PROFILES_KEY, JSON.stringify(safe))
}

export function normalizeBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('模型接口地址格式无效')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型接口仅支持 HTTP 或 HTTPS')
  if (url.username || url.password) throw new Error('请勿在接口地址中写入账号或密钥')
  // Endpoints are appended to this root, so even an empty ?/# delimiter
  // would route the appended path into the query or fragment instead.
  if (url.href.includes('?') || url.href.includes('#')) {
    throw new Error('模型接口根地址不能包含查询参数或片段（? 或 #），请填写纯接口根地址')
  }
  return url.toString().replace(/\/+$/, '')
}

function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname.toLowerCase())
}

export function validateAiProviderTransport(baseUrl: string, apiKey: string): void {
  const url = new URL(baseUrl)
  if (url.protocol === 'http:' && apiKey && !isLoopback(url.hostname)) {
    throw new Error('包含 API Key 的远程接口必须使用 HTTPS，避免密钥明文传输')
  }
}

export function listAiProviderProfiles(): AiProviderConfig[] {
  return storedProfiles()
}

export function getActiveAiProvider(): { config: AiProviderConfig; apiKey: string; keys: string[] } {
  const profiles = storedProfiles()
  const activeId = settingValue(ACTIVE_PROFILE_KEY)
  const config = profiles.find(item => item.id === activeId) || profiles[0]
  const keys = getAiProviderKeys(config.id)
  return { config, apiKey: keys[0] || '', keys }
}

function resolveProfileKeys(
  current: AiProviderConfig | undefined,
  type: AiProviderType,
  baseUrl: string,
  input: AiProviderKeyChanges,
): string[] {
  let existing = current ? getAiProviderKeys(current.id) : []
  let sameEndpoint = false
  if (current?.type === type) {
    // Invalid addresses saved by older versions can still be repaired with
    // explicitly supplied replacement credentials or a cleared key pool.
    try { sameEndpoint = normalizeBaseUrl(current.baseUrl) === baseUrl } catch { /* incompatible saved endpoint */ }
  }
  if (current && !sameEndpoint) {
    const hasNewKey = Boolean(input.apiKey?.trim() || input.appendKeys?.some(key => key.trim()))
    if (existing.length > 0 && !input.clearApiKey && !hasNewKey) {
      throw new Error('切换模型接口地址或协议时，请提供新 API Key 或明确清空密钥')
    }
    // Appending an explicitly supplied key at a new endpoint must not carry
    // any saved credentials from the previous endpoint along with it.
    existing = []
  }
  const keys = applyAiProviderKeyChanges(existing, input)
  validateAiProviderTransport(baseUrl, keys[0] || '')
  return keys
}

/** Resolve draft credentials without persisting or switching any profile. */
export function resolveAiProviderDraftKeys(draft: AiProviderDraftInput): string[] {
  const type = normalizeAiProviderType(draft.type)
  const baseUrl = normalizeBaseUrl(draft.baseUrl || defaultAiProviderBaseUrl(type))
  const profileId = String(draft.profileId || '').trim()
  const current = profileId ? storedProfiles().find(profile => profile.id === profileId) : undefined
  if (profileId && !current) throw new Error('模型配置不存在')
  return resolveProfileKeys(current, type, baseUrl, draft)
}

export function saveAiProviderProfile(input: AiProviderSaveInput): AiProviderConfig {
  const profiles = storedProfiles()
  const type = normalizeAiProviderType(input.type)
  const id = String(input.id || '').trim() || crypto.randomUUID()
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('模型配置 ID 无效')
  const current = profiles.find(item => item.id === id)
  const name = String(input.name || current?.name || '我的模型').trim().slice(0, 60)
  if (!name) throw new Error('请填写配置名称')
  const baseUrl = normalizeBaseUrl(input.baseUrl || defaultAiProviderBaseUrl(type))
  const model = String(input.model || '').trim().slice(0, 200)
  if (!model) throw new Error('请填写模型名称')
  const sameType = current?.type === type
  const transcriptionModel = String(input.transcriptionModel
    ?? (sameType ? current.transcriptionModel : defaultTranscriptionModel(type))).trim().slice(0, 200)
  const embeddingModel = String(input.embeddingModel ?? (sameType ? current.embeddingModel : '')).trim().slice(0, 200)
  const keys = resolveProfileKeys(current, type, baseUrl, input)

  const profile: AiProviderConfig = { id, name, type, baseUrl, model, transcriptionModel, embeddingModel, hasApiKey: keys.length > 0, keyCount: keys.length, keyPreviews: keys.map(maskApiKey) }
  const next = current ? profiles.map(item => item.id === id ? profile : item)
    : [...profiles.filter(item => input.activate === false || item.id !== DEFAULT_PROFILE_ID || item.model), profile]
  getDb().transaction(() => {
    setAiProviderKeys(id, keys)
    persistProfiles(next)
    if (input.activate !== false) setSetting(ACTIVE_PROFILE_KEY, id)
  }).immediate()
  return profile
}

export function activateAiProviderProfile(id: string): AiProviderConfig {
  const profile = storedProfiles().find(item => item.id === id)
  if (!profile) throw new Error('模型配置不存在')
  setSetting(ACTIVE_PROFILE_KEY, profile.id)
  return profile
}

export function deleteAiProviderProfile(id: string): boolean {
  const profiles = storedProfiles()
  if (profiles.length <= 1) throw new Error('至少保留一个模型配置')
  const next = profiles.filter(item => item.id !== id)
  if (next.length === profiles.length) return false
  getDb().transaction(() => {
    persistProfiles(next)
    deleteSetting(apiKeySetting(id))
    deleteSetting(KEY_POOL_SETTING(id))
    if (settingValue(ACTIVE_PROFILE_KEY) === id) setSetting(ACTIVE_PROFILE_KEY, next[0].id)
  }).immediate()
  return true
}

export function duplicateAiProviderProfile(id: string): AiProviderConfig {
  const profiles = storedProfiles()
  const current = profiles.find(profile => profile.id === id)
  if (!current) throw new Error('模型配置不存在')
  const keys = getAiProviderKeys(id)
  const nameRoot = current.name.slice(0, 48)
  let name = `${nameRoot}（副本）`
  for (let suffix = 2; profiles.some(profile => profile.name === name); suffix++) name = `${nameRoot}（副本 ${suffix}）`
  const duplicated: AiProviderConfig = {
    ...current,
    id: crypto.randomUUID(),
    name,
    hasApiKey: keys.length > 0,
    keyCount: keys.length,
    keyPreviews: keys.map(maskApiKey),
  }
  getDb().transaction(() => {
    setAiProviderKeys(duplicated.id, keys)
    persistProfiles([...profiles, duplicated])
  }).immediate()
  return duplicated
}

function usageRows(): AiProviderUsage[] {
  try {
    const parsed = JSON.parse(settingValue(USAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function getAiProviderUsage(): AiProviderUsage[] {
  return usageRows()
}

export function recordAiProviderUsage(profileId: string, inputCharacters: number, outputCharacters: number, latencyMs: number, failed: boolean): void {
  const rows = usageRows()
  const existing = rows.find(item => item.profileId === profileId) || {
    profileId, requestCount: 0, failureCount: 0, inputCharacters: 0, outputCharacters: 0,
  }
  existing.requestCount++
  if (failed) existing.failureCount++
  existing.inputCharacters += Math.max(0, Math.trunc(inputCharacters))
  existing.outputCharacters += Math.max(0, Math.trunc(outputCharacters))
  existing.lastLatencyMs = Math.max(0, Math.trunc(latencyMs))
  existing.lastUsedAt = Date.now()
  if (!rows.some(item => item.profileId === profileId)) rows.push(existing)
  setSetting(USAGE_KEY, JSON.stringify(rows))
}
