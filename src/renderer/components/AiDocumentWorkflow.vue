<template>
  <section class="workflow-panel">
    <header><div><h3>全文处理</h3><p>逐段处理已解析内容，显示覆盖进度和结果来源。点击开始后会调用当前模型。</p></div><button :disabled="loading" @click="reload">刷新记录</button></header>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <div class="workflow-grid"><aside>
      <form @submit.prevent="start">
        <label>处理方式<select v-model="mode" aria-label="全文处理方式"><option value="summary">分章 / 分段摘要</option><option value="compare">比较两份文档</option><option value="extract">按模板提取字段</option></select></label>
        <fieldset><legend>{{ mode === 'compare' ? '选择两份文档，依选择顺序作为左、右版本' : '选择要处理的文档' }}</legend><label v-for="document in readyDocuments" :key="document.id" class="document-choice"><input v-model="documentIds" type="checkbox" :value="document.id" :disabled="!documentIds.includes(document.id) && documentIds.length >= (mode === 'compare' ? 2 : 100)" /><span>{{ document.name }}</span><small v-if="mode === 'compare' && documentIds.includes(document.id)">{{ documentIds.indexOf(document.id) === 0 ? '左侧' : '右侧' }}</small></label><p v-if="!readyDocuments.length">先在文档库中导入并解析文件。</p></fieldset>
        <label v-if="mode === 'extract'">字段模板<select v-model="templateId" aria-label="提取模板"><option value="">请选择模板</option><option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option></select></label>
        <label>补充要求（可选）<textarea v-model="instruction" rows="3" maxlength="2000" aria-label="处理补充要求" placeholder="例如：重点整理交付时间和待办事项" /></label>
        <button class="primary" type="submit" :disabled="busy || !documentIds.length || (mode === 'compare' && documentIds.length !== 2) || (mode === 'extract' && !templateId)">{{ busy ? '正在提交…' : '开始完整处理' }}</button>
      </form>
      <details class="template-editor"><summary>管理提取模板</summary>
        <label>编辑模板<select v-model="editingTemplateId" aria-label="编辑提取模板" @change="loadTemplateDraft"><option value="">新建模板</option><option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option></select></label>
        <label>模板名称<input v-model="templateName" maxlength="100" aria-label="模板名称" /></label>
        <div v-for="(field, index) in fields" :key="index" class="template-field"><input v-model="field.key" placeholder="字段标识，例如 date" :aria-label="`字段 ${index + 1} 标识`" /><input v-model="field.label" placeholder="显示名称" :aria-label="`字段 ${index + 1} 名称`" /><select v-model="field.type" :aria-label="`字段 ${index + 1} 类型`"><option value="text">文字</option><option value="number">数字</option><option value="date">日期</option><option value="boolean">是 / 否</option></select><input v-model="field.description" placeholder="提取要求（可选）" /><button :disabled="fields.length === 1" @click="fields.splice(index, 1)">移除字段</button></div>
        <div class="actions"><button :disabled="fields.length >= 40" @click="addField">添加字段</button><button :disabled="templateBusy" @click="saveTemplate">保存模板</button><button v-if="editingTemplateId" :disabled="templateBusy" @click="deleteTemplate">删除模板</button></div>
      </details>
    </aside><div class="workflow-results">
      <label>处理记录<select v-model="selectedRunId" aria-label="全文处理记录" @change="selectRun"><option value="">请选择记录</option><option v-for="item in runs" :key="item.id" :value="item.id">{{ item.title }} · {{ statusLabel(item.status) }}</option></select></label>
      <p v-if="loading">正在读取处理记录…</p>
      <template v-if="run">
        <div class="run-heading"><strong>{{ run.title }}</strong><span>{{ statusLabel(run.status) }} · {{ run.completedBatches }} / {{ run.totalBatches }} 段</span></div>
        <progress :value="run.completedBatches" :max="Math.max(1, run.totalBatches)" aria-label="全文处理进度" />
        <div class="actions"><button v-if="['running', 'pending'].includes(run.status)" :disabled="busy" @click="control('cancel')">停止处理</button><button v-if="['failed', 'cancelled'].includes(run.status)" :disabled="busy" @click="control('resume')">继续未完成分段</button><button :disabled="busy" @click="exportRun('markdown')">导出 Markdown</button><button :disabled="busy" @click="exportRun('json')">导出 JSON</button></div>
        <p v-if="run.error" class="error">{{ run.error }}</p>
        <section class="coverage"><h4>处理覆盖范围</h4><details v-for="item in run.coverage" :key="item.documentId"><summary>{{ item.documentName }} · 已处理 {{ item.processedChunks }} / {{ item.totalChunks }} 个解析片段</summary><p :class="{ warning: !item.sourceComplete }">{{ item.parseNotice }}</p><p v-if="item.pendingRanges.length">未完成：{{ item.pendingRanges.join('、') }}</p></details></section>
        <p v-if="run.result.notice">{{ run.result.notice }}</p>
        <article v-for="(item, index) in run.result.sections" :key="`${item.documentId}:${index}`" class="summary-section"><h4>{{ item.title }}</h4><p>{{ item.summary }}</p><div class="actions"><button v-for="(citation, number) in item.citations" :key="number" @click="emit('citation', citation)">{{ citationLabel(citation) }}</button></div></article>
        <div v-if="run.mode === 'compare'" class="table-wrap"><table><thead><tr><th>字段</th><th>左侧版本</th><th>右侧版本</th><th>变化</th><th>来源</th></tr></thead><tbody><tr v-for="(item, index) in run.result.differences" :key="index"><td>{{ item.field }}</td><td>{{ formatValue(item.leftValue) }}</td><td>{{ formatValue(item.rightValue) }}</td><td>{{ changeLabel(item.change) }}</td><td><button v-for="(citation, number) in item.citations" :key="number" @click="emit('citation', citation)">{{ citationLabel(citation) }}</button></td></tr></tbody></table></div>
        <div v-if="run.mode === 'extract'" class="table-wrap"><table><thead><tr><th>字段</th><th>结果</th><th>状态</th><th>来源</th></tr></thead><tbody><tr v-for="item in run.result.fields" :key="item.key"><td>{{ item.label }}</td><td>{{ formatValue(item.value) }}</td><td>{{ fieldLabel(item.status) }}</td><td><button v-for="(citation, index) in item.citations" :key="index" @click="emit('citation', citation)">{{ citationLabel(citation) }}</button></td></tr></tbody></table></div>
        <details><summary>逐段执行记录（{{ run.batches.length }}）</summary><ol><li v-for="batch in run.batches" :key="batch.id">{{ batch.title }} · {{ statusLabel(batch.status) }} · {{ batch.chunkCount }} 个片段<span v-if="batch.error"> · {{ batch.error }}</span></li></ol></details>
      </template><p v-else-if="!loading" class="empty">选择文档开始处理，或打开已有记录。已完成结果保存在本机。</p>
    </div></div>
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { AiCitation, AiDocument } from '@shared/ai-types'
import type { AiWorkflowMode, AiWorkflowRun, AiWorkflowStatus, AiWorkflowTemplate, AiWorkflowTemplateField } from '@shared/ai-workflow'
import { aiWorkflowApi } from '../api/ai-workflow'
import { citationTimeLabel } from '@shared/ai-citation-preview'
const props = defineProps<{ documents: AiDocument[] }>()
const emit = defineEmits<{ citation: [citation: AiCitation] }>()
const mode = ref<AiWorkflowMode>('summary'), documentIds = ref<string[]>([]), instruction = ref(''), templateId = ref('')
const runs = ref<AiWorkflowRun[]>([]), run = ref<AiWorkflowRun | null>(null), selectedRunId = ref(''), templates = ref<AiWorkflowTemplate[]>([])
const loading = ref(false), busy = ref(false), templateBusy = ref(false), error = ref(''), notice = ref('')
const editingTemplateId = ref(''), templateName = ref(''), fields = ref<AiWorkflowTemplateField[]>([{ key: 'field_1', label: '', type: 'text' }])
let alive = true, selectionVersion = 0, reloadVersion = 0, templateVersion = 0, templateDraftVersion = 0
let timer: ReturnType<typeof setTimeout> | undefined
const readyDocuments = computed(() => props.documents.filter(document => document.status === 'ready'))
watch(() => readyDocuments.value.map(document => document.id), documents => { const ids = new Set(documents); documentIds.value = documentIds.value.filter(id => ids.has(id)) })
const failure = (value: unknown) => value instanceof Error ? value.message : String(value)
function statusLabel(value: AiWorkflowStatus) { return { pending: '等待中', running: '处理中', completed: '已完成', failed: '未完成', cancelled: '已停止' }[value] }
function changeLabel(value: string) { return ({ added: '新增', removed: '移除', changed: '修改', unchanged: '一致', uncertain: '待核对' } as Record<string, string>)[value] || value }
function fieldLabel(value: string) { return ({ found: '已提取', missing: '未找到', conflict: '内容冲突', unknown: '无法确认' } as Record<string, string>)[value] || value }
function formatValue(value: string | number | boolean | null) { return value === null ? '—' : typeof value === 'boolean' ? value ? '是' : '否' : String(value) }
function citationLabel(citation: AiCitation) { return `${citation.documentName}${citation.pageNumber ? ` · 第 ${citation.pageNumber} 页` : citation.startSeconds !== undefined ? ` · ${citationTimeLabel(citation.startSeconds)}` : citation.section ? ` · ${citation.section}` : ''}` }
function stopPolling() { if (timer) clearTimeout(timer); timer = undefined }
function pollLater() { stopPolling(); if (alive && run.value && ['pending', 'running'].includes(run.value.status)) timer = setTimeout(() => { void readRun(false) }, 1500) }
async function reload() {
  const version = ++reloadVersion, templateRevision = templateVersion; loading.value = true; error.value = ''
  try {
    const [history, savedTemplates] = await Promise.all([aiWorkflowApi.list(), aiWorkflowApi.templates()])
    if (!alive || version !== reloadVersion) return
    if (!history.success || !history.data) throw new Error(history.error || '无法读取处理记录')
    if (!savedTemplates.success || !savedTemplates.data) throw new Error(savedTemplates.error || '无法读取模板')
    runs.value = history.data
    if (templateRevision === templateVersion) {
      templates.value = savedTemplates.data
      if (templateId.value && !templates.value.some(item => item.id === templateId.value)) templateId.value = ''
    }
    if (!selectedRunId.value && runs.value.length) selectedRunId.value = runs.value[0].id
    if (selectedRunId.value) await readRun(false)
  } catch (cause) { if (alive && version === reloadVersion) error.value = failure(cause) }
  finally { if (alive && version === reloadVersion) loading.value = false }
}
async function readRun(showLoading = true) {
  const id = selectedRunId.value, version = ++selectionVersion
  if (!id) { run.value = null; stopPolling(); return }
  if (showLoading) loading.value = true
  try {
    const response = await aiWorkflowApi.get(id)
    if (!alive || version !== selectionVersion || id !== selectedRunId.value) return
    if (!response.success || !response.data) throw new Error(response.error || '无法读取处理结果')
    run.value = response.data
    runs.value = runs.value.map(item => item.id === id ? { ...item, status: response.data!.status, completedBatches: response.data!.completedBatches } : item)
    pollLater()
  } catch (cause) { if (alive && version === selectionVersion) { error.value = failure(cause); stopPolling() } }
  finally { if (alive && version === selectionVersion) loading.value = false }
}
function selectRun() { stopPolling(); run.value = null; error.value = ''; void readRun() }
async function start() {
  if (busy.value) return
  if (!documentIds.value.length || documentIds.value.length > 100) { error.value = '请选择 1 到 100 份文档'; return }
  if (mode.value === 'compare' && documentIds.value.length !== 2) { error.value = '请按左右顺序选择两份不同文档'; return }
  if (mode.value === 'extract' && !templates.value.some(item => item.id === templateId.value)) { error.value = '请选择一个已保存的字段模板'; return }
  if (instruction.value.length > 2000) { error.value = '补充要求不能超过 2000 个字符'; return }
  const version = ++selectionVersion
  stopPolling()
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const response = await aiWorkflowApi.start({ mode: mode.value, documentIds: [...documentIds.value], instruction: instruction.value, ...(mode.value === 'extract' ? { templateId: templateId.value } : {}) })
    if (!alive) return
    if (!response.success || !response.data) throw new Error(response.error || '未能开始处理')
    reloadVersion++
    runs.value = [response.data, ...runs.value.filter(item => item.id !== response.data!.id)]
    if (version === selectionVersion) { selectedRunId.value = response.data.id; run.value = response.data; loading.value = false }
  } catch (cause) { if (alive && version === selectionVersion) error.value = failure(cause) }
  finally { if (alive) { busy.value = false; pollLater() } }
}
async function control(action: 'cancel' | 'resume') {
  if (!run.value || busy.value) return
  const id = run.value.id, version = ++selectionVersion; busy.value = true; error.value = ''; stopPolling()
  try {
    const response = await aiWorkflowApi[action](id)
    if (!alive || id !== selectedRunId.value || version !== selectionVersion) return
    if (!response.success || !response.data) throw new Error(response.error || '操作未完成')
    run.value = response.data
    runs.value = runs.value.map(item => item.id === id ? response.data! : item)
  } catch (cause) { if (alive && version === selectionVersion && id === selectedRunId.value) error.value = failure(cause) }
  finally { if (alive) { busy.value = false; pollLater() } }
}
async function exportRun(format: 'json' | 'markdown') {
  if (!run.value || busy.value) return
  const id = run.value.id, version = selectionVersion
  busy.value = true; error.value = ''; notice.value = ''
  try { const response = await aiWorkflowApi.export(id, format); if (!alive || response.canceled || id !== selectedRunId.value || version !== selectionVersion) return; if (!response.success) throw new Error(response.error || '导出失败'); notice.value = '处理结果已导出。' }
  catch (cause) { if (alive && id === selectedRunId.value && version === selectionVersion) error.value = failure(cause) }
  finally { if (alive) busy.value = false }
}
function loadTemplateDraft() { templateDraftVersion++; const template = templates.value.find(item => item.id === editingTemplateId.value); templateName.value = template?.name || ''; fields.value = template ? template.fields.map(field => ({ ...field })) : [{ key: 'field_1', label: '', type: 'text' }] }
function addField() { let index = fields.value.length + 1; while (fields.value.some(field => field.key === `field_${index}`)) index++; fields.value.push({ key: `field_${index}`, label: '', type: 'text' }) }
async function saveTemplate() {
  if (templateBusy.value) return
  const version = templateDraftVersion
  templateVersion++
  templateBusy.value = true; error.value = ''
  try {
    const response = await aiWorkflowApi.saveTemplate({ ...(editingTemplateId.value ? { id: editingTemplateId.value } : {}), name: templateName.value, fields: fields.value.map(field => ({ ...field })) })
    if (!alive) return
    if (!response.success || !response.data) throw new Error(response.error || '模板未保存')
    templates.value = [...templates.value.filter(item => item.id !== response.data!.id), response.data]
    if (version === templateDraftVersion) { editingTemplateId.value = response.data.id; templateId.value = response.data.id; notice.value = '模板已保存，已有处理记录保留原模板快照。' }
  } catch (cause) { if (alive && version === templateDraftVersion) error.value = failure(cause) }
  finally { if (alive) templateBusy.value = false }
}
async function deleteTemplate() {
  if (!editingTemplateId.value || templateBusy.value) return
  const version = templateDraftVersion
  templateVersion++
  templateBusy.value = true; error.value = ''; const id = editingTemplateId.value
  try { const response = await aiWorkflowApi.deleteTemplate(id); if (!alive) return; if (!response.success) throw new Error(response.error || '模板未删除'); templates.value = templates.value.filter(item => item.id !== id); if (templateId.value === id) templateId.value = ''; if (version === templateDraftVersion) { editingTemplateId.value = ''; loadTemplateDraft(); notice.value = '模板已删除，已有处理结果仍保留。' } }
  catch (cause) { if (alive && version === templateDraftVersion) error.value = failure(cause) }
  finally { if (alive) templateBusy.value = false }
}
onMounted(() => { void reload() })
onUnmounted(() => { alive = false; selectionVersion++; reloadVersion++; stopPolling() })
</script>
<style scoped>
.workflow-panel{color:var(--pl-text);padding:20px;background:var(--pl-surface);border:1px solid var(--pl-border);border-radius:14px}.workflow-panel header,.run-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.workflow-panel h3,.workflow-panel h4{margin:0 0 10px}.workflow-panel p{line-height:1.65;font-size:13px}.workflow-grid{display:grid;grid-template-columns:minmax(240px,310px) minmax(0,1fr);gap:24px;margin-top:20px}.workflow-panel form,.workflow-results{display:flex;flex-direction:column;gap:16px}.workflow-panel label{display:flex;flex-direction:column;gap:7px;font-size:13px}.workflow-panel input,.workflow-panel select,.workflow-panel textarea{background:var(--pl-surface-subtle);color:var(--pl-text);border:1px solid var(--pl-border);border-radius:7px;padding:9px;min-width:0;width:100%;box-sizing:border-box}.workflow-panel button{padding:8px 11px;border:1px solid var(--pl-border);border-radius:7px;background:var(--pl-surface);color:var(--pl-text);cursor:pointer;font-size:12px}.workflow-panel button:disabled{opacity:.5;cursor:not-allowed}.workflow-panel .primary{background:var(--pl-primary,#2563eb);color:white}.workflow-panel fieldset{border:1px solid var(--pl-border);border-radius:8px;max-height:260px;overflow:auto;padding:10px}.workflow-panel legend{font-size:12px}.workflow-panel .document-choice{flex-direction:row;align-items:center;margin:8px 0;overflow-wrap:anywhere}.document-choice input{width:auto}.document-choice span{flex:1}.document-choice small{white-space:nowrap}.template-editor{margin-top:20px;border-top:1px solid var(--pl-border);padding-top:14px}.workflow-panel summary{cursor:pointer;font-size:13px;line-height:1.6}.template-editor label{margin:10px 0}.template-field{display:grid;gap:7px;margin:12px 0;padding-bottom:12px;border-bottom:1px solid var(--pl-border)}.actions{display:flex;flex-wrap:wrap;gap:8px}.workflow-results{min-width:0}.run-heading{font-size:13px}.workflow-results progress{width:100%;height:10px;accent-color:var(--pl-primary,#2563eb)}.coverage{background:var(--pl-surface-subtle);border:1px solid var(--pl-border);border-radius:9px;padding:13px}.coverage details{margin:9px 0}.warning{color:var(--pl-warning,#9a6700)}.error{color:var(--pl-danger,#b42318)}.summary-section{border-bottom:1px solid var(--pl-border);padding-bottom:16px}.summary-section p{white-space:pre-wrap}.table-wrap{overflow:auto}.table-wrap table{border-collapse:collapse;width:100%;font-size:13px}.table-wrap th,.table-wrap td{text-align:left;vertical-align:top;border-bottom:1px solid var(--pl-border);padding:10px;min-width:75px;overflow-wrap:anywhere}.table-wrap button{margin:3px;font-size:11px}.workflow-panel li{font-size:12px;line-height:1.8;padding:4px}.empty{padding:60px 20px;text-align:center;color:var(--pl-text-muted)}@media(max-width:1050px){.workflow-grid{grid-template-columns:1fr}.workflow-panel fieldset{max-height:190px}}
</style>
