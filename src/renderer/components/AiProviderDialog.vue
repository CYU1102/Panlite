<template>
  <el-dialog :model-value="modelValue" title="AI 模型管理" width="720px" @update:model-value="$emit('update:modelValue', $event)" @open="loadProfiles">
    <div class="provider-manager">
      <aside>
        <div class="provider-title"><strong>模型配置</strong><button title="新增配置" @click="newProfile"><Plus :size="14" /></button></div>
        <button v-for="profile in profiles" :key="profile.id" class="profile-item" :class="{ active: form.id === profile.id }" @click="editProfile(profile)">
          <span><Bot :size="15" /></span><span><strong>{{ profile.name }}</strong><small>{{ profile.model || '未配置模型' }}</small></span><CircleCheck v-if="profile.id === activeConfig.id" :size="14" />
        </button>
      </aside>
      <section class="provider-form">
        <div class="safe-note"><ShieldCheck :size="18" /><span>API Key 使用系统安全存储加密。图片、扫描件和音视频只会在主动解析时发送；填写 Embedding 模型后，文档片段也会发送给当前服务以建立语义索引。</span></div>
        <label><span>配置名称</span><el-input v-model="form.name" placeholder="例如：日常模型" /></label>
        <label><span>接口类型</span><el-radio-group v-model="form.type" @change="applyPreset"><el-radio-button value="openai-compatible">OpenAI 兼容</el-radio-button><el-radio-button value="ollama">本地 Ollama</el-radio-button></el-radio-group></label>
        <label><span>接口地址</span><el-input v-model="form.baseUrl" /></label>
        <label><span>问答 / OCR 模型</span><el-input v-model="form.model" :placeholder="form.type === 'ollama' ? '例如 qwen3:8b' : '填写支持的模型 ID'" /></label>
        <label v-if="form.type === 'openai-compatible'"><span>音视频转写模型</span><el-input v-model="form.transcriptionModel" placeholder="例如 gpt-4o-mini-transcribe" /></label>
        <label><span>Embedding 模型 <small>可选，启用语义混合检索</small></span><el-input v-model="form.embeddingModel" :placeholder="form.type === 'ollama' ? '例如 nomic-embed-text' : '例如 text-embedding-3-small'" /></label>
        <label><span>API Key <small>{{ editing?.hasApiKey ? '已保存，留空表示保留' : '本地 Ollama 可留空' }}</small></span><el-input v-model="form.apiKey" type="password" show-password autocomplete="off" placeholder="输入新的 API Key" /></label>
        <el-checkbox v-if="editing?.hasApiKey" v-model="form.clearApiKey">删除已保存的 API Key</el-checkbox>
        <div v-if="currentUsage" class="usage-card"><span><strong>{{ currentUsage.requestCount }}</strong>次请求</span><span><strong>{{ currentUsage.failureCount }}</strong>次失败</span><span><strong>{{ formatCharacters(currentUsage.inputCharacters + currentUsage.outputCharacters) }}</strong>处理字符</span><span><strong>{{ currentUsage.lastLatencyMs || 0 }} ms</strong>最近耗时</span></div>
      </section>
    </div>
    <template #footer>
      <el-button v-if="editing && profiles.length > 1" type="danger" plain @click="removeProfile">删除</el-button>
      <span class="footer-spacer"></span>
      <el-button :loading="testing" @click="testConnection">测试连接</el-button>
      <el-button v-if="editing && editing.id !== activeConfig.id" @click="activateProfile">设为当前</el-button>
      <el-button type="primary" :loading="saving" @click="saveProfile">保存并使用</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Bot, CircleCheck, Plus, ShieldCheck } from 'lucide-vue-next'
import type { AiProviderConfig, AiProviderType, AiProviderUsage } from '@shared/ai-types'
import { electronApi } from '../api/ipc'

const props = defineProps<{ modelValue: boolean; activeConfig: AiProviderConfig }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; updated: [config: AiProviderConfig] }>()
const profiles = ref<AiProviderConfig[]>([])
const usage = ref<AiProviderUsage[]>([])
const editing = ref<AiProviderConfig | null>(null)
const saving = ref(false)
const testing = ref(false)
const form = reactive({ id: '', name: '', type: 'openai-compatible' as AiProviderType, baseUrl: 'https://api.openai.com/v1', model: '', transcriptionModel: 'gpt-4o-mini-transcribe', embeddingModel: '', apiKey: '', clearApiKey: false })
const currentUsage = computed(() => usage.value.find(item => item.profileId === form.id))

function formatCharacters(value: number) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value) }
function editProfile(profile: AiProviderConfig) { editing.value = profile; Object.assign(form, { ...profile, apiKey: '', clearApiKey: false }) }
function newProfile() { editing.value = null; Object.assign(form, { id: '', name: '新模型', type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: '', transcriptionModel: 'gpt-4o-mini-transcribe', embeddingModel: '', apiKey: '', clearApiKey: false }) }
function applyPreset() { form.baseUrl = form.type === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1' }
async function loadProfiles() {
  const [list, stats] = await Promise.all([electronApi.aiProviderList(), electronApi.aiProviderUsage()])
  if (list.success) profiles.value = list.profiles || []
  if (stats.success) usage.value = stats.usage || []
  editProfile(profiles.value.find(item => item.id === props.activeConfig.id) || profiles.value[0] || props.activeConfig)
}
async function saveProfile(showMessage = true) {
  saving.value = true
  try {
    const result = await electronApi.aiProviderSave({ ...form, id: form.id || undefined })
    if (!result.success || !result.config) throw new Error(result.error || '保存失败')
    emit('updated', result.config)
    if (showMessage) ElMessage.success('模型配置已保存并启用')
    await loadProfiles()
    return true
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return false }
  finally { saving.value = false }
}
async function testConnection() {
  testing.value = true
  try {
    if (!await saveProfile(false)) return
    const result = await electronApi.aiProviderTest()
    if (!result.success) throw new Error(result.error || '连接失败')
    ElMessage.success(result.message || '连接成功')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)) }
  finally { testing.value = false }
}
async function activateProfile() {
  if (!editing.value) return
  const result = await electronApi.aiProviderActivate(editing.value.id)
  if (!result.success || !result.config) return ElMessage.error(result.error || '切换失败')
  emit('updated', result.config)
  ElMessage.success(`已切换到 ${result.config.name}`)
}
async function removeProfile() {
  if (!editing.value) return
  try { await ElMessageBox.confirm(`删除模型配置“${editing.value.name}”？`, '删除模型配置', { type: 'warning' }) } catch { return }
  const result = await electronApi.aiProviderDelete(editing.value.id)
  if (!result.success) return ElMessage.error(result.error || '删除失败')
  await loadProfiles()
  const active = profiles.value.find(item => item.id === props.activeConfig.id) || profiles.value[0]
  if (active) emit('updated', active)
  ElMessage.success('模型配置已删除')
}
</script>

<style scoped>
.provider-manager{display:grid;grid-template-columns:210px minmax(0,1fr);min-height:430px;border:1px solid #e2e8f1;border-radius:13px;overflow:hidden}.provider-manager>aside{padding:13px;background:#f7f9fc;border-right:1px solid #e4e9f1}.provider-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.provider-title button{width:27px;height:27px;display:grid;place-items:center;border:1px solid #dce4ef;border-radius:8px;color:#4772c8;background:#fff;cursor:pointer}.profile-item{display:grid;grid-template-columns:30px minmax(0,1fr) 18px;align-items:center;gap:7px;width:100%;margin-bottom:5px;padding:8px;border:1px solid transparent;border-radius:9px;color:#5f6d82;background:transparent;text-align:left;cursor:pointer}.profile-item.active{border-color:#c8d9f6;background:#fff;color:#315fae}.profile-item>span:first-child{width:30px;height:30px;display:grid;place-items:center;border-radius:8px;background:#eaf1ff}.profile-item>span:nth-child(2){display:flex;min-width:0;flex-direction:column}.profile-item strong,.profile-item small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.profile-item strong{font-size:11px}.profile-item small{margin-top:3px;color:#8b96a6;font-size:9px}.provider-form{display:flex;flex-direction:column;gap:12px;padding:18px}.provider-form label{display:flex;flex-direction:column;gap:6px;color:#4d596c;font-size:11px;font-weight:700}.provider-form label small{margin-left:5px;color:#929baa;font-weight:400}.safe-note{display:flex;gap:8px;padding:10px;border-radius:9px;color:#527263;background:#edf7f3;font-size:10px;line-height:1.5}.safe-note svg{flex:none}.usage-card{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:auto}.usage-card span{display:flex;flex-direction:column;padding:8px;border-radius:8px;color:#8a95a5;background:#f5f7fa;font-size:9px}.usage-card strong{margin-bottom:3px;color:#40506a;font-size:12px}.footer-spacer{display:inline-block;min-width:220px}@media(max-width:760px){.provider-manager{grid-template-columns:1fr}.provider-manager>aside{max-height:150px;overflow:auto;border-right:0;border-bottom:1px solid #e4e9f1}.usage-card{grid-template-columns:repeat(2,1fr)}.footer-spacer{display:none}}
</style>
