<template>
  <el-dialog :model-value="modelValue" title="本地 AI 能力包" width="720px" @update:model-value="$emit('update:modelValue', $event)" @open="load">
    <div class="tool-note"><ShieldCheck :size="18" /><span>本地工具由你自行安装，PanLite 只调用已配置的可执行文件，不会自动下载或安装。缺失时会回退到当前 AI 服务。</span></div>
    <div class="tool-list">
      <article v-for="tool in toolRows" :key="tool.key">
        <span class="tool-icon"><component :is="tool.icon" :size="18" /></span>
        <div class="tool-copy"><strong>{{ tool.name }}</strong><small>{{ tool.description }}</small><code v-if="statusFor(tool.key)?.version">{{ statusFor(tool.key)?.version }}</code></div>
        <span class="tool-state" :class="{ ready: statusFor(tool.key)?.available }">{{ statusFor(tool.key)?.available ? '可用' : '未检测到' }}</span>
        <div class="tool-path"><el-input v-model="config[tool.field]" clearable :placeholder="`留空则自动检测 ${tool.name}`" /><el-button @click="selectTool(tool.field)"><FolderOpen :size="14" />选择</el-button></div>
      </article>
    </div>
    <div class="tool-options">
      <label><span>OCR 语言</span><el-input v-model="config.ocrLanguage" placeholder="chi_sim+eng" /></label>
      <label><span>Whisper 模型名称</span><el-input v-model="config.whisperModel" placeholder="small" /></label>
      <label><span>whisper.cpp GGML/GGUF 模型</span><div><el-input v-model="config.whisperModelPath" clearable /><el-button @click="selectTool('whisperModelPath')">选择</el-button></div></label>
    </div>
    <template #footer><el-button :loading="loading" @click="load">重新检测</el-button><el-button type="primary" :loading="saving" @click="save">保存配置</el-button></template>
  </el-dialog>
</template>

<script setup lang="ts">
import { markRaw, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Captions, FileCog, FolderOpen, ScanText, ShieldCheck, Waves } from 'lucide-vue-next'
import type { AiLocalToolKey, AiLocalToolStatus, AiLocalToolsConfig } from '@shared/ai-types'
import { electronApi } from '../api/ipc'

defineProps<{ modelValue: boolean }>()
defineEmits<{ 'update:modelValue': [value: boolean] }>()
const loading = ref(false), saving = ref(false), statuses = ref<AiLocalToolStatus[]>([])
const config = reactive<AiLocalToolsConfig>({ tesseractPath: '', ffmpegPath: '', whisperPath: '', libreOfficePath: '', ocrLanguage: 'chi_sim+eng', whisperModel: 'small', whisperModelPath: '' })
const toolRows = [
  { key: 'tesseract' as const, field: 'tesseractPath' as const, name: 'Tesseract OCR', description: '图片离线 OCR；建议安装中文和英文语言包', icon: markRaw(ScanText) },
  { key: 'ffmpeg' as const, field: 'ffmpegPath' as const, name: 'FFmpeg', description: '优先提取视频内嵌字幕，并为 Whisper 提取音轨', icon: markRaw(Captions) },
  { key: 'whisper' as const, field: 'whisperPath' as const, name: 'Whisper', description: '支持 whisper.cpp 或 OpenAI Whisper CLI 本地转写', icon: markRaw(Waves) },
  { key: 'libreoffice' as const, field: 'libreOfficePath' as const, name: 'LibreOffice', description: '将 DOC/XLS/PPT 转换后高精度提取', icon: markRaw(FileCog) },
]
function statusFor(key: AiLocalToolKey) { return statuses.value.find(item => item.key === key) }
async function load() { loading.value = true; try { const result = await electronApi.aiLocalToolsGet(); if (!result.success) throw new Error(result.error || '检测失败'); if (result.config) Object.assign(config, result.config); statuses.value = result.tools || [] } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)) } finally { loading.value = false } }
async function selectTool(field: keyof AiLocalToolsConfig) { const result = await electronApi.aiLocalToolsSelect(field); if (result.success && result.filePath) config[field] = result.filePath }
async function save() { saving.value = true; try { const result = await electronApi.aiLocalToolsSave({ ...config }); if (!result.success) throw new Error(result.error || '保存失败'); if (result.config) Object.assign(config, result.config); statuses.value = result.tools || []; ElMessage.success('本地能力配置已保存') } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)) } finally { saving.value = false } }
</script>

<style scoped>
.tool-note{display:flex;gap:8px;margin-bottom:13px;padding:10px;border-radius:9px;color:#527263;background:#edf7f3;font-size:10px;line-height:1.55}.tool-note svg{flex:none}.tool-list{display:flex;flex-direction:column;gap:8px}.tool-list article{display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:center;gap:10px;padding:11px;border:1px solid #e3e8f0;border-radius:11px}.tool-icon{width:38px;height:38px;display:grid;place-items:center;border-radius:10px;color:#4773c8;background:#edf3ff}.tool-copy{display:flex;min-width:0;flex-direction:column}.tool-copy strong{font-size:12px}.tool-copy small{margin-top:3px;color:#7e899a;font-size:9px}.tool-copy code{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8390a2;font-size:8px}.tool-state{padding:3px 7px;border-radius:999px;color:#8a6d39;background:#fff5df;font-size:9px;font-weight:700}.tool-state.ready{color:#33745c;background:#eaf7f1}.tool-path{grid-column:2/4;display:flex;gap:7px}.tool-path :deep(.el-button){display:flex;align-items:center;gap:5px}.tool-options{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:13px}.tool-options label{display:flex;flex-direction:column;gap:6px;color:#4f5c70;font-size:10px;font-weight:700}.tool-options label:last-child{grid-column:1/3}.tool-options label>div{display:flex;gap:7px}@media(max-width:700px){.tool-options{grid-template-columns:1fr}.tool-options label:last-child{grid-column:auto}.tool-list article{grid-template-columns:38px minmax(0,1fr)}.tool-state{grid-column:2}.tool-path{grid-column:1/3}}
</style>
