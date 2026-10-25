import type { AiProviderType } from './ai-types'

export type AiProviderPresetGroup = 'intl' | 'cn' | 'local'

export interface AiProviderPreset {
  id: string
  name: string
  group: AiProviderPresetGroup
  type: AiProviderType
  baseUrl: string
  defaultModel: string
  defaultTranscriptionModel?: string
  defaultEmbeddingModel?: string
  homepage: string
  apiKeyUrl: string
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    group: 'intl',
    type: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    homepage: 'https://platform.openai.com',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openai-responses',
    name: 'OpenAI Responses',
    group: 'intl',
    type: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    homepage: 'https://platform.openai.com',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    group: 'intl',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: '',
    homepage: 'https://www.anthropic.com',
    apiKeyUrl: 'https://platform.claude.com/settings/keys',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    group: 'intl',
    type: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: '',
    homepage: 'https://ai.google.dev',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    group: 'intl',
    type: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: '',
    homepage: 'https://x.ai',
    apiKeyUrl: 'https://console.x.ai',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    group: 'cn',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: '',
    homepage: 'https://www.deepseek.com',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    group: 'cn',
    type: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: '',
    homepage: 'https://open.bigmodel.cn',
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    group: 'cn',
    type: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: '',
    homepage: 'https://www.moonshot.cn',
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    group: 'cn',
    type: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: '',
    homepage: 'https://siliconflow.cn',
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'bailian',
    name: '阿里云百炼',
    group: 'cn',
    type: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: '',
    homepage: 'https://www.aliyun.com/product/bailian',
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'volcengine-ark',
    name: '火山方舟豆包',
    group: 'cn',
    type: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '',
    homepage: 'https://www.volcengine.com/product/ark',
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    group: 'cn',
    type: 'openai-compatible',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: '',
    homepage: 'https://www.minimaxi.com',
    apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'modelscope',
    name: 'ModelScope',
    group: 'cn',
    type: 'openai-compatible',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    defaultModel: '',
    homepage: 'https://www.modelscope.cn',
    apiKeyUrl: 'https://www.modelscope.cn/my/myaccesstoken',
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    group: 'local',
    type: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    defaultModel: '',
    homepage: 'https://ollama.com',
    apiKeyUrl: '',
  },
]

export function findAiProviderPresetByBaseUrl(baseUrl: string, type: AiProviderType): AiProviderPreset | null {
  const normalized = baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  return AI_PROVIDER_PRESETS.find(item => item.type === type && item.baseUrl.toLowerCase() === normalized) || null
}
