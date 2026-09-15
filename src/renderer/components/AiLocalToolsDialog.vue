<template>
  <el-dialog :model-value="modelValue" class="local-tools-dialog" title="本地 AI 能力包" width="min(720px, 94vw)" top="5vh" @update:model-value="$emit('update:modelValue', $event)" @open="load">
    <section class="processing-policy">
      <h3>模型使用方式</h3>
      <p>优先使用本地文本提取、OCR 和字幕。以下选项默认关闭；主动发起文档问答仍需调用你配置的模型。</p>
      <label><span><strong>允许模型补充识别</strong><small>本地提取失败后交给当前 AI 服务，可能上传文件内容并产生费用。</small></span><el-switch v-model="policy.allowModelFallback" aria-label="允许模型补充识别" :disabled="policyLoading || policySaving || !policyLoaded" /></label>
      <label><span><strong>启用语义向量索引</strong><small>默认使用本地关键词索引；启用后使用嵌入模型，远程服务可能接收内容并计费。</small></span><el-switch v-model="policy.useSemanticIndex" aria-label="启用语义向量索引" :disabled="policyLoading || policySaving || !policyLoaded" /></label>
      <div class="policy-actions"><span v-if="policyLoading">正在读取处理方式…</span><span v-else-if="!policyLoaded">处理方式读取失败，请重新检测。</span><el-button :loading="policySaving" :disabled="policyLoading || !policyLoaded" @click="savePolicy">保存处理方式</el-button></div>
    </section>
    <div class="tool-note"><ShieldCheck :size="18" /><span>本地工具由你自行安装，PanLite 只调用已配置的可执行文件，不会自动安装这些工具。图片和扫描 PDF 可用 Tesseract 离线识别；本地语音转写仍需 Whisper 模型，Python Whisper 首次转写可能下载模型。</span></div>
    <div class="tool-list">
      <article v-for="tool in toolRows" :key="tool.key">
        <span class="tool-icon"><component :is="tool.icon" :size="18" /></span>
        <div class="tool-copy"><strong>{{ tool.name }}</strong><small>{{ tool.description }}</small><small v-if="statusFor(tool.key)?.message">{{ statusFor(tool.key)?.message }}</small><code v-if="statusFor(tool.key)?.version">{{ statusFor(tool.key)?.version }}</code></div>
        <span class="tool-state" :class="{ ready: statusFor(tool.key)?.ready }">{{ statusFor(tool.key)?.ready ? '工具已就绪' : statusFor(tool.key)?.resolvedPath ? '需配置或修复' : '未检测到' }}</span>
        <div class="tool-path"><el-input v-model="config[tool.field]" clearable :placeholder="`留空则自动检测 ${tool.name}`" /><el-button @click="selectTool(tool.field)"><FolderOpen :size="14" />选择</el-button></div>
      </article>
    </div>
    <div class="tool-options">
      <label><span>OCR 语言</span><el-input v-model="config.ocrLanguage" placeholder="chi_sim+eng" /></label>
      <label><span>Whisper 模型名称</span><el-input v-model="config.whisperModel" placeholder="small" /></label>
      <label><span>whisper.cpp GGML 模型</span><div><el-input v-model="config.whisperModelPath" clearable /><el-button @click="selectTool('whisperModelPath')">选择</el-button></div></label>
    </div>
    <template #footer><el-button :loading="loading || policyLoading" :disabled="saving || policySaving" @click="load">重新检测</el-button><el-button type="primary" :loading="saving" :disabled="loading" @click="save">保存工具配置</el-button></template>
  </el-dialog>
</template>

<script setup lang="ts">
import { markRaw, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Captions, FileCog, FolderOpen, ScanText, ShieldCheck, Waves } from 'lucide-vue-next'
import type { AiLocalToolKey, AiLocalToolStatus, AiLocalToolsConfig } from '@shared/ai-types'
import { DEFAULT_AI_PROCESSING_POLICY, type AiProcessingPolicy } from '@shared/ai-processing-policy'
import { electronApi } from '../api/ipc'

defineProps<{ modelValue: boolean }>()
const emit=defineEmits<{ 'update:modelValue': [value: boolean]; updated: [tools: AiLocalToolStatus[]]; policyUpdated: [policy: AiProcessingPolicy] }>()
const loading = ref(false), saving = ref(false), statuses = ref<AiLocalToolStatus[]>([])
const policy = reactive<AiProcessingPolicy>({ ...DEFAULT_AI_PROCESSING_POLICY })
const policyLoading = ref(false), policySaving = ref(false), policyLoaded = ref(false)
const config = reactive<AiLocalToolsConfig>({ tesseractPath: '', pdftoppmPath: '', ffmpegPath: '', whisperPath: '', libreOfficePath: '', ocrLanguage: 'chi_sim+eng', whisperModel: 'small', whisperModelPath: '' })
const toolRows = [
  { key: 'tesseract' as const, field: 'tesseractPath' as const, name: 'Tesseract OCR', description: '图片离线 OCR；建议安装中文和英文语言包', icon: markRaw(ScanText) },
  { key: 'pdftoppm' as const, field: 'pdftoppmPath' as const, name: 'PDF 页面渲染器', description: 'Poppler pdftoppm 将扫描 PDF 页面转成图像，再由 Tesseract 本地识别', icon: markRaw(FileCog) },
  { key: 'ffmpeg' as const, field: 'ffmpegPath' as const, name: 'FFmpeg', description: '优先提取视频内嵌字幕，并为 Whisper 提取音轨', icon: markRaw(Captions) },
  { key: 'whisper' as const, field: 'whisperPath' as const, name: 'Whisper', description: '支持 whisper.cpp 或 OpenAI Whisper CLI 本地转写', icon: markRaw(Waves) },
  { key: 'libreoffice' as const, field: 'libreOfficePath' as const, name: 'LibreOffice', description: '将 DOC/XLS/PPT 转换后高精度提取', icon: markRaw(FileCog) },
]
function statusFor(key: AiLocalToolKey) { return statuses.value.find(item => item.key === key) }
async function load() { await Promise.all([loadTools(), loadPolicy()]) }
async function loadTools() { if (loading.value || saving.value) return; loading.value = true; try { const result = await electronApi.aiLocalToolsGet(); if (!result.success) throw new Error(result.error || '检测失败'); if (result.config) Object.assign(config, result.config); statuses.value = result.tools || []; emit('updated', statuses.value) } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)) } finally { loading.value = false } }
async function loadPolicy() {
  if (policyLoading.value || policySaving.value) return
  policyLoading.value = true
  policyLoaded.value = false
  try {
    const result = await electronApi.aiProcessingPolicyGet()
    if (!result.success || !result.policy) throw new Error(result.error || '读取处理方式失败')
    Object.assign(policy, result.policy)
    policyLoaded.value = true
    emit('policyUpdated', { ...policy })
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)) }
  finally { policyLoading.value = false }
}
async function savePolicy() {
  if (policySaving.value || policyLoading.value || !policyLoaded.value) return
  policySaving.value = true
  try {
    const result = await electronApi.aiProcessingPolicySave({ ...policy })
    if (!result.success || !result.policy) throw new Error(result.error || '保存处理方式失败')
    Object.assign(policy, result.policy)
    emit('policyUpdated', { ...policy })
    ElMessage.success('模型使用方式已保存')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)) }
  finally { policySaving.value = false }
}
async function selectTool(field: keyof AiLocalToolsConfig) { const result = await electronApi.aiLocalToolsSelect(field); if (result.success && result.filePath) config[field] = result.filePath }
async function save() { if (saving.value || loading.value) return; saving.value = true; try { const result = await electronApi.aiLocalToolsSave({ ...config }); if (!result.success) throw new Error(result.error || '保存失败'); if (result.config) Object.assign(config, result.config); statuses.value = result.tools || []; emit('updated', statuses.value); ElMessage.success('本地能力配置已保存') } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)) } finally { saving.value = false } }
</script>

<style scoped>
.processing-policy label>span,.tool-options label{min-width:0;overflow-wrap:anywhere}
.tool-copy small{overflow-wrap:anywhere}
.tool-path :deep(.el-input),.tool-options label>div :deep(.el-input){flex:1;min-width:0}
.tool-path :deep(.el-button),.tool-options label>div :deep(.el-button){flex-shrink:0}
.processing-policy{margin-bottom:16px;padding:14px;border:1px solid var(--pl-border);border-radius:11px;background:var(--pl-surface)}.processing-policy h3{margin:0;font-size:14px;color:var(--pl-text)}.processing-policy p,.processing-policy small{color:var(--pl-text-secondary);font-size:12px;line-height:1.6}.processing-policy label{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-top:12px}.processing-policy label>span{display:flex;flex-direction:column;gap:4px}.processing-policy strong{font-size:12px}.policy-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:14px}.policy-actions>span{font-size:12px;color:var(--pl-text-muted)}
.tool-note{display:flex;gap:8px;margin-bottom:13px;padding:10px;border-radius:9px;color:#527263;background:#edf7f3;font-size: var(--pl-font-xs);line-height:1.55}.tool-note svg{flex:none}.tool-list{display:flex;flex-direction:column;gap:8px}.tool-list article{display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:center;gap:10px;padding:11px;border:1px solid #e3e8f0;border-radius:11px}.tool-icon{width:38px;height:38px;display:grid;place-items:center;border-radius:10px;color:#4773c8;background:#edf3ff}.tool-copy{display:flex;min-width:0;flex-direction:column}.tool-copy strong{font-size:12px}.tool-copy small{margin-top:3px;color:#7e899a;font-size: var(--pl-font-xs)}.tool-copy code{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8390a2;font-size:8px}.tool-state{padding:3px 7px;border-radius:999px;color:#8a6d39;background: var(--pl-surface);font-size: var(--pl-font-xs);font-weight:700}.tool-state.ready{color:#33745c;background:#eaf7f1}.tool-path{grid-column:2/4;display:flex;gap:7px}.tool-path :deep(.el-button){display:flex;align-items:center;gap:5px}.tool-options{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:13px}.tool-options label{display:flex;flex-direction:column;gap:6px;color:#4f5c70;font-size: var(--pl-font-xs);font-weight:700}.tool-options label:last-child{grid-column:1/3}.tool-options label>div{display:flex;gap:7px}@media(max-width:700px){.tool-options{grid-template-columns:1fr}.tool-options label:last-child{grid-column:auto}.tool-list article{grid-template-columns:38px minmax(0,1fr)}.tool-state{grid-column:2}.tool-path{grid-column:1/3}}
</style>

<style>
/* ElDialog teleports its own body outside this component's scoped DOM. */
.el-dialog.local-tools-dialog{display:flex;flex-direction:column;max-height:90vh;max-width:94vw;margin-bottom:5vh;overflow:hidden}
.local-tools-dialog>.el-dialog__header,.local-tools-dialog>.el-dialog__footer{flex:0 0 auto}
.local-tools-dialog>.el-dialog__body{flex:1 1 auto;min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden;padding-right:8px}
</style>
