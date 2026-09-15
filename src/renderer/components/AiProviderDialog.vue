<template>
  <el-dialog :model-value="modelValue" title="AI 模型管理" class="ai-provider-dialog" width="820px" top="24px" :before-close="confirmClose" @update:model-value="$emit('update:modelValue', $event)">
    <div class="manager-summary"><span>当前使用：<strong>{{ activeConfig.name }}</strong></span><span v-if="isDirty" class="draft-note">有未保存的更改</span></div>
    <div class="provider-manager">
      <aside>
        <div class="provider-title"><strong>模型配置</strong><button title="新增配置" :disabled="mutating" @click="newProfile"><Plus :size="14" /></button></div>
        <button v-for="profile in profiles" :key="profile.id" class="profile-item" :class="{ active: form.id === profile.id }" :disabled="mutating" @click="selectProfile(profile)">
          <span><Bot :size="15" /></span><span><strong>{{ profile.name }}</strong><small>{{ profile.model || '未配置模型' }}</small></span><CircleCheck v-if="profile.id === activeConfig.id" :size="14" aria-label="当前使用" />
        </button>
      </aside>
      <fieldset class="provider-form" :disabled="mutating">
        <div class="safe-note"><ShieldCheck :size="18" /><span>API Key 使用系统安全存储加密。图片、扫描件和音视频只会在主动解析时发送；启用 Embedding 后，文档片段也会发送给当前服务建立语义索引。</span></div>
        <div class="preset-section">
          <span class="preset-label">服务商预设</span>
          <div class="preset-chips">
            <button v-for="preset in AI_PROVIDER_PRESETS" :key="preset.id" class="preset-chip" :class="{ active: selectedPresetId === preset.id }" :title="preset.baseUrl" type="button" @click="applyPreset(preset)">{{ preset.name }}</button>
            <button class="preset-chip" :class="{ active: selectedPresetId === 'custom' }" type="button" @click="selectedPresetId = 'custom'">自定义</button>
          </div>
          <div v-if="activePreset && (activePreset.homepage || activePreset.apiKeyUrl)" class="preset-links">
            <el-button v-if="activePreset.homepage" link type="primary" @click="openLink(activePreset.homepage)"><ExternalLink :size="12" /> 官网</el-button>
            <el-button v-if="activePreset.apiKeyUrl" link type="primary" @click="openLink(activePreset.apiKeyUrl)"><KeyRound :size="12" /> API Key 页面</el-button>
          </div>
        </div>
        <label><span>配置名称</span><el-input v-model="form.name" placeholder="例如：日常模型" /></label>
        <label><span>接口类型</span><el-select v-model="form.type" aria-label="接口类型" @change="onTypeChange"><el-option v-for="protocol in protocols" :key="protocol.value" :value="protocol.value" :label="protocol.label" /></el-select></label>
        <label><span>接口地址</span><el-input v-model="form.baseUrl" aria-label="接口地址" @input="syncPresetSelection" /></label>
        <label>
          <span>问答 / OCR 模型</span>
          <div class="model-row">
            <el-select v-model="form.model" filterable allow-create default-first-option :loading="loadingModels" aria-label="问答模型" placeholder="输入模型名，或从接口获取模型列表">
              <el-option v-for="item in modelOptions" :key="item" :label="item" :value="item" />
            </el-select>
            <button class="refresh-btn" :disabled="loadingModels" title="从接口获取模型列表" type="button" @click="fetchModels"><RefreshCw :size="13" /></button>
          </div>
        </label>
        <label v-if="supportsTranscription"><span>音视频转写模型 <small>可选，需服务商支持</small></span><el-input v-model="form.transcriptionModel" placeholder="填写服务商支持的转写模型" /></label>
        <label v-if="supportsEmbedding"><span>Embedding 模型 <small>可选，启用语义混合检索</small></span><el-input v-model="form.embeddingModel" placeholder="填写服务商支持的 Embedding 模型" /></label>
        <div v-if="!supportsEmbedding" class="capability-note">此协议目前接入问答和图像请求，暂不支持音视频转写与 Embedding。</div>
        <div v-else-if="!supportsTranscription" class="capability-note">Ollama 暂不支持音视频转写；图像识别需要具备视觉能力的模型。</div>
        <label>
          <span>API Key <small>{{ editing?.hasApiKey ? `已保存 ${editing.keyCount || 1} 个 Key，留空表示保留` : '本地 Ollama 可留空' }}</small></span>
          <el-input v-model="form.apiKey" type="password" show-password autocomplete="off" placeholder="输入新的 API Key（将替换现有 Key 池）" />
        </label>
        <div v-if="editing?.keyPreviews?.length" class="key-pool">
          <div v-for="(preview, index) in editing.keyPreviews" :key="`${preview}-${index}`" class="key-pool-item" :class="{ 'key-pending-delete': form.clearApiKey || form.removeKeyIndices.includes(index) }">
            <KeyRound :size="12" /><code>{{ preview }}</code><small v-if="form.clearApiKey || form.removeKeyIndices.includes(index)">待删除</small>
            <button type="button" :disabled="form.clearApiKey" :title="form.removeKeyIndices.includes(index) ? '撤销删除该 Key' : '删除该 Key'" @click="toggleKeyRemoval(index)"><span v-if="form.removeKeyIndices.includes(index)">撤销</span><X v-else :size="12" /></button>
          </div>
        </div>
        <label><span>追加 Key <small>每行一个，保存时并入 Key 池</small></span><el-input v-model="form.appendKeysText" type="textarea" :rows="2" autocomplete="off" placeholder="每行一个 Key；测试也使用这份草稿" /></label>
        <el-checkbox v-if="editing?.hasApiKey" v-model="form.clearApiKey">删除已保存的全部 Key</el-checkbox>
        <div class="capability-note">Key 的追加和删除在保存后生效；测试、模型列表与余额查询使用当前草稿。</div>
        <div v-if="editing?.hasApiKey" class="capability-note">更改协议或接口地址后，请输入或追加新的 Key，或明确清空 Key 池；原有 Key 不会自动带到新接口。</div>
        <div v-if="currentUsage" class="usage-card"><span><strong>{{ currentUsage.requestCount }}</strong>次请求</span><span><strong>{{ currentUsage.failureCount }}</strong>次失败</span><span><strong>{{ formatCharacters(currentUsage.inputCharacters + currentUsage.outputCharacters) }}</strong>处理字符</span><span><strong>{{ currentUsage.lastLatencyMs || 0 }} ms</strong>最近耗时</span></div>
        <div v-if="testMessage" class="test-result" role="status">{{ testMessage }}</div>
        <div v-if="balanceText" class="balance-line"><Wallet :size="13" /><span>{{ balanceText }}</span></div>
      </fieldset>
    </div>
    <template #footer>
      <div class="provider-footer">
        <el-button v-if="editing && profiles.length > 1" type="danger" plain :disabled="mutating" @click="removeProfile">删除</el-button>
        <el-button v-if="editing" :disabled="mutating" @click="duplicateProfile">复制配置</el-button>
        <span class="footer-spacer"></span>
        <el-button :loading="testing" :disabled="mutating" @click="testConnection">测试问答接口</el-button>
        <el-button v-if="supportsBalance" :loading="queryingBalance" :disabled="mutating" @click="queryBalance">查余额</el-button>
        <el-button v-if="editing && editing.id !== activeConfig.id" :disabled="mutating" @click="activateProfile">使用已保存配置</el-button>
        <el-button :loading="mutation === 'save'" :disabled="mutating" @click="saveProfile(false)">保存</el-button>
        <el-button type="primary" :loading="mutation === 'save-and-use'" :disabled="mutating" @click="saveProfile(true)">保存并使用</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs'
import { Bot, CircleCheck, ExternalLink, KeyRound, Plus, RefreshCw, ShieldCheck, Wallet, X } from 'lucide-vue-next'
import type { AiProviderConfig, AiProviderDraftInput, AiProviderType, AiProviderUsage } from '@shared/ai-types'
import { AI_PROVIDER_PRESETS, findAiProviderPresetByBaseUrl, type AiProviderPreset } from '@shared/ai-provider-presets'
import { electronApi } from '../api/ipc'

const props = defineProps<{ modelValue: boolean; activeConfig: AiProviderConfig }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; updated: [config: AiProviderConfig] }>()
const protocols: Array<{ value: AiProviderType; label: string; baseUrl: string }> = [
  { value: 'openai-compatible', label: 'OpenAI Chat Completions', baseUrl: 'https://api.openai.com/v1' },
  { value: 'openai-responses', label: 'OpenAI Responses', baseUrl: 'https://api.openai.com/v1' },
  { value: 'anthropic', label: 'Anthropic Messages', baseUrl: 'https://api.anthropic.com/v1' },
  { value: 'gemini', label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { value: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434' },
]
const profiles = ref<AiProviderConfig[]>([])
const activeConfig = ref<AiProviderConfig>(props.activeConfig)
const usage = ref<AiProviderUsage[]>([])
const editing = ref<AiProviderConfig | null>(null)
const mutation = ref('')
const mutating = computed(() => mutation.value !== '')
const testing = ref(false)
const loadingModels = ref(false)
const queryingBalance = ref(false)
const balanceText = ref('')
const testMessage = ref('')
const modelOptions = ref<string[]>([])
const selectedPresetId = ref('custom')
const form = reactive({ id: '', name: '新模型', type: 'openai-compatible' as AiProviderType, baseUrl: 'https://api.openai.com/v1', model: '', transcriptionModel: '', embeddingModel: '', apiKey: '', appendKeysText: '', clearApiKey: false, removeKeyIndices: [] as number[] })
const baseline = ref(JSON.stringify(form))
const isDirty = computed(() => JSON.stringify(form) !== baseline.value)
const currentUsage = computed(() => usage.value.find(item => item.profileId === form.id))
const activePreset = computed(() => AI_PROVIDER_PRESETS.find(item => item.id === selectedPresetId.value) || null)
const supportsTranscription = computed(() => ['openai-compatible', 'openai-responses'].includes(form.type))
const supportsEmbedding = computed(() => supportsTranscription.value || form.type === 'ollama')
const supportsBalance = computed(() => ['openai-compatible', 'openai-responses'].includes(form.type))
let draftRevision = 0
let loadRevision = 0
const requests = { models: 0, test: 0, balance: 0 }

function invalidateDraftRequests() {
  draftRevision++
  testing.value = false
  loadingModels.value = false
  queryingBalance.value = false
  balanceText.value = ''
  testMessage.value = ''
  modelOptions.value = form.model ? [form.model] : []
}
watch(form, invalidateDraftRequests, { deep: true, flush: 'sync' })
watch(() => props.activeConfig, config => { activeConfig.value = config }, { deep: true })
watch(() => props.modelValue, open => {
  if (open) void loadProfiles()
  else { loadRevision++; invalidateDraftRequests() }
}, { immediate: true })

function formatCharacters(value: number) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value) }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }
function syncPresetSelection() { selectedPresetId.value = findAiProviderPresetByBaseUrl(form.baseUrl, form.type)?.id || 'custom' }
function setEditingProfile(profile: AiProviderConfig | null) {
  invalidateDraftRequests()
  editing.value = profile
  Object.assign(form, { id: profile?.id || '', name: profile?.name || '新模型', type: profile?.type || 'openai-compatible',
    baseUrl: profile?.baseUrl || 'https://api.openai.com/v1', model: profile?.model || '', transcriptionModel: profile?.transcriptionModel || '',
    embeddingModel: profile?.embeddingModel || '', apiKey: '', appendKeysText: '', clearApiKey: false, removeKeyIndices: [] })
  baseline.value = JSON.stringify(form)
  modelOptions.value = form.model ? [form.model] : []
  syncPresetSelection()
}
async function confirmDiscard(): Promise<boolean> {
  if (mutating.value) return false
  if (!isDirty.value) return true
  try {
    await ElMessageBox.confirm('当前配置有未保存的更改，继续会丢弃这些更改。', '未保存的配置', { type: 'warning', confirmButtonText: '丢弃更改并继续', cancelButtonText: '继续编辑' })
    return true
  } catch { return false }
}
async function confirmClose(done: () => void) {
  if (await confirmDiscard()) { setEditingProfile(editing.value); done() }
}
async function selectProfile(profile: AiProviderConfig) {
  if (profile.id === form.id || !await confirmDiscard()) return
  setEditingProfile(profile)
}
async function newProfile() { if (await confirmDiscard()) setEditingProfile(null) }
function applyPreset(preset: AiProviderPreset) {
  selectedPresetId.value = preset.id
  Object.assign(form, { type: preset.type, baseUrl: preset.baseUrl, name: preset.name, model: preset.defaultModel,
    transcriptionModel: preset.defaultTranscriptionModel || '', embeddingModel: preset.defaultEmbeddingModel || '' })
}
function onTypeChange() {
  Object.assign(form, { baseUrl: protocols.find(item => item.value === form.type)!.baseUrl, model: '', transcriptionModel: '', embeddingModel: '' })
  syncPresetSelection()
}
function openLink(url: string) { void electronApi.openExternal(url) }
async function loadProfiles() {
  const revision = ++loadRevision
  const draftAtStart = draftRevision
  try {
    const list = await electronApi.aiProviderList()
    if (revision !== loadRevision || !props.modelValue) return
    if (!list.success) throw new Error(list.error || '加载配置失败')
    profiles.value = list.profiles || []
    if (list.active) activeConfig.value = list.active
    // A late list response may update the sidebar, but must not replace a draft already being edited.
    if (draftRevision === draftAtStart && !isDirty.value) {
      setEditingProfile(profiles.value.find(item => item.id === (form.id || activeConfig.value.id)) || profiles.value[0] || null)
    }
    const stats = await electronApi.aiProviderUsage()
    if (revision === loadRevision && props.modelValue && stats.success) usage.value = stats.usage || []
  } catch (error) { if (revision === loadRevision && props.modelValue) ElMessage.error(errorMessage(error)) }
}
function keyDraft() {
  return { apiKey: form.apiKey || undefined, clearApiKey: form.clearApiKey,
    appendKeys: form.appendKeysText.split('\n').map(item => item.trim()).filter(Boolean), removeKeyIndices: [...form.removeKeyIndices] }
}
function draftInput(): AiProviderDraftInput {
  return { type: form.type, baseUrl: form.baseUrl, model: form.model, profileId: editing.value?.id || undefined, ...keyDraft() }
}
function currentRequest(kind: keyof typeof requests, request: number, revision: number) {
  return props.modelValue && requests[kind] === request && draftRevision === revision
}
async function fetchModels() {
  if (!form.baseUrl.trim()) return ElMessage.warning('请先填写接口地址')
  const revision = draftRevision
  const request = ++requests.models
  loadingModels.value = true
  try {
    const result = await electronApi.aiProviderListModels(draftInput())
    if (!currentRequest('models', request, revision)) return
    if (!result.success) throw new Error(result.error || '获取模型列表失败')
    if (!result.models?.length) throw new Error('接口没有返回任何模型')
    modelOptions.value = result.models
    ElMessage.success(`已获取 ${result.models.length} 个模型`)
  } catch (error) { if (currentRequest('models', request, revision)) ElMessage.warning(`${errorMessage(error)}，可继续手动输入模型名`) }
  finally { if (currentRequest('models', request, revision)) loadingModels.value = false }
}
function acceptMutation(config: AiProviderConfig, active?: AiProviderConfig) {
  loadRevision++
  const index = profiles.value.findIndex(item => item.id === config.id)
  if (index < 0) profiles.value.push(config)
  else profiles.value[index] = config
  if (active) activeConfig.value = active
  emit('updated', activeConfig.value)
  setEditingProfile(config)
}
async function saveProfile(activate: boolean) {
  if (mutating.value) return
  mutation.value = activate ? 'save-and-use' : 'save'
  try {
    const result = await electronApi.aiProviderSave({ id: form.id || undefined, name: form.name, type: form.type,
      baseUrl: form.baseUrl, model: form.model, transcriptionModel: supportsTranscription.value ? form.transcriptionModel : '',
      embeddingModel: supportsEmbedding.value ? form.embeddingModel : '', activate, ...keyDraft() })
    if (!result.success || !result.config) throw new Error(result.error || '保存失败')
    acceptMutation(result.config, result.active)
    ElMessage.success(activate ? '模型配置已保存并启用' : '模型配置已保存，未切换当前配置')
  } catch (error) { ElMessage.error(errorMessage(error)) }
  finally { mutation.value = '' }
}
function toggleKeyRemoval(index: number) {
  form.removeKeyIndices = form.removeKeyIndices.includes(index) ? form.removeKeyIndices.filter(item => item !== index) : [...form.removeKeyIndices, index]
}
async function queryBalance() {
  const revision = draftRevision
  const request = ++requests.balance
  queryingBalance.value = true
  try {
    const result = await electronApi.aiProviderQueryBalance(draftInput())
    if (!currentRequest('balance', request, revision)) return
    if (!result.success || !result.balance) throw new Error(result.error || '查询失败')
    const { total, used, remaining, unlimited, currency } = result.balance
    if (unlimited) balanceText.value = `余额：不限量${used !== undefined ? `（本月已用 ${used.toFixed(2)} ${currency}）` : ''}`
    else if (remaining !== undefined) balanceText.value = `余额：剩余 ${remaining.toFixed(2)} ${currency}${total !== undefined ? ` / 共 ${total.toFixed(2)}` : ''}`
    else if (total !== undefined) balanceText.value = `额度：${total.toFixed(2)} ${currency}`
    else if (used !== undefined) balanceText.value = `本月已用：${used.toFixed(2)} ${currency}`
    else balanceText.value = '服务商未返回余额数据'
  } catch (error) { if (currentRequest('balance', request, revision)) { balanceText.value = ''; ElMessage.warning(errorMessage(error)) } }
  finally { if (currentRequest('balance', request, revision)) queryingBalance.value = false }
}
async function testConnection() {
  if (!form.model.trim()) return ElMessage.warning('请先填写模型名称')
  const revision = draftRevision
  const request = ++requests.test
  testing.value = true
  try {
    const result = await electronApi.aiProviderTestConfig(draftInput())
    if (!currentRequest('test', request, revision)) return
    if (!result.success) throw new Error(result.error || '连接失败')
    testMessage.value = `问答接口测试通过${result.latencyMs ? `（${result.latencyMs} ms）` : ''}；不代表 OCR、转写或 Embedding 可用。`
    ElMessage.success('问答接口测试通过')
  } catch (error) { if (currentRequest('test', request, revision)) { testMessage.value = `问答接口测试失败：${errorMessage(error)}`; ElMessage.error(errorMessage(error)) } }
  finally { if (currentRequest('test', request, revision)) testing.value = false }
}
async function activateProfile() {
  if (!editing.value || !await confirmDiscard()) return
  mutation.value = 'activate'
  try {
    const result = await electronApi.aiProviderActivate(editing.value.id)
    if (!result.success || !result.config) throw new Error(result.error || '切换失败')
    acceptMutation(result.config, result.config)
    ElMessage.success(`已切换到 ${result.config.name}`)
  } catch (error) { ElMessage.error(errorMessage(error)) }
  finally { mutation.value = '' }
}
async function duplicateProfile() {
  if (!editing.value || !await confirmDiscard()) return
  mutation.value = 'duplicate'
  try {
    const result = await electronApi.aiProviderDuplicate(editing.value.id)
    if (!result.success || !result.config) throw new Error(result.error || '复制失败')
    acceptMutation(result.config, result.active)
    ElMessage.success('已复制配置和 Key 池，可编辑副本后保存')
  } catch (error) { ElMessage.error(errorMessage(error)) }
  finally { mutation.value = '' }
}
async function removeProfile() {
  if (!editing.value || mutating.value) return
  try { await ElMessageBox.confirm(`删除模型配置“${editing.value.name}”？${isDirty.value ? '未保存的更改也会丢弃。' : ''}`, '删除模型配置', { type: 'warning' }) } catch { return }
  mutation.value = 'delete'
  try {
    const result = await electronApi.aiProviderDelete(editing.value.id)
    if (!result.success) throw new Error(result.error || '删除失败')
    const list = await electronApi.aiProviderList()
    if (!list.success || !list.active) throw new Error(list.error || '加载当前配置失败')
    profiles.value = list.profiles || []
    activeConfig.value = list.active
    emit('updated', list.active)
    setEditingProfile(profiles.value.find(item => item.id === list.active!.id) || profiles.value[0] || null)
    ElMessage.success('模型配置已删除')
  } catch (error) { ElMessage.error(errorMessage(error)) }
  finally { mutation.value = '' }
}
</script>

<style scoped>
.provider-manager{display:grid;grid-template-columns:210px minmax(0,1fr);min-height:430px;border:1px solid #e2e8f1;border-radius:13px;overflow:hidden}.provider-manager>aside{padding:13px;background:#f7f9fc;border-right:1px solid var(--pl-border)}.provider-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.provider-title button{width:27px;height:27px;display:grid;place-items:center;border:1px solid #dce4ef;border-radius:8px;color:#4772c8;background: var(--pl-surface);cursor:pointer}.profile-item{display:grid;grid-template-columns:30px minmax(0,1fr) 18px;align-items:center;gap:7px;width:100%;margin-bottom:5px;padding:8px;border:1px solid transparent;border-radius:9px;color:#5f6d82;background:transparent;text-align:left;cursor:pointer}.profile-item.active{border-color:#c8d9f6;background: var(--pl-surface);color:#315fae}.profile-item>span:first-child{width:30px;height:30px;display:grid;place-items:center;border-radius:8px;background:#eaf1ff}.profile-item>span:nth-child(2){display:flex;min-width:0;flex-direction:column}.profile-item strong,.profile-item small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.profile-item strong{font-size: var(--pl-font-xs)}.profile-item small{margin-top:3px;color:#8b96a6;font-size: var(--pl-font-xs)}.provider-form{display:flex;flex-direction:column;gap:12px;padding:18px}.provider-form label{display:flex;flex-direction:column;gap:6px;color:#4d596c;font-size: var(--pl-font-xs);font-weight:700}.provider-form label small{margin-left:5px;color:#929baa;font-weight:400}.safe-note{display:flex;gap:8px;padding:10px;border-radius:9px;color:#527263;background:#edf7f3;font-size: var(--pl-font-xs);line-height:1.5}.safe-note svg{flex:none}.preset-section{display:flex;flex-direction:column;gap:7px}.preset-label{color:#4d596c;font-size: var(--pl-font-xs);font-weight:700}.preset-chips{display:flex;flex-wrap:wrap;gap:6px}.preset-chip{padding:5px 11px;border:1px solid #dce4ef;border-radius:999px;color:#5f6d82;background: var(--pl-surface);font-size: var(--pl-font-xs);cursor:pointer;transition:all .15s ease}.preset-chip:hover{border-color:#b9cdf0;color:#315fae}.preset-chip.active{border-color:#4772c8;background:#eaf1ff;color:#315fae;font-weight:700}.preset-links{display:flex;align-items:center;gap:4px}.preset-links .el-button{margin:0;font-size: var(--pl-font-xs)}.preset-links svg{margin-right:3px}.model-row{display:grid;grid-template-columns:minmax(0,1fr) 32px;gap:6px;align-items:center}.refresh-btn{width:32px;height:32px;display:grid;place-items:center;border:1px solid #dce4ef;border-radius:6px;color:#4772c8;background: var(--pl-surface);cursor:pointer}.refresh-btn:hover{border-color:#b9cdf0}.refresh-btn:disabled{opacity:.5;cursor:wait}.usage-card{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:auto}.key-pool{display:flex;flex-direction:column;gap:4px}.key-pool-item{display:flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid var(--pl-border);border-radius:8px;color:#5f6d82;background:#f8fafc;font-size: var(--pl-font-xs)}.key-pool-item code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace}.key-pool-item button{display:grid;place-items:center;width:20px;height:20px;border:0;border-radius:6px;color:#c05050;background:transparent;cursor:pointer}.key-pool-item button:hover{background:#fdeaea}.balance-line{display:flex;align-items:center;gap:6px;padding:8px 10px;border-radius:8px;color:#315fae;background:#eaf1ff;font-size: var(--pl-font-xs);font-weight:700}.usage-card span{display:flex;flex-direction:column;padding:8px;border-radius:8px;color:#8a95a5;background:#f5f7fa;font-size: var(--pl-font-xs)}.usage-card strong{margin-bottom:3px;color:#40506a;font-size:12px}.footer-spacer{display:inline-block;min-width:220px}@media(max-width:760px){.provider-manager{grid-template-columns:1fr}.provider-manager>aside{max-height:150px;overflow:auto;border-right:0;border-bottom:1px solid var(--pl-border)}.usage-card{grid-template-columns:repeat(2,1fr)}.footer-spacer{display:none}}

/* The dialog follows the same palette as the page behind it. */
.provider-manager,.provider-form{border-color:var(--pl-border);background:var(--pl-surface)}
.provider-manager>aside{background:var(--pl-surface-subtle)}
.provider-title button,.refresh-btn{border-color:var(--pl-border);color:var(--pl-primary);background:var(--pl-surface)}
.profile-item{color:var(--pl-text-secondary)}
.profile-item.active{border-color:var(--pl-primary);color:var(--pl-primary);background:var(--pl-primary-soft)}
.profile-item>span:first-child{color:var(--pl-primary);background:var(--pl-primary-soft)}
.profile-item small,.provider-form label small{color:var(--pl-text-muted)}
.provider-form label,.preset-label{color:var(--pl-text-secondary)}
.safe-note{color:var(--pl-success);background:var(--pl-success-soft)}
.preset-chip{border-color:var(--pl-border);color:var(--pl-text-secondary);background:var(--pl-surface)}
.preset-chip:hover{border-color:var(--pl-primary);color:var(--pl-primary)}
.preset-chip.active{border-color:var(--pl-primary);color:var(--pl-primary);background:var(--pl-primary-soft)}
.refresh-btn:hover{border-color:var(--pl-primary)}
.key-pool-item{color:var(--pl-text-secondary);background:var(--pl-surface-subtle)}
.key-pool-item button{color:var(--pl-danger)}
.key-pool-item button:hover{background:var(--pl-danger-soft)}
.balance-line{color:var(--pl-primary);background:var(--pl-primary-soft)}
.usage-card span{color:var(--pl-text-muted);background:var(--pl-surface-subtle)}
.usage-card strong{color:var(--pl-text)}
.provider-form{min-width:0;margin:0;border:0}.manager-summary{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;margin-bottom:12px;color:var(--pl-text-secondary);font-size:var(--pl-font-xs)}.manager-summary strong{color:var(--pl-text)}.draft-note{color:var(--pl-warning)}.provider-footer{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px}.provider-footer .el-button{margin:0}.provider-footer .footer-spacer{flex:1;min-width:0}.capability-note{color:var(--pl-text-muted);font-size:var(--pl-font-xs);line-height:1.6}.test-result{padding:8px 10px;border-radius:8px;background:var(--pl-primary-soft);color:var(--pl-primary);font-size:var(--pl-font-xs);line-height:1.6}.key-pending-delete code{text-decoration:line-through;opacity:.6}.key-pool-item small{color:var(--pl-danger)}.key-pool-item button{width:auto;min-width:24px}.profile-item:disabled,.provider-title button:disabled{opacity:.6;cursor:wait}

/* Keep actions visible while long forms and profile lists scroll independently. */
:global(.ai-provider-dialog) {
  display:flex;
  flex-direction:column;
  width:min(820px, calc(100vw - 32px));
  height:min(760px, calc(100dvh - 48px));
  max-height:calc(100dvh - 48px);
  margin-bottom:24px;
  padding:0;
}
:global(.ai-provider-dialog .el-dialog__header),
:global(.ai-provider-dialog .el-dialog__footer) { flex:0 0 auto; }
:global(.ai-provider-dialog .el-dialog__body) {
  display:flex;
  flex:1 1 auto;
  flex-direction:column;
  min-height:0;
  overflow:hidden;
}
.manager-summary { flex:0 0 auto; }
.provider-manager { flex:1 1 auto; min-height:0; grid-template-rows:minmax(0,1fr); }
.provider-manager>aside,
.provider-form { min-height:0; overflow-y:auto; overscroll-behavior:contain; }
.provider-form>* { flex-shrink:0; }
@media(max-width:760px) {
  .provider-manager { grid-template-rows:minmax(70px,120px) minmax(0,1fr); }
  .provider-manager>aside { max-height:none; }
  :global(.ai-provider-dialog .el-dialog__body) { padding:12px; }
  :global(.ai-provider-dialog .el-dialog__footer) { padding:12px; }
}
</style>
