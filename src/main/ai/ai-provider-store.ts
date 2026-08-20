import crypto from 'node:crypto'
import { decryptCredential, encryptCredential } from '../crypto'
import { deleteSetting, getSetting, setSetting } from '../db'
import type { AiProviderConfig, AiProviderSaveInput, AiProviderUsage } from '../../shared/ai-types'

const PROFILES_KEY = 'aiProviderProfilesV2'
const ACTIVE_PROFILE_KEY = 'aiProviderActiveProfileV2'
const USAGE_KEY = 'aiProviderUsageV2'
const LEGACY_TYPE_KEY = 'aiProviderType'
const LEGACY_BASE_URL_KEY = 'aiProviderBaseUrl'
const LEGACY_MODEL_KEY = 'aiProviderModel'
const LEGACY_API_KEY = 'aiProviderApiKey'
const DEFAULT_PROFILE_ID = 'default'

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

function defaultBaseUrl(type: AiProviderConfig['type']): string {
  return type === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1'
}

function legacyProfile(): AiProviderConfig {
  const type = settingValue(LEGACY_TYPE_KEY) === 'ollama' ? 'ollama' : 'openai-compatible'
  return {
    id: DEFAULT_PROFILE_ID,
    name: type === 'ollama' ? '本地 Ollama' : '默认模型',
    type,
    baseUrl: settingValue(LEGACY_BASE_URL_KEY) || defaultBaseUrl(type),
    model: settingValue(LEGACY_MODEL_KEY),
    transcriptionModel: 'gpt-4o-mini-transcribe',
    embeddingModel: '',
    hasApiKey: Boolean(settingValue(LEGACY_API_KEY)),
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
      const type = value.type === 'ollama' ? 'ollama' : 'openai-compatible'
      const id = String(value.id || '').trim()
      return {
        id,
        name: String(value.name || '未命名模型'),
        type,
        baseUrl: String(value.baseUrl || defaultBaseUrl(type)),
        model: String(value.model || ''),
        transcriptionModel: String(value.transcriptionModel || 'gpt-4o-mini-transcribe'),
        embeddingModel: String(value.embeddingModel || ''),
        hasApiKey: Boolean(settingValue(apiKeySetting(id))),
      }
    }).filter(item => item.id)
    return profiles.length ? profiles : [legacyProfile()]
  } catch {
    return [legacyProfile()]
  }
}

function persistProfiles(profiles: AiProviderConfig[]): void {
  const safe = profiles.map(({ hasApiKey: _hasApiKey, ...profile }) => profile)
  setSetting(PROFILES_KEY, JSON.stringify(safe))
}

function normalizeBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('模型接口地址格式无效')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型接口仅支持 HTTP 或 HTTPS')
  if (url.username || url.password) throw new Error('请勿在接口地址中写入账号或密钥')
  return url.toString().replace(/\/+$/, '')
}

function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase())
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

export function getActiveAiProvider(): { config: AiProviderConfig; apiKey: string } {
  const profiles = storedProfiles()
  const activeId = settingValue(ACTIVE_PROFILE_KEY)
  const config = profiles.find(item => item.id === activeId) || profiles[0]
  return { config, apiKey: settingValue(apiKeySetting(config.id)) }
}

export function saveAiProviderProfile(input: AiProviderSaveInput): AiProviderConfig {
  const profiles = storedProfiles()
  const type = input.type === 'ollama' ? 'ollama' : 'openai-compatible'
  const id = String(input.id || '').trim() || crypto.randomUUID()
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('模型配置 ID 无效')
  const current = profiles.find(item => item.id === id)
  const name = String(input.name || current?.name || '我的模型').trim().slice(0, 60)
  if (!name) throw new Error('请填写配置名称')
  const baseUrl = normalizeBaseUrl(input.baseUrl || defaultBaseUrl(type))
  const model = String(input.model || '').trim().slice(0, 200)
  if (!model) throw new Error('请填写模型名称')
  const transcriptionModel = String(input.transcriptionModel || current?.transcriptionModel || 'gpt-4o-mini-transcribe').trim().slice(0, 200)
  const embeddingModel = String(input.embeddingModel ?? current?.embeddingModel ?? '').trim().slice(0, 200)
  const keyName = apiKeySetting(id)
  const currentKey = settingValue(keyName)
  const apiKey = input.clearApiKey ? '' : input.apiKey?.trim() || currentKey
  validateAiProviderTransport(baseUrl, apiKey)
  if (input.clearApiKey) setSetting(keyName, '')
  else if (input.apiKey?.trim()) setSetting(keyName, encryptCredential(input.apiKey.trim()), true)

  const profile: AiProviderConfig = { id, name, type, baseUrl, model, transcriptionModel, embeddingModel, hasApiKey: Boolean(apiKey) }
  const next = current ? profiles.map(item => item.id === id ? profile : item) : [...profiles.filter(item => item.id !== DEFAULT_PROFILE_ID || item.model), profile]
  persistProfiles(next)
  setSetting(ACTIVE_PROFILE_KEY, id)
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
  persistProfiles(next)
  deleteSetting(apiKeySetting(id))
  if (settingValue(ACTIVE_PROFILE_KEY) === id) setSetting(ACTIVE_PROFILE_KEY, next[0].id)
  return true
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
