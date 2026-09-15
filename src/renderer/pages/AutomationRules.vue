<template>
  <div class="automation-page">
    <header class="panel page-header"><div class="header-icon"><Workflow :size="24" /></div><div><h1>自动化规则</h1><p>将已保存的迁移或备份计划，按时间或上一条规则的成功结果执行。</p></div><button type="button" class="button refresh-all" :disabled="loading" @click="loadData">刷新列表</button></header>
    <div class="workspace">
      <aside class="panel rule-sidebar">
        <div class="section-heading"><h2>已保存规则</h2><button type="button" class="text-button" @click="selectRule(null)"><Plus :size="15" />新建</button></div>
        <input v-model="keyword" aria-label="查找自动化规则" placeholder="查找规则" class="search" />
        <p v-if="loading && !rules.length" class="empty" role="status">正在读取规则…</p><p v-if="listError" class="error" role="alert">{{ listError }} <button type="button" class="text-button" @click="loadData">重试</button></p>
        <p v-if="!loading && !listError && !filteredRules.length" class="empty">{{ rules.length ? '没有匹配的规则' : '还没有自动化规则' }}</p>
        <div class="rule-list"><button v-for="rule in filteredRules" :key="rule.id" type="button" class="rule-item" :class="{ active: selected?.id === rule.id }" @click="selectRule(rule)"><strong>{{ rule.name }}</strong><span><i :class="{ enabled: rule.enabled }" />{{ rule.enabled ? '已启用' : '已暂停' }} · 规则 v{{ rule.version }}</span><small>{{ triggerLabel(rule.trigger) }}</small></button></div>
      </aside>
      <main class="content">
        <section class="panel configuration">
          <div class="section-heading"><div><h2>{{ selected ? selected.name : '新建规则' }}</h2><p v-if="selected" class="muted">规则 v{{ selected.version }}{{ dirty ? ' · 有未保存修改' : '' }}</p></div><span v-if="selected" class="badge" :class="selected.enabled ? 'success' : 'neutral'">{{ selected.enabled ? '规则已启用' : '规则已暂停' }}</span></div>
          <p v-if="actionsError" class="error" role="alert">{{ actionsError }} <button type="button" class="text-button" @click="loadData">重新读取计划</button></p>
          <p v-else-if="!loading && !actions.length" class="notice">先保存一个<button type="button" class="text-button" @click="router.push('/transfer-plans')">迁移计划</button>或<button type="button" class="text-button" @click="router.push('/file-backups')">备份计划</button>，再建立规则。</p>
          <p v-if="selected?.error" class="notice">最近状态：{{ selected.error }}</p>
          <form class="rule-form" @submit.prevent="saveRule">
            <label class="field">规则名称<input v-model="draft.name" aria-label="规则名称" maxlength="120" placeholder="例如：每天归档项目资料" :disabled="busy" /></label>
            <label class="field">执行已保存的计划版本<select v-model="draft.actionKey" aria-label="执行计划版本" :disabled="busy || loading"><option value="" disabled>选择迁移或备份计划</option><option v-if="selected && !selectedActionAvailable" :value="actionKey(selected.action)" disabled>{{ actionLabel(selected.action) }}（版本已不可用，请重新选择）</option><option v-for="action in actions" :key="actionKey(action)" :value="actionKey(action)">{{ actionLabel(action) }}</option></select><span class="hint">规则绑定此版本；计划配置更新后，请明确选择新版本并保存规则。</span></label>
            <div class="form-grid">
              <label class="field">触发方式<select v-model="draft.triggerKind" aria-label="触发方式" :disabled="busy"><option value="manual">仅手动</option><option value="interval">固定间隔</option><option value="daily">每天指定时间</option><option value="task_success">另一条规则执行成功后</option></select></label>
              <label v-if="draft.triggerKind === 'interval'" class="field">间隔分钟<input v-model.number="draft.everyMinutes" aria-label="间隔分钟" type="number" min="5" max="43200" step="1" :disabled="busy" /><span class="hint">5 至 43200 分钟。</span></label>
              <label v-if="draft.triggerKind === 'daily'" class="field">本机每天时间<input v-model="draft.time" aria-label="本机每天时间" type="time" :disabled="busy" /><span class="hint">按电脑当前本地时区计算。</span></label>
              <label v-if="draft.triggerKind === 'task_success'" class="field">来源规则<select v-model="draft.sourceRuleId" aria-label="成功触发来源规则" :disabled="busy"><option value="" disabled>选择另一条规则</option><option v-for="rule in sourceRules" :key="rule.id" :value="rule.id">{{ rule.name }}{{ rule.enabled ? '' : '（已暂停）' }}</option></select><span class="hint">只响应关联后产生的成功结果；失败或待核对结果不会触发。</span></label>
              <label v-if="draft.triggerKind === 'interval' || draft.triggerKind === 'daily'" class="field">错过执行时间<select v-model="draft.missed" aria-label="错过执行时间" :disabled="busy"><option value="skip">跳过错过的执行</option><option value="run_once">合并补跑一次</option></select><span class="hint">应用关闭或电脑休眠时无法执行；恢复运行后按此方式处理。</span></label>
            </div>
            <label class="check-label"><input v-model="draft.enabled" aria-label="保存后启用规则" type="checkbox" :disabled="busy" />保存后启用规则</label>
            <p v-if="selected" class="schedule muted">下一次：{{ selected.enabled ? formatDate(selected.nextRunAt, selected.trigger.kind === 'manual' ? '等待手动执行' : selected.trigger.kind === 'task_success' ? '等待来源规则成功' : '尚未安排') : '已暂停' }} · 最近成功：{{ formatDate(selected.lastSuccessAt, '暂无') }}</p>
            <div class="actions"><button type="submit" class="button primary" :disabled="busy || !canSave">{{ saving ? '正在保存…' : '保存规则' }}</button><button v-if="selected" type="button" class="button" :disabled="busy || dirty" @click="toggleEnabled">{{ selected.enabled ? '暂停规则' : '启用规则' }}</button><button v-if="selected" type="button" class="text-button danger delete-button" :disabled="busy" @click="deleteConfirmation = true">删除规则</button></div>
          </form>
          <p v-if="dirty && selected" class="hint">保存修改后，才能试运行、切换启用状态或手动执行。</p>
          <p class="hint">暂停规则会阻止创建新任务，包括手动执行；已提交的任务请到任务日志暂停或取消。</p>
          <p v-if="configurationError" class="error" role="alert">{{ configurationError }} <button v-if="versionConflict" type="button" class="text-button" :disabled="busy" @click="reloadSelected">放弃草稿并读取最新规则</button></p><p v-if="notice" class="success-text" role="status">{{ notice }}</p>
          <div v-if="deleteConfirmation && selected" class="confirmation" role="alert"><p>删除“{{ selected.name }}”的规则和本地运行记录。已保存计划和网盘文件将保留。</p><div class="actions"><button type="button" class="button" :disabled="busy" @click="deleteConfirmation = false">保留规则</button><button type="button" class="button danger" :disabled="busy" @click="removeRule">确认删除规则</button></div></div>
        </section>
        <section v-if="selected" class="panel preview-panel">
          <div class="section-heading"><div><h2>试运行预演</h2><p class="muted">读取计划范围，显示预计变更；不会上传、复制或删除网盘文件。</p></div><button type="button" class="button" :disabled="busy || dirty || !selectedActionAvailable" @click="dryRun"><FileSearch :size="15" />{{ previewing ? '正在预演…' : '只读试运行' }}</button></div>
          <p v-if="previewError" class="error" role="alert">{{ previewError }}</p><div v-if="preview" class="preview-result"><div class="metrics"><div><span>清单项目</span><strong>{{ preview.itemCount.toLocaleString() }}</strong></div><div><span>待写入文件</span><strong>{{ preview.writeCount.toLocaleString() }}</strong></div><div><span>{{ selected.action.kind === 'migration' ? '迁移流量' : '新增上传量' }}</span><strong>{{ formatSize(preview.transferBytes) }}</strong></div></div><p v-if="selected.action.kind === 'backup'" class="hint">新增上传量不包含完成备份前回读校验产生的下载流量。</p><p :class="preview.executable ? 'success-text' : 'notice'">{{ preview.summary }}</p><p v-if="!preview.executable" class="hint">请先在对应计划中处理需要核对的项目，再重新试运行。</p></div><p v-else class="empty">先试运行，核对当前计划版本的范围和预计变更。</p>
          <div class="actions"><button type="button" class="button primary" :disabled="!canRun" @click="runConfirmation = true"><Play :size="14" />手动执行</button><button type="button" class="text-button" @click="openPlan">查看关联计划</button><span v-if="!selected.enabled" class="hint">规则已暂停；可只读试运行，执行前请先启用规则。</span><span v-else-if="preview && dirty" class="hint">草稿已修改，请保存后重新预演。</span></div>
          <div v-if="runConfirmation && selected && preview" class="confirmation run-confirmation" role="alert"><strong>确认执行“{{ selected.name }}”规则 v{{ selected.version }}</strong><p>{{ actionLabel(selected.action) }} · 待写入文件 {{ preview.writeCount }} 个 · {{ selected.action.kind === 'migration' ? '迁移流量' : '新增上传量' }} {{ formatSize(preview.transferBytes) }}{{ selected.action.kind === 'backup' ? '（不含回读校验下载）' : '' }}。提交时会重新检查目录；需要人工核对时将停止并保留记录。</p><div class="actions"><button type="button" class="button" :disabled="busy" @click="runConfirmation = false">暂不执行</button><button type="button" class="button primary" :disabled="!canRun" @click="runNow">{{ executing ? '正在提交…' : '确认手动执行' }}</button></div></div>
          <p v-if="executionError" class="error" role="alert">{{ executionError }}</p>
        </section>
        <section v-if="selected" class="panel history-panel">
          <div class="section-heading"><h2>执行历史</h2><button type="button" class="text-button" :disabled="runsLoading" @click="loadRuns(runPage)">刷新历史</button></div><p v-if="runsError" class="error" role="alert">{{ runsError }} <button type="button" class="text-button" @click="loadRuns(runPage)">重试历史</button></p><p v-if="runsLoading && !runs.length" class="empty" role="status">正在读取记录…</p><p v-else-if="!runs.length && !runsError" class="empty">暂无执行记录。试运行不会创建执行任务。</p>
          <div v-if="runs.length" class="table-scroll"><table class="history-table"><thead><tr><th>执行时间 / 版本</th><th>状态</th><th>结果</th><th>任务</th></tr></thead><tbody><tr v-for="run in runs" :key="run.id"><td><strong>{{ formatDate(run.createdAt) }}</strong><small>规则 v{{ run.ruleVersion }} · {{ run.action.kind === 'migration' ? '迁移' : '备份' }}计划 v{{ run.action.planVersion }}</small></td><td><span class="badge" :class="run.status === 'success' ? 'success' : ['failed', 'attention'].includes(run.status) ? 'warning' : 'neutral'">{{ RUN_STATUS[run.status] }}</span></td><td>{{ run.summary || '正在准备或等待任务结果' }}<small v-if="run.finishedAt">结束于 {{ formatDate(run.finishedAt) }}</small></td><td><button v-if="run.taskId" type="button" class="text-button" @click="openTask(run.taskId)">查看任务<ExternalLink :size="13" /></button><span v-else class="muted">尚未提交</span></td></tr></tbody></table></div>
          <footer class="pagination"><span>{{ runTotal }} 条 · 第 {{ runPage }} / {{ runPages }} 页</span><button type="button" class="button" :disabled="runsLoading || runPage <= 1" @click="loadRuns(runPage - 1)">上一页记录</button><button type="button" class="button" :disabled="runsLoading || runPage >= runPages" @click="loadRuns(runPage + 1)">下一页记录</button></footer>
        </section>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ExternalLink, FileSearch, Play, Plus, Workflow } from 'lucide-vue-next'
import type { AutomationAction, AutomationActionOption, AutomationPreview, AutomationResult, AutomationRule, AutomationRuleInput, AutomationRun, AutomationTrigger } from '@shared/automation-rules'
import { automationRulesApi } from '../api/automation-rules'

const router = useRouter()
const RUN_STATUS: Record<AutomationRun['status'], string> = { preparing: '准备中', dispatching: '提交中', running: '执行中', success: '成功', failed: '失败', attention: '需要核对' }
interface Draft { name: string; actionKey: string; enabled: boolean; triggerKind: AutomationTrigger['kind']; everyMinutes: number; time: string; missed: 'skip' | 'run_once'; sourceRuleId: string }
const emptyDraft = (): Draft => ({ name: '', actionKey: '', enabled: false, triggerKind: 'manual', everyMinutes: 60, time: '09:00', missed: 'skip', sourceRuleId: '' })
const rules = ref<AutomationRule[]>([]), actions = ref<AutomationActionOption[]>([]), selected = ref<AutomationRule | null>(null)
const draft = reactive<Draft>(emptyDraft()), savedDraft = ref(JSON.stringify(draft)), keyword = ref('')
const loading = ref(false), listError = ref(''), actionsError = ref(''), configurationError = ref(''), notice = ref(''), versionConflict = ref(false)
const saving = ref(false), executing = ref(false), previewing = ref(false), activeRequests = reactive(new Set<string>())
const preview = ref<AutomationPreview | null>(null), previewRuleVersion = ref(0), previewError = ref(''), executionError = ref(''), runConfirmation = ref(false), deleteConfirmation = ref(false)
const runs = ref<AutomationRun[]>([]), runTotal = ref(0), runPage = ref(1), runsLoading = ref(false), runsError = ref('')
const PAGE_SIZE = 25
let alive = true, selectionEpoch = 0, listEpoch = 0, runsEpoch = 0, firstLoad = true
let pollTimer: ReturnType<typeof setTimeout> | undefined
const busy = computed(() => activeRequests.has(selected.value?.id || 'new'))
const dirty = computed(() => JSON.stringify(draft) !== savedDraft.value)
const filteredRules = computed(() => rules.value.filter(rule => rule.name.toLocaleLowerCase().includes(keyword.value.trim().toLocaleLowerCase())))
const sourceRules = computed(() => rules.value.filter(rule => rule.id !== selected.value?.id))
const chosenAction = computed(() => actions.value.find(action => actionKey(action) === draft.actionKey))
const selectedActionAvailable = computed(() => !!selected.value && actions.value.some(action => actionKey(action) === actionKey(selected.value!.action)))
const validTrigger = computed(() => draft.triggerKind === 'interval' ? Number.isInteger(draft.everyMinutes) && draft.everyMinutes >= 5 && draft.everyMinutes <= 43200 : draft.triggerKind === 'daily' ? /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time) : draft.triggerKind === 'task_success' ? sourceRules.value.some(rule => rule.id === draft.sourceRuleId) : true)
const canSave = computed(() => !!draft.name.trim() && !!chosenAction.value && validTrigger.value && (!selected.value || dirty.value) && !loading.value)
const canRun = computed(() => !!selected.value?.enabled && !versionConflict.value && !dirty.value && !busy.value && selectedActionAvailable.value && !!preview.value?.executable && previewRuleVersion.value === selected.value.version)
const runPages = computed(() => Math.max(1, Math.ceil(runTotal.value / PAGE_SIZE)))
class RequestError extends Error { constructor(message: string, readonly code?: string) { super(message) } }
function requireSuccess<T extends object>(result: AutomationResult<T>): asserts result is { success: true } & T { if (!result.success) throw new RequestError(result.error, result.code) }
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : String(cause) }
function current(epoch: number) { return alive && epoch === selectionEpoch }
function actionKey(action: AutomationAction) { return JSON.stringify([action.kind, action.planId, action.planVersion]) }
function actionLabel(action: AutomationAction) { const option = actions.value.find(item => actionKey(item) === actionKey(action)); return `${action.kind === 'migration' ? '迁移' : '备份'} · ${option?.name || action.planId} · v${action.planVersion}` }
function formatDate(value?: number, fallback = '—') { return value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : fallback }
function formatSize(value: number) { if (!value) return '0 B'; const unit = Math.min(4, Math.max(0, Math.floor(Math.log(value) / Math.log(1024)))); return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}` }
function triggerLabel(trigger: AutomationTrigger) { if (trigger.kind === 'manual') return '仅手动执行'; if (trigger.kind === 'interval') return `每 ${trigger.everyMinutes} 分钟`; if (trigger.kind === 'daily') return `本机每天 ${trigger.time}`; return `${rules.value.find(rule => rule.id === trigger.sourceRuleId)?.name || '关联规则'}成功后` }
function draftOf(rule: AutomationRule): Draft { return { ...emptyDraft(), name: rule.name, actionKey: actionKey(rule.action), enabled: rule.enabled, triggerKind: rule.trigger.kind, ...(rule.trigger.kind === 'interval' ? { everyMinutes: rule.trigger.everyMinutes, missed: rule.trigger.missed } : rule.trigger.kind === 'daily' ? { time: rule.trigger.time, missed: rule.trigger.missed } : rule.trigger.kind === 'task_success' ? { sourceRuleId: rule.trigger.sourceRuleId } : {}) } }
function newestKnownRule(rule: AutomationRule): AutomationRule {
  for (const known of [rules.value.find(item => item.id === rule.id), selected.value?.id === rule.id ? selected.value : null]) {
    if (known && (known.version > rule.version || (known.version === rule.version && known.updatedAt > rule.updatedAt))) rule = known
  }
  return rule
}
function syncRule(rule: AutomationRule) { rule = newestKnownRule(rule); const index = rules.value.findIndex(item => item.id === rule.id); if (index < 0) rules.value.unshift(rule); else rules.value[index] = rule; return rule }
function syncSelectedStatus(latest?: AutomationRule) {
  const previous = selected.value
  if (!latest || !previous || latest.id !== previous.id) return
  latest = newestKnownRule(latest)
  syncRule(latest)
  if (latest.version > previous.version) { versionConflict.value = true; configurationError.value = '规则配置已更新，请读取最新规则并重新试运行。'; preview.value = null; runConfirmation.value = false; return }
  const baseline = JSON.parse(savedDraft.value) as Draft
  selected.value = { ...previous, enabled: latest.enabled, error: latest.error, nextRunAt: latest.nextRunAt, lastSuccessAt: latest.lastSuccessAt, lastRunId: latest.lastRunId, updatedAt: latest.updatedAt }
  if (previous.enabled && !latest.enabled) { preview.value = null; runConfirmation.value = false }
  // Preserve explicit checkbox edits, but never turn a background pause into an implicit re-enable.
  if (draft.enabled === baseline.enabled) draft.enabled = latest.enabled
  savedDraft.value = JSON.stringify({ ...baseline, enabled: latest.enabled })
}
function selectRule(rule: AutomationRule | null) {
  firstLoad = false
  selectionEpoch++; runsEpoch++; clearTimeout(pollTimer)
  selected.value = rule; Object.assign(draft, rule ? draftOf(rule) : emptyDraft()); savedDraft.value = JSON.stringify(draft)
  preview.value = null; previewRuleVersion.value = 0; previewError.value = ''; configurationError.value = ''; executionError.value = ''; notice.value = ''; versionConflict.value = false
  saving.value = false; executing.value = false; previewing.value = false; runConfirmation.value = false; deleteConfirmation.value = false
  runs.value = []; runTotal.value = 0; runPage.value = 1; runsLoading.value = false; runsError.value = ''
  if (rule) void loadRuns(1)
}
watch(draft, () => { runConfirmation.value = false; deleteConfirmation.value = false }, { deep: true })
async function loadData() {
  const epoch = ++listEpoch; loading.value = true
  const results = await Promise.allSettled([automationRulesApi.listRules(), automationRulesApi.listActions()])
  if (!alive || epoch !== listEpoch) return
  const ruleResult = results[0], actionResult = results[1]
  try { if (ruleResult.status === 'rejected') throw ruleResult.reason; requireSuccess(ruleResult.value); rules.value = ruleResult.value.rules.map(newestKnownRule); listError.value = ''; if (firstLoad) { firstLoad = false; if (!dirty.value) selectRule(rules.value[0] || null) } else syncSelectedStatus(rules.value.find(rule => rule.id === selected.value?.id)) }
  catch (cause) { listError.value = errorText(cause) }
  try { if (actionResult.status === 'rejected') throw actionResult.reason; requireSuccess(actionResult.value); actions.value = actionResult.value.actions; actionsError.value = '' }
  catch (cause) { actionsError.value = errorText(cause); actions.value = [] }
  loading.value = false
}
function buildInput(): AutomationRuleInput {
  const action = chosenAction.value!
  const trigger: AutomationTrigger = draft.triggerKind === 'interval' ? { kind: 'interval', everyMinutes: draft.everyMinutes, missed: draft.missed } : draft.triggerKind === 'daily' ? { kind: 'daily', time: draft.time, missed: draft.missed } : draft.triggerKind === 'task_success' ? { kind: 'task_success', sourceRuleId: draft.sourceRuleId } : { kind: 'manual' }
  return { ...(selected.value ? { id: selected.value.id, expectedVersion: selected.value.version } : {}), name: draft.name.trim(), enabled: draft.enabled, trigger, action: { kind: action.kind, planId: action.planId, planVersion: action.planVersion } }
}
async function saveRule() {
  if (!canSave.value || busy.value) return
  const epoch = selectionEpoch, key = selected.value?.id || 'new', input = buildInput(); activeRequests.add(key); saving.value = true; configurationError.value = ''; notice.value = ''
  try { const result = await automationRulesApi.saveRule(input); requireSuccess(result); const latest = syncRule(result.rule); if (current(epoch)) { selectRule(latest); notice.value = '规则已保存，后续执行使用此配置版本。' } }
  catch (cause) { if (current(epoch)) { configurationError.value = errorText(cause); versionConflict.value = cause instanceof RequestError && cause.code === 'RULE_VERSION' } }
  finally { activeRequests.delete(key); if (current(epoch)) saving.value = false }
}
async function reloadSelected() { const id = selected.value?.id; if (!id || busy.value) return; await loadData(); if (alive && selected.value?.id === id && !listError.value) selectRule(rules.value.find(rule => rule.id === id) || null) }
async function toggleEnabled() {
  const rule = selected.value; if (!rule || dirty.value || busy.value) return
  const epoch = selectionEpoch; activeRequests.add(rule.id); configurationError.value = ''; notice.value = ''
  try { const result = await automationRulesApi.setEnabled({ id: rule.id, expectedVersion: rule.version, enabled: !rule.enabled }); requireSuccess(result); const latest = syncRule(result.rule); if (current(epoch)) { selectRule(latest); notice.value = latest.enabled ? '规则已启用，后续按保存的触发方式执行。' : '规则已暂停，停止创建新任务；已提交任务继续保留。' } }
  catch (cause) { if (current(epoch)) { configurationError.value = errorText(cause); versionConflict.value = cause instanceof RequestError && cause.code === 'RULE_VERSION' } }
  finally { activeRequests.delete(rule.id) }
}
async function removeRule() {
  const rule = selected.value; if (!rule || busy.value || !deleteConfirmation.value) return
  const epoch = selectionEpoch; activeRequests.add(rule.id); configurationError.value = ''
  try { const result = await automationRulesApi.removeRule(rule.id); requireSuccess(result); rules.value = rules.value.filter(item => item.id !== rule.id); if (current(epoch)) { selectRule(null); notice.value = '规则已删除。' } }
  catch (cause) { if (current(epoch)) configurationError.value = errorText(cause) }
  finally { activeRequests.delete(rule.id) }
}
async function dryRun() {
  const rule = selected.value; if (!rule || busy.value || dirty.value || !selectedActionAvailable.value) return
  const epoch = selectionEpoch; activeRequests.add(rule.id); previewing.value = true; preview.value = null; previewError.value = ''; executionError.value = ''; runConfirmation.value = false
  try { const result = await automationRulesApi.dryRun(rule.id); requireSuccess(result); if (current(epoch)) { preview.value = result.preview; previewRuleVersion.value = rule.version } }
  catch (cause) { if (current(epoch)) previewError.value = errorText(cause) }
  finally { activeRequests.delete(rule.id); if (current(epoch)) previewing.value = false }
}
async function runNow() {
  const rule = selected.value; if (!rule || !canRun.value || !runConfirmation.value) return
  const epoch = selectionEpoch; activeRequests.add(rule.id); executing.value = true; executionError.value = ''
  try {
    const latest = await automationRulesApi.listRules(); requireSuccess(latest); if (!current(epoch)) return
    if (latest.rules.find(item => item.id === rule.id)?.version !== rule.version) { preview.value = null; runConfirmation.value = false; versionConflict.value = true; configurationError.value = '规则配置已更新，请读取最新规则并重新试运行。'; throw new Error('规则版本已变化，本次未提交。') }
    const latestRule = latest.rules.find(item => item.id === rule.id)!
    syncSelectedStatus(latestRule)
    if (versionConflict.value) throw new Error('规则版本已变化，本次未提交。')
    if (!latestRule.enabled || !selected.value?.enabled) throw new Error('规则已暂停，本次未提交。')
    const result = await automationRulesApi.runNow({ id: rule.id, expectedVersion: rule.version }); requireSuccess(result); if (!current(epoch)) return
    runConfirmation.value = false; preview.value = null; notice.value = '已提交一次手动执行，请在执行历史查看结果。'; await loadRuns(1)
  } catch (cause) { if (current(epoch)) { executionError.value = errorText(cause); runConfirmation.value = false; preview.value = null; if (cause instanceof RequestError && cause.code === 'RULE_VERSION') { versionConflict.value = true; configurationError.value = '规则配置已更新，请读取最新规则并重新试运行。' } await loadRuns(1) } }
  finally { activeRequests.delete(rule.id); if (current(epoch)) executing.value = false }
}
async function loadRuns(page: number) {
  const rule = selected.value; if (!rule) return
  const epoch = selectionEpoch, request = ++runsEpoch; clearTimeout(pollTimer); runsLoading.value = true; runsError.value = ''
  try {
    const result = await automationRulesApi.listRuns({ ruleId: rule.id, page, pageSize: PAGE_SIZE }); if (!current(epoch) || request !== runsEpoch) return; requireSuccess(result)
    const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE)); if (page > lastPage) { await loadRuns(lastPage); return }
    runs.value = result.runs; runTotal.value = result.total; runPage.value = result.page
    const latest = await automationRulesApi.listRules(); if (!current(epoch) || request !== runsEpoch) return; requireSuccess(latest)
    syncSelectedStatus(latest.rules.find(item => item.id === rule.id))
  } catch (cause) { if (current(epoch) && request === runsEpoch) runsError.value = errorText(cause) }
  finally { if (current(epoch) && request === runsEpoch) { runsLoading.value = false; pollTimer = setTimeout(() => { void loadRuns(runPage.value) }, 5000) } }
}
function openTask(id: string) { void router.push({ path: '/tasks', query: { taskId: id, from: 'automation-rules' } }) }
function openPlan() { if (selected.value) void router.push(selected.value.action.kind === 'migration' ? '/transfer-plans' : '/file-backups') }
onMounted(loadData)
onBeforeUnmount(() => { alive = false; selectionEpoch++; listEpoch++; runsEpoch++; clearTimeout(pollTimer) })
</script>

<style scoped>
.automation-page { display: flex; flex-direction: column; gap: 14px; height: 100%; min-width: 0; min-height: 0; overflow-y: auto; padding-bottom: 14px; color: var(--pl-text); font-size: 13px; }
.panel { min-width: 0; background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }
.page-header { display: flex; align-items: center; gap: 13px; padding: 18px 20px; flex-shrink: 0; }.header-icon { display: grid; place-items: center; width: 44px; height: 44px; flex-shrink: 0; border-radius: 12px; color: var(--pl-primary); background: var(--pl-primary-soft); }.page-header h1 { font-size: 18px; margin: 0 0 5px; }.page-header p { margin: 0; color: var(--pl-text-secondary); font-size: 12px; }.refresh-all { margin-left: auto; flex-shrink: 0; }
.workspace { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 14px; align-items: start; }.content { display: grid; gap: 14px; min-width: 0; }.rule-sidebar, .configuration, .preview-panel, .history-panel { padding: 17px; }.rule-sidebar { position: sticky; top: 0; max-height: 80vh; overflow-y: auto; }.section-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }.section-heading h2 { font-size: 14px; margin: 0; }.section-heading p { font-size: 12px; margin: 5px 0 0; }.search { width: 100%; box-sizing: border-box; margin-bottom: 10px; }.rule-list { display: grid; gap: 6px; }.rule-item { display: flex; flex-direction: column; gap: 6px; text-align: left; padding: 11px; border: 1px solid transparent; background: transparent; border-radius: 8px; color: var(--pl-text); }.rule-item.active { border-color: var(--pl-primary); background: var(--pl-primary-soft); }.rule-item strong { font-size: 13px; overflow-wrap: anywhere; }.rule-item span, .rule-item small { font-size: 11px; color: var(--pl-text-secondary); }.rule-item i { display: inline-block; width: 6px; height: 6px; margin-right: 4px; border-radius: 50%; background: var(--pl-text-muted); }.rule-item i.enabled { background: var(--pl-success); }
button, input, select { font: inherit; }button { cursor: pointer; }button:disabled { cursor: default; opacity: .5; }button:focus-visible { outline: 2px solid var(--pl-primary); outline-offset: 2px; }input, select { min-width: 0; color: var(--pl-text); border: 1px solid var(--pl-border-strong); background: var(--pl-surface); padding: 8px; border-radius: 7px; font-size: 12px; }input:focus, select:focus { outline: 2px solid var(--pl-primary-soft); border-color: var(--pl-primary); }.button, .text-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; border: 1px solid var(--pl-border); border-radius: 8px; padding: 7px 10px; font-size: 12px; color: var(--pl-text); background: var(--pl-surface); }.button:hover:enabled, .rule-item:hover { background: var(--pl-hover); }.primary { background: var(--pl-primary); color: #fff; border-color: var(--pl-primary); }.primary:hover:enabled { background: var(--pl-primary-hover); }.text-button { border-color: transparent; background: transparent; color: var(--pl-primary); padding: 4px; }.danger { color: var(--pl-danger); }.delete-button { margin-left: auto; }.rule-form { display: grid; gap: 14px; }.field { display: flex; flex-direction: column; gap: 7px; font-size: 12px; font-weight: 600; }.hint, .muted { color: var(--pl-text-secondary); font-size: 12px; font-weight: 400; line-height: 1.65; }.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }.check-label { display: flex; align-items: center; gap: 8px; font-size: 12px; }.check-label input { accent-color: var(--pl-primary); }.schedule { margin: 0; }.actions { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }.empty { display: grid; place-items: center; padding: 22px 6px; text-align: center; color: var(--pl-text-muted); font-size: 12px; }.error { color: var(--pl-danger); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }.notice, .confirmation { padding: 12px; border-radius: 8px; background: var(--pl-warning-soft); color: var(--pl-warning); line-height: 1.75; font-size: 12px; overflow-wrap: anywhere; }.confirmation { margin-top: 13px; border: 1px solid var(--pl-border); }.confirmation p { margin: 0 0 10px; }.confirmation strong + p { margin-top: 7px; }.success-text { color: var(--pl-success); font-size: 12px; line-height: 1.7; }.badge { display: inline-block; padding: 4px 7px; border-radius: 6px; font-size: 11px; white-space: nowrap; }.success { color: var(--pl-success); background: var(--pl-success-soft); }.neutral { color: var(--pl-text-secondary); background: var(--pl-hover); }.warning { color: var(--pl-warning); background: var(--pl-warning-soft); }.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 16px 0; }.metrics > div { padding: 14px; border: 1px solid var(--pl-border); border-radius: 9px; background: var(--pl-surface-subtle); }.metrics span { display: block; color: var(--pl-text-secondary); font-size: 11px; }.metrics strong { display: block; font-size: 21px; margin-top: 8px; }.table-scroll { overflow-x: auto; }table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }th { text-align: left; background: var(--pl-surface-subtle); color: var(--pl-text-secondary); font-size: 11px; padding: 10px; }td { border-top: 1px solid var(--pl-border); padding: 12px 10px; overflow-wrap: anywhere; vertical-align: top; line-height: 1.7; }td small { display: block; font-size: 11px; color: var(--pl-text-secondary); margin-top: 5px; }th:first-child { width: 24%; }th:nth-child(2) { width: 70px; }th:last-child { width: 75px; }.pagination { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding-top: 15px; font-size: 12px; color: var(--pl-text-secondary); }
.history-table th:last-child { width: 95px; }.history-table .text-button { white-space: nowrap; }
@media (max-width: 1100px) { .workspace { grid-template-columns: 1fr; }.rule-sidebar { position: static; max-height: 240px; }.rule-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }.search { max-width: 340px; } }
@media (max-width: 720px) { .page-header { flex-wrap: wrap; padding: 14px; }.page-header > div:nth-child(2) { flex: 1; }.refresh-all { margin-left: 56px; }.rule-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }.form-grid { grid-template-columns: 1fr; }.section-heading { flex-wrap: wrap; }.metrics > div { padding: 10px; }.metrics strong { font-size: 17px; }.history-table { min-width: 580px; } }
</style>
