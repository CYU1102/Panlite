<template>
  <div class="transfer-plans-page">
    <header class="page-header panel"><div class="header-icon"><ClipboardCheck :size="24" /></div><div class="header-copy"><h1>迁移计划</h1><p>保存范围，预演差异，再按已核对的清单执行。</p></div><button class="button" type="button" @click="router.push('/cloud-transfer')">直接迁移</button></header>
    <div class="workspace-grid">
      <aside class="panel plan-sidebar"><div class="section-heading"><h2>已保存计划</h2><button class="text-button" type="button" @click="createNew"><Plus :size="15" />新建</button></div><input v-model="planKeyword" class="plan-search" aria-label="查找迁移计划" placeholder="查找计划" /><p v-if="plansLoading && !plans.length" class="empty-state" role="status">正在读取计划…</p><div v-else-if="plansError" class="error-message" role="alert">{{ plansError }} <button type="button" class="text-button" @click="loadPlans">重试</button></div><div v-else-if="!filteredPlans.length" class="empty-state">{{ plans.length ? '没有匹配的计划' : '还没有迁移计划' }}</div><div class="plan-list"><button v-for="plan in filteredPlans" :key="plan.id" type="button" class="plan-item" :class="{ active: selectedPlan?.id === plan.id }" @click="choosePlan(plan)"><strong>{{ plan.name }}</strong><span>{{ PLAN_STATUS[plan.status] }} · 配置 v{{ plan.version }}</span><small>{{ formatDate(plan.updatedAt) }}</small></button></div></aside>

      <main class="plan-content">
        <section class="panel configuration-panel">
          <div class="section-heading"><div><h2>{{ selectedPlan ? selectedPlan.name : '新建迁移计划' }}</h2><p v-if="selectedPlan" class="muted">配置 v{{ selectedPlan.version }} · {{ PLAN_STATUS[selectedPlan.status] }}{{ dirty ? ' · 有未保存修改' : '' }}</p></div><button v-if="selectedPlan" type="button" class="text-button" :disabled="exporting" @click="exportPlan"><Download :size="15" />{{ exporting ? '正在导出…' : '导出清单' }}</button></div>
          <p v-if="accountsError" class="error-message" role="alert">{{ accountsError }} <button class="text-button" type="button" @click="loadAccounts">重试账号</button></p>
          <p v-if="!accountsLoading && !accounts.length && !accountsError" class="notice">请先在<button type="button" class="text-button" @click="router.push('/accounts')">账号管理</button>添加源与目标账号。</p>
          <p v-if="locked" class="notice">此计划正在预演或执行，暂不能修改配置和删除。暂停、恢复和取消请进入对应任务。</p>
          <form class="plan-form" @submit.prevent="savePlan">
            <label class="field">计划名称<input v-model="draft.name" aria-label="计划名称" maxlength="100" placeholder="例如：项目资料迁移" :disabled="locked || busy" /></label>
            <TransferPlanLocations :key="selectedPlan?.id || 'new'" :accounts="accounts" :source="draft.source" :target="draft.target" :disabled="locked || busy" @select="selectLocation" />
            <div class="configuration-options"><label class="field">排除规则<span class="hint">每行一条相对路径规则；* 匹配名称片段，** 匹配多层目录，? 匹配一个字符。</span><textarea v-model="draft.excludeText" aria-label="排除规则" rows="3" placeholder="**/node_modules/**&#10;*.tmp" :disabled="locked || busy" /></label><label class="field">已确认不同内容的同名项<select v-model="draft.conflictPolicy" aria-label="冲突策略" :disabled="locked || busy"><option value="rename">自动重命名</option><option value="skip">跳过</option><option value="overwrite">覆盖</option></select><span class="hint">缺少可靠内容证据的同名项仍需在预演中明确处理。</span></label></div>
            <div class="configuration-actions"><button type="submit" class="button primary" :disabled="locked || busy || !canSave">{{ saving ? '正在保存…' : '保存计划' }}</button><button v-if="selectedPlan" type="button" class="button" :disabled="locked || busy || dirty" @click="previewPlan">{{ previewing ? '正在预演…' : selectedPlan.latestPreviewId ? '重新预演' : '生成预演' }}</button><span v-if="dirty && selectedPlan" class="muted">保存配置后再预演。</span><button v-if="selectedPlan" type="button" class="text-button danger delete-plan" :disabled="locked || busy" @click="deleteConfirmation = !deleteConfirmation">删除计划</button></div>
          </form>
          <div v-if="deleteConfirmation && selectedPlan" class="confirm-box"><span>删除“{{ selectedPlan.name }}”及其本地计划记录；不会删除网盘文件。</span><button type="button" class="button" :disabled="busy" @click="deleteConfirmation = false">保留</button><button type="button" class="button danger" :disabled="busy || locked" @click="removePlan">确认删除计划</button></div>
          <p v-if="configurationError" class="error-message" role="alert">{{ configurationError }} <button v-if="configurationConflict" class="text-button" type="button" :disabled="busy" @click="reloadConfiguration">放弃草稿并读取最新配置</button></p><p v-if="configurationNotice" class="success-message" role="status">{{ configurationNotice }}</p><p v-if="exportError" class="error-message" role="alert">{{ exportError }}</p>
        </section>

        <section v-if="selectedPlan" class="panel review-panel">
          <div class="tab-bar"><button class="tab" :class="{ active: activeTab === 'preview' }" type="button" @click="activeTab = 'preview'">差异预演</button><button class="tab" :class="{ active: activeTab === 'runs' }" type="button" @click="activeTab = 'runs'; refreshRuns()">执行记录 <span>{{ runs.length }}</span></button></div>
          <template v-if="activeTab === 'preview'">
            <div v-if="previewing" class="empty-state" role="status"><LoaderCircle :size="27" class="spinning" /><strong>正在读取源与目标目录</strong><span>预演只读取远端目录，不会写入、覆盖或删除文件。</span></div>
            <div v-else-if="!preview && !previewError" class="empty-state"><FileSearch :size="32" /><strong>先生成一份差异清单</strong><span>预演会检查文件内容证据，列出待传输与待核对项。</span></div>
            <p v-if="previewError" class="error-message section-message" role="alert">{{ previewError }} <button v-if="selectedPlan.latestPreviewId" type="button" class="text-button" @click="loadPreview(selectedPlan.latestPreviewId, previewPage)">重新读取预演</button></p>
            <template v-if="preview && !previewing">
              <div class="preview-heading"><strong>预演 · 配置 v{{ preview.planVersion }}</strong><span>{{ formatDate(preview.createdAt) }}</span><span class="badge" :class="preview.complete ? 'success' : 'warning'">{{ preview.complete ? '范围读取完整' : '范围未完整读取' }}</span></div>
              <p class="preview-reference">预演编号 {{ preview.id }}</p>
              <div class="summary-grid"><div><strong>{{ preview.summary.addCount }}</strong><span>新增</span></div><div><strong>{{ preview.summary.identicalCount }}</strong><span>内容证据一致</span></div><div><strong>{{ preview.summary.changedCount }}</strong><span>内容变化</span></div><div><strong>{{ preview.summary.conflictCount }}</strong><span>冲突</span></div><div><strong>{{ preview.summary.reviewCount }}</strong><span>待核对</span></div><div><strong>{{ preview.summary.skipCount }}</strong><span>跳过</span></div></div>
              <div class="estimate-strip"><span><ArrowDownUp :size="15" />预计下载与上传流量 <strong>{{ formatSize(preview.summary.transferBytes) }}</strong></span><span><HardDrive :size="15" />临时空间上限 <strong>{{ formatSize(preview.summary.tempBytes) }}</strong></span></div>
              <p class="muted section-note">{{ preview.summary.fileCount }} 个文件 · {{ preview.summary.directoryCount }} 个目录。流量包含下载与上传；服务端复制不计客户端传输流量。<template v-if="preview.summary.reviewCount">待核对项尚未计入估算，处理后会更新。</template>{{ !preview.complete ? '范围未读取完整，以上仅为已列出项目的估算。' : '估算以当前清单为准，未估计完成时间。' }}</p>
              <div v-if="preview.failures.length" class="incomplete-box"><strong>以下范围未完成，不能执行此预演</strong><ul><li v-for="(item, index) in preview.failures.slice(0, 100)" :key="`${item.side}:${item.path}:${index}`">{{ item.side === 'source' ? '源目录' : '目标目录' }} {{ item.path }}：{{ item.reason }}</li></ul><span v-if="preview.failures.length > 100">显示前 100 条未完成记录。</span></div>
              <div v-if="stalePreview || preview.planVersion !== selectedPlan.version" class="stale-box" role="alert"><strong>此预演需要重新生成</strong><span>{{ staleReason || '计划配置或远端对象已发生变化。' }}</span><button class="button" type="button" :disabled="busy || locked || dirty" @click="previewPlan">重新读取目录并预演</button></div>
              <div class="preview-tools"><label class="field">清单分类<select v-model="category" aria-label="预演分类" :disabled="reviewSaving" @change="changeCategory"><option value="">全部项目</option><option v-for="(label, value) in CATEGORY_LABELS" :key="value" :value="value">{{ label }}</option></select></label><label class="field">批量处理<select v-model="batchAction" aria-label="批量处理方式" :disabled="busy || reviewSaving || locked"><option value="skip">跳过</option><option value="rename">自动重命名</option><option value="overwrite">覆盖</option></select></label><button class="button" type="button" :disabled="busy || !selectedItemIds.length || reviewSaving || locked || stalePreview" @click="resolveSelected">处理所选 {{ selectedItemIds.length }} 项</button><button v-if="category" class="text-button" type="button" :disabled="busy || reviewSaving || locked || stalePreview || previewLoading || !previewTotal" @click="categoryConfirmation = !categoryConfirmation">处理此分类全部待核对项</button></div>
              <div v-if="categoryConfirmation" class="confirm-box category-confirmation"><span>将此分类中所有仍需核对的项目设为“{{ ACTION_LABELS[batchAction] }}”。</span><button type="button" class="button" :disabled="reviewSaving" @click="categoryConfirmation = false">取消</button><button type="button" class="button" :disabled="busy || reviewSaving || locked || stalePreview" @click="resolveCategory">确认处理此分类</button></div>
              <p v-if="reviewError" class="error-message section-message" role="alert">{{ reviewError }}</p><p v-if="reviewNotice" class="success-message section-message" role="status">{{ reviewNotice }}</p>
              <div v-if="previewLoading" class="empty-state" role="status">正在读取本页清单…</div>
              <div v-else-if="!previewItems.length" class="empty-state">此分类没有项目。</div>
              <div v-else class="table-scroll"><table class="preview-table"><thead><tr><th class="check-cell"><input type="checkbox" aria-label="选择本页待核对项" :checked="allPageSelected" :disabled="busy || !selectableItems.length || locked || reviewSaving" @change="selectPage($event)" /></th><th>源文件与目标</th><th>差异与依据</th><th>执行方式 / 动作</th><th>核对处理</th></tr></thead><tbody><tr v-for="item in previewItems" :key="item.id" :data-item-id="item.id"><td class="check-cell"><input v-if="item.requiresDecision" v-model="selectedItemIds" type="checkbox" :value="item.id" :aria-label="`选择${item.relativePath}`" :disabled="busy || reviewSaving || locked" /></td><td><strong class="file-path">{{ item.relativePath }}</strong><span class="muted row-line">{{ item.source.isDir ? '文件夹' : formatSize(item.source.size) }} · {{ formatDate(item.source.updatedAt) }}</span><span class="muted row-line">目标：{{ item.outputPath }}</span><span v-if="item.target" class="muted row-line">现有：{{ item.target.isDir ? '文件夹' : formatSize(item.target.size) }} · {{ formatDate(item.target.updatedAt) }}</span></td><td><span class="badge" :class="item.requiresDecision ? 'warning' : 'neutral'">{{ CATEGORY_LABELS[item.category] }}</span><span class="row-line reason">{{ item.reason }}</span><details v-if="item.source.hash || item.target?.hash" class="evidence"><summary>内容证据</summary><span v-if="item.source.hash">源 {{ item.source.hash.algorithm }}：{{ item.source.hash.value }}</span><span v-if="item.target?.hash">目标 {{ item.target.hash.algorithm }}：{{ item.target.hash.value }}</span></details></td><td><span>{{ item.mode === 'native_copy' ? '服务端复制' : '下载后上传' }}</span><strong class="row-line">{{ ACTION_LABELS[item.action] }}</strong></td><td><template v-if="item.requiresDecision"><select v-model="itemActions[item.id]" :aria-label="`处理${item.relativePath}`" :disabled="busy || reviewSaving || locked || stalePreview"><option value="">选择处理方式</option><option value="rename">自动重命名</option><option value="skip">跳过</option><option v-if="canOverwrite(item)" value="overwrite">覆盖</option></select><button class="text-button" type="button" :disabled="busy || !itemActions[item.id] || reviewSaving || locked || stalePreview" @click="resolveItem(item)">保存此项处理</button></template><span v-else class="muted">{{ item.action === 'skip' ? '已跳过' : '已核对' }}</span></td></tr></tbody></table></div>
              <footer class="pagination"><label>每页<select v-model.number="previewPageSize" aria-label="预演每页条数" :disabled="previewLoading || reviewSaving" @change="changeCategory"><option :value="25">25</option><option :value="50">50</option><option :value="100">100</option></select>条</label><span>{{ previewTotal }} 项 · 第 {{ previewPage }} / {{ previewPages }} 页</span><button class="button" type="button" :disabled="previewPage <= 1 || previewLoading || reviewSaving" @click="loadPreview(preview.id, previewPage - 1)">上一页清单</button><button class="button" type="button" :disabled="previewPage >= previewPages || previewLoading || reviewSaving" @click="loadPreview(preview.id, previewPage + 1)">下一页清单</button></footer>
              <div class="execution-box"><div><strong>{{ canExecute ? '预演已完成核对' : '此预演暂不能执行' }}</strong><p>{{ executionHint }}</p></div><button class="button primary" type="button" :disabled="!canExecute || busy" @click="executionConfirmation = !executionConfirmation">执行此预演</button></div>
              <div v-if="executionConfirmation" class="confirm-box execution-confirmation"><span>确认提交配置 v{{ preview.planVersion }} 的预演 {{ preview.id }}。将按清单中的动作向目标网盘写入；开始前再次核对远端对象。</span><button class="button" type="button" :disabled="executing" @click="executionConfirmation = false">取消</button><button class="button primary" type="button" :disabled="!canExecute || executing" @click="executePlan">{{ executing ? '正在核对并提交…' : '确认执行此版本' }}</button></div>
              <p v-if="executionError" class="error-message section-message" role="alert">{{ executionError }}</p>
            </template>
          </template>

          <template v-else>
            <p v-if="runsError" class="error-message section-message" role="alert">{{ runsError }} <button class="text-button" type="button" @click="refreshRuns">重试</button></p>
            <div v-if="runsLoading && !runs.length" class="empty-state" role="status">正在读取执行记录…</div>
            <div v-else-if="!runs.length && !runsError" class="empty-state"><ListChecks :size="30" /><strong>还没有执行记录</strong><span>提交预演后，在这里查看逐文件结果。</span></div>
            <template v-else-if="runs.length"><div class="run-selector"><label class="field">执行批次<select v-model="selectedRunId" aria-label="执行批次" @change="loadReport(selectedRunId, 1)"><option v-for="run in runs" :key="run.id" :value="run.id">{{ formatDate(run.createdAt) }} · {{ RUN_STATUS[run.status] }} · v{{ run.planVersion }}</option></select></label><button class="text-button" type="button" :disabled="reportLoading" @click="loadReport(selectedRunId, reportPage)">刷新报告</button></div>
              <p v-if="reportError" class="error-message section-message" role="alert">{{ reportError }}</p>
              <template v-if="selectedRun"><div class="run-summary"><div><span class="badge" :class="selectedRun.status === 'completed' ? 'success' : ['failed', 'partial', 'stale'].includes(selectedRun.status) ? 'warning' : 'neutral'">{{ RUN_STATUS[selectedRun.status] }}</span><span v-if="selectedRun.taskStatus" class="muted">任务：{{ TASK_STATUS_LABELS[selectedRun.taskStatus] }}</span><strong>成功 {{ selectedRun.succeeded }} · 跳过 {{ selectedRun.skipped }} · 失败 {{ selectedRun.failed }} · 待核对 {{ selectedRun.uncertain }}</strong><p v-if="selectedRun.summary" class="muted">{{ selectedRun.summary }}</p></div><button v-if="selectedRun.taskId" class="button" type="button" @click="openTask(selectedRun.taskId)">查看任务 / 暂停恢复<ExternalLink :size="14" /></button></div><p class="run-reference">预演 {{ selectedRun.previewId }}<template v-if="selectedRun.taskId"> · 任务 {{ selectedRun.taskId }}</template></p></template>
              <div v-if="reportLoading" class="empty-state" role="status">正在读取本页报告…</div><div v-else-if="!reportItems.length && !reportError" class="empty-state">尚无逐文件结果。任务正在运行时可稍后刷新。</div><div v-else-if="reportItems.length" class="table-scroll"><table class="report-table"><thead><tr><th>文件 / 输出位置</th><th>结果</th><th>说明 / 更新时间</th></tr></thead><tbody><tr v-for="item in reportItems" :key="item.itemId"><td><strong class="file-path">{{ item.relativePath }}</strong><span class="row-line muted">{{ item.outputPath }}</span></td><td><span class="badge" :class="item.status === 'success' ? 'success' : ['failed', 'uncertain'].includes(item.status) ? 'warning' : 'neutral'">{{ RESULT_STATUS[item.status] }}</span></td><td><span class="row-line reason">{{ item.error || (item.status === 'uncertain' ? '远端结果需要核对，请查看对应任务。' : '—') }}</span><small class="muted">{{ formatDate(item.updatedAt) }}</small></td></tr></tbody></table></div><footer class="pagination"><span>{{ reportTotal }} 项 · 第 {{ reportPage }} / {{ reportPages }} 页</span><button class="button" type="button" :disabled="reportPage <= 1 || reportLoading" @click="loadReport(selectedRunId, reportPage - 1)">上一页报告</button><button class="button" type="button" :disabled="reportPage >= reportPages || reportLoading" @click="loadReport(selectedRunId, reportPage + 1)">下一页报告</button></footer>
            </template>
          </template>
        </section>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowDownUp, ClipboardCheck, Download, ExternalLink, FileSearch, HardDrive, ListChecks, LoaderCircle, Plus } from 'lucide-vue-next'
import type { DriveAccount, FileConflictPolicy } from '@shared/types'
import { TASK_STATUS_LABELS } from '@shared/constants'
import type { TransferExecutionItem, TransferPlan, TransferPlanAction, TransferPlanCategory, TransferPlanInput, TransferPlanLocation, TransferPlanResult, TransferPreview, TransferPreviewItem, TransferRun } from '@shared/transfer-plan'
import { transferPlansApi } from '../api/transfer-plans'
import { electronApi } from '../api/ipc'
import TransferPlanLocations from '../components/TransferPlanLocations.vue'

const router = useRouter()
const PLAN_STATUS: Record<TransferPlan['status'], string> = { draft: '草稿', previewing: '预演中', ready: '预演就绪', running: '执行中', completed: '已完成', partial: '部分完成', failed: '执行失败', stale: '需重新预演' }
const CATEGORY_LABELS: Record<TransferPlanCategory, string> = { add: '新增', identical: '内容证据一致', changed: '内容变化', conflict: '冲突', review: '人工核对项', excluded: '规则排除', directory: '目录' }
const ACTION_LABELS: Record<TransferPlanAction, string> = { create: '新增', overwrite: '覆盖', rename: '自动重命名', skip: '跳过', merge: '合并目录', review: '待核对' }
const RUN_STATUS: Record<TransferRun['status'], string> = { queued: '已排队', running: '执行中', completed: '已完成', partial: '部分完成', failed: '失败', stale: '预演已过期' }
const RESULT_STATUS: Record<TransferExecutionItem['status'], string> = { success: '成功', skipped: '跳过', failed: '失败', uncertain: '待核对' }
interface PlanDraft { name: string; source: TransferPlanLocation | null; target: TransferPlanLocation | null; excludeText: string; conflictPolicy: FileConflictPolicy }
const emptyDraft = (): PlanDraft => ({ name: '', source: null, target: null, excludeText: '', conflictPolicy: 'rename' })
const accounts = ref<Omit<DriveAccount, 'credential'>[]>([])
const accountsLoading = ref(false)
const accountsError = ref('')
const plans = ref<TransferPlan[]>([])
const plansLoading = ref(false)
const plansError = ref('')
const planKeyword = ref('')
const filteredPlans = computed(() => plans.value.filter(plan => plan.name.toLocaleLowerCase().includes(planKeyword.value.trim().toLocaleLowerCase())))
const selectedPlan = ref<TransferPlan | null>(null)
const draft = reactive<PlanDraft>(emptyDraft())
const savedDraft = ref(JSON.stringify(emptyDraft()))
const dirty = computed(() => JSON.stringify(draft) !== savedDraft.value)
const canSave = computed(() => !!draft.name.trim() && !!draft.source && !!draft.target && (!selectedPlan.value || dirty.value))
const locked = computed(() => !!selectedPlan.value && (['previewing', 'running'].includes(selectedPlan.value.status) || runs.value.some(run => ['pending', 'running', 'paused'].includes(run.taskStatus || '') || ['queued', 'running'].includes(run.status))))
const actionPlans = reactive(new Set<string>())
const busy = computed(() => actionPlans.has(selectedPlan.value?.id || 'new'))
const saving = ref(false)
const previewing = ref(false)
const executing = ref(false)
const configurationError = ref('')
const configurationConflict = ref(false)
const configurationNotice = ref('')
const deleteConfirmation = ref(false)
const activeTab = ref<'preview' | 'runs'>('preview')
const preview = ref<TransferPreview | null>(null)
const previewItems = ref<TransferPreviewItem[]>([])
const previewLoading = ref(false)
const previewError = ref('')
const previewPage = ref(1)
const previewPageSize = ref(50)
const previewTotal = ref(0)
const previewPages = computed(() => Math.max(1, Math.ceil(previewTotal.value / previewPageSize.value)))
const category = ref<TransferPlanCategory | ''>('')
const selectedItemIds = ref<string[]>([])
const itemActions = reactive<Record<string, FileConflictPolicy | ''>>({})
const batchAction = ref<FileConflictPolicy>('skip')
const selectableItems = computed(() => previewItems.value.filter(item => item.requiresDecision))
const allPageSelected = computed(() => !!selectableItems.value.length && selectableItems.value.every(item => selectedItemIds.value.includes(item.id)))
const reviewSaving = ref(false)
const reviewError = ref('')
const reviewNotice = ref('')
const categoryConfirmation = ref(false)
const stalePreview = ref(false)
const staleReason = ref('')
const executionConfirmation = ref(false)
const executionError = ref('')
const canExecute = computed(() => !!preview.value?.complete && !!preview.value?.executable && preview.value.planVersion === selectedPlan.value?.version && !stalePreview.value && !dirty.value && !locked.value && !reviewSaving.value && !previewLoading.value && !previewError.value)
const executionHint = computed(() => previewLoading.value || previewError.value ? '请先成功读取预演清单。' : !preview.value?.complete ? '先解决未完成范围，再重新预演。' : stalePreview.value || preview.value.planVersion !== selectedPlan.value?.version ? '请重新读取远端目录并预演。' : dirty.value ? '请先保存配置并重新预演。' : locked.value ? '已有预演或执行正在进行，请查看任务状态。' : !preview.value?.executable ? '请处理仍需核对的项目。' : '执行前再次检查远端对象；预演过期时会拒绝提交。')
const runs = ref<TransferRun[]>([])
const runsLoading = ref(false)
const runsError = ref('')
const selectedRunId = ref('')
const selectedRun = ref<TransferRun | null>(null)
const reportItems = ref<TransferExecutionItem[]>([])
const reportLoading = ref(false)
const reportError = ref('')
const reportTotal = ref(0)
const reportPage = ref(1)
const REPORT_PAGE_SIZE = 50
const reportPages = computed(() => Math.max(1, Math.ceil(reportTotal.value / REPORT_PAGE_SIZE)))
const exporting = ref(false)
const exportError = ref('')
let alive = true
let selectionVersion = 0
let plansVersion = 0
let accountsVersion = 0
let previewVersion = 0
let runsVersion = 0
let reportVersion = 0
let exportVersion = 0
let initialSelection = true
let pollTimer: ReturnType<typeof setTimeout> | undefined

class PlanRequestError extends Error { constructor(message: string, readonly code?: string) { super(message) } }
function requireSuccess<T extends object>(result: TransferPlanResult<T>): asserts result is { success: true } & T { if (!result.success) throw new PlanRequestError(result.error, result.code) }
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : String(cause) }
function isCurrent(version: number) { return alive && version === selectionVersion }
function formatDate(value: number): string { return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
function formatSize(value: number): string { if (!value) return '0 B'; const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}` }
function setDraft(plan?: TransferPlan) { Object.assign(draft, plan ? { name: plan.name, source: { ...plan.source }, target: { ...plan.target }, excludeText: plan.exclude.join('\n'), conflictPolicy: plan.conflictPolicy } : emptyDraft()); savedDraft.value = JSON.stringify(draft) }
function syncPlan(plan: TransferPlan, updateSelection = true) { const index = plans.value.findIndex(item => item.id === plan.id); if (index < 0) plans.value.unshift(plan); else plans.value[index] = plan; if (updateSelection && selectedPlan.value?.id === plan.id) selectedPlan.value = plan }
function selectLocation(side: 'source' | 'target', value: TransferPlanLocation) { if (!locked.value && !busy.value) draft[side] = { accountId: value.accountId, rootId: value.rootId, rootPath: value.rootPath } }
function clearDetails() {
  selectionVersion++; previewVersion++; runsVersion++; reportVersion++; exportVersion++
  preview.value = null; previewItems.value = []; previewTotal.value = 0; previewPage.value = 1; category.value = ''; previewLoading.value = false; previewError.value = ''
  runs.value = []; selectedRun.value = null; selectedRunId.value = ''; reportItems.value = []; reportTotal.value = 0; reportPage.value = 1; reportError.value = ''; runsError.value = ''; reportLoading.value = false; runsLoading.value = false
  saving.value = false; previewing.value = false; executing.value = false; reviewSaving.value = false; exporting.value = false
  configurationError.value = ''; configurationConflict.value = false; configurationNotice.value = ''; exportError.value = ''; reviewError.value = ''; reviewNotice.value = ''; executionError.value = ''; stalePreview.value = false; staleReason.value = ''
  deleteConfirmation.value = false; executionConfirmation.value = false; categoryConfirmation.value = false; selectedItemIds.value = []; activeTab.value = 'preview'
  for (const id of Object.keys(itemActions)) delete itemActions[id]
}
function createNew() { initialSelection = false; clearDetails(); selectedPlan.value = null; setDraft() }
async function choosePlan(plan: TransferPlan) {
  initialSelection = false; clearDetails(); selectedPlan.value = plan; setDraft(plan)
  stalePreview.value = plan.status === 'stale'
  await Promise.allSettled([plan.latestPreviewId ? loadPreview(plan.latestPreviewId, 1) : Promise.resolve(), refreshRuns()])
}

async function loadAccounts() {
  const version = ++accountsVersion; accountsLoading.value = true
  try { const result = await electronApi.listAccounts(); if (!alive || version !== accountsVersion) return; if (!result.success) throw new Error(result.error || '无法读取账号'); accounts.value = result.accounts; accountsError.value = '' }
  catch (cause) { if (alive && version === accountsVersion) accountsError.value = errorText(cause) }
  finally { if (alive && version === accountsVersion) accountsLoading.value = false }
}
async function loadPlans() {
  const version = ++plansVersion; plansLoading.value = true
  try {
    const result = await transferPlansApi.listPlans(); if (!alive || version !== plansVersion) return; requireSuccess(result)
    plans.value = result.plans; plansError.value = ''
    if (initialSelection && !selectedPlan.value && !dirty.value && result.plans.length) { await choosePlan(result.plans[0]); return }
    const latest = result.plans.find(plan => plan.id === selectedPlan.value?.id)
    if (latest) {
      const retainVersion = dirty.value && selectedPlan.value
      selectedPlan.value = retainVersion ? { ...latest, version: retainVersion.version } : latest
      if (!dirty.value) setDraft(latest)
      if (latest.status === 'stale') stalePreview.value = true
    }
  } catch (cause) { if (alive && version === plansVersion) plansError.value = errorText(cause) }
  finally { if (alive && version === plansVersion) plansLoading.value = false }
}
async function savePlan() {
  if (!canSave.value || busy.value || locked.value || !draft.source || !draft.target) return
  const version = selectionVersion, key = selectedPlan.value?.id || 'new'
  const input: TransferPlanInput = { id: selectedPlan.value?.id, expectedVersion: selectedPlan.value?.version, name: draft.name.trim(), source: { ...draft.source }, target: { ...draft.target }, exclude: draft.excludeText.split(/\r?\n/).map(value => value.trim()).filter(Boolean), conflictPolicy: draft.conflictPolicy }
  actionPlans.add(key); saving.value = true; configurationError.value = ''; configurationConflict.value = false; configurationNotice.value = ''
  try {
    const result = await transferPlansApi.savePlan(input); requireSuccess(result); if (!alive) return; syncPlan(result.plan, isCurrent(version))
    if (!isCurrent(version)) return
    selectedPlan.value = result.plan; setDraft(result.plan); preview.value = null; previewItems.value = []; previewVersion++; stalePreview.value = false; executionConfirmation.value = false
    configurationNotice.value = '计划已保存，可以生成差异预演。'
    await loadPlans()
  } catch (cause) { if (isCurrent(version)) { configurationError.value = errorText(cause); configurationConflict.value = cause instanceof PlanRequestError && ['PLAN_VERSION', 'VERSION_CONFLICT'].includes(cause.code || '') } }
  finally { actionPlans.delete(key); if (isCurrent(version)) saving.value = false }
}
async function reloadConfiguration() {
  const plan = selectedPlan.value, version = selectionVersion
  if (!plan || busy.value) return
  await loadPlans()
  if (!isCurrent(version) || plansError.value) return
  const latest = plans.value.find(item => item.id === plan.id)
  if (latest) await choosePlan(latest)
  else configurationError.value = '计划已不存在，请新建计划。'
}
async function removePlan() {
  const plan = selectedPlan.value; if (!plan || locked.value || busy.value) return
  const version = selectionVersion; actionPlans.add(plan.id); configurationError.value = ''
  try { requireSuccess(await transferPlansApi.removePlan(plan.id)); if (!alive) return; plans.value = plans.value.filter(item => item.id !== plan.id); if (isCurrent(version)) createNew(); await loadPlans() }
  catch (cause) { if (isCurrent(version)) configurationError.value = errorText(cause) }
  finally { actionPlans.delete(plan.id) }
}
async function previewPlan() {
  const plan = selectedPlan.value; if (!plan || dirty.value || busy.value || locked.value) return
  const version = selectionVersion; actionPlans.add(plan.id); previewing.value = true; configurationError.value = ''; previewError.value = ''; executionError.value = ''; activeTab.value = 'preview'; executionConfirmation.value = false; previewVersion++
  try {
    const result = await transferPlansApi.previewPlan(plan.id); requireSuccess(result)
    if (!isCurrent(version)) return
    preview.value = result.preview; stalePreview.value = false; staleReason.value = ''; category.value = ''; reviewError.value = ''; reviewNotice.value = ''
    await loadPreview(result.preview.id, 1)
    await loadPlans()
  } catch (cause) { if (isCurrent(version)) previewError.value = errorText(cause) }
  finally { actionPlans.delete(plan.id); if (isCurrent(version)) previewing.value = false }
}
async function loadPreview(id: string, targetPage: number) {
  const version = ++previewVersion, selection = selectionVersion
  previewLoading.value = true; previewError.value = ''; selectedItemIds.value = []; previewPage.value = targetPage
  try {
    const result = await transferPlansApi.getPreview({ previewId: id, category: category.value || undefined, page: targetPage, pageSize: previewPageSize.value })
    if (!isCurrent(selection) || version !== previewVersion) return; requireSuccess(result)
    preview.value = result.preview; previewTotal.value = result.total
    const last = Math.max(1, Math.ceil(result.total / previewPageSize.value)); if (targetPage > last) { await loadPreview(id, last); return }
    previewItems.value = result.items; previewPage.value = result.page
    for (const item of result.items) itemActions[item.id] = ''
  } catch (cause) { if (isCurrent(selection) && version === previewVersion) { previewError.value = errorText(cause); previewItems.value = []; previewTotal.value = 0 } }
  finally { if (isCurrent(selection) && version === previewVersion) previewLoading.value = false }
}
function changeCategory() { selectedItemIds.value = []; categoryConfirmation.value = false; if (preview.value) void loadPreview(preview.value.id, 1) }
function selectPage(event: Event) { selectedItemIds.value = (event.target as HTMLInputElement).checked ? selectableItems.value.map(item => item.id) : [] }
function canOverwrite(item: TransferPreviewItem) { return !!item.target && !item.source.isDir && !item.target.isDir }
async function resolveItem(item: TransferPreviewItem) { const action = itemActions[item.id]; if (action) await resolveDecisions([{ itemId: item.id, action }]) }
async function resolveSelected() {
  const selected = previewItems.value.filter(item => selectedItemIds.value.includes(item.id) && item.requiresDecision)
  if (batchAction.value === 'overwrite' && selected.some(item => !canOverwrite(item))) { reviewError.value = '所选项包含文件与目录类型冲突，请选择自动重命名或跳过。'; return }
  await resolveDecisions(selected.map(item => ({ itemId: item.id, action: batchAction.value })))
}
function markStale(cause: unknown) { if (cause instanceof PlanRequestError && cause.code === 'STALE_PREVIEW') { stalePreview.value = true; staleReason.value = cause.message; executionConfirmation.value = false } }
async function resolveDecisions(decisions: Array<{ itemId: string; action: FileConflictPolicy }>) {
  const current = preview.value, plan = selectedPlan.value; if (!current || !plan || !decisions.length || busy.value || reviewSaving.value || locked.value || stalePreview.value) return
  const selection = selectionVersion; actionPlans.add(plan.id); reviewSaving.value = true; reviewError.value = ''; reviewNotice.value = ''; executionConfirmation.value = false
  try {
    const result = await transferPlansApi.resolvePreview({ previewId: current.id, decisions }); requireSuccess(result); if (!isCurrent(selection)) return
    preview.value = result.preview; await loadPreview(current.id, previewPage.value); reviewNotice.value = `已保存 ${decisions.length} 项处理方式。`; selectedItemIds.value = []
    await loadPlans()
  } catch (cause) { if (isCurrent(selection)) { reviewError.value = errorText(cause); markStale(cause) } }
  finally { actionPlans.delete(plan.id); if (isCurrent(selection)) reviewSaving.value = false }
}
async function resolveCategory() {
  const current = preview.value, plan = selectedPlan.value, currentCategory = category.value, action = batchAction.value
  if (!current || !plan || !currentCategory || busy.value || reviewSaving.value || locked.value || stalePreview.value) return
  const selection = selectionVersion; actionPlans.add(plan.id); reviewSaving.value = true; reviewError.value = ''; reviewNotice.value = ''; categoryConfirmation.value = false; executionConfirmation.value = false
  let saved = 0
  try {
    const decisions: Array<{ itemId: string; action: FileConflictPolicy }> = []
    for (let nextPage = 1; ; nextPage++) {
      const result = await transferPlansApi.getPreview({ previewId: current.id, category: currentCategory, page: nextPage, pageSize: 100 }); requireSuccess(result); if (!isCurrent(selection)) return
      const pending = result.items.filter(item => item.requiresDecision)
      if (action === 'overwrite' && pending.some(item => !canOverwrite(item))) throw new Error('此分类包含文件与目录类型冲突，请选择自动重命名或跳过。')
      decisions.push(...pending.map(item => ({ itemId: item.id, action })))
      if (nextPage * 100 >= result.total) break
    }
    for (let offset = 0; offset < decisions.length; offset += 100) {
      const result = await transferPlansApi.resolvePreview({ previewId: current.id, decisions: decisions.slice(offset, offset + 100) }); requireSuccess(result); if (!isCurrent(selection)) return
      saved += Math.min(100, decisions.length - offset); preview.value = result.preview
    }
    await loadPreview(current.id, previewPage.value); reviewNotice.value = decisions.length ? `已保存此分类 ${saved} 项处理方式。` : '此分类没有仍需核对的项目。'; await loadPlans()
  } catch (cause) { if (isCurrent(selection)) { reviewError.value = `${saved ? `已保存 ${saved} 项，其余未完成：` : ''}${errorText(cause)}`; markStale(cause); await loadPreview(current.id, previewPage.value) } }
  finally { actionPlans.delete(plan.id); if (isCurrent(selection)) reviewSaving.value = false }
}
async function executePlan() {
  const current = preview.value, plan = selectedPlan.value; if (!current || !plan || !canExecute.value || busy.value) return
  const selection = selectionVersion; actionPlans.add(plan.id); executing.value = true; executionError.value = ''
  try {
    const result = await transferPlansApi.executePlan({ planId: plan.id, previewId: current.id }); requireSuccess(result); if (!isCurrent(selection)) return
    executionConfirmation.value = false; selectedRunId.value = result.run.id; selectedRun.value = result.run; activeTab.value = 'runs'
    await Promise.allSettled([loadPlans(), refreshRuns()])
  } catch (cause) { if (isCurrent(selection)) { executionError.value = errorText(cause); markStale(cause); await loadPlans() } }
  finally { actionPlans.delete(plan.id); if (isCurrent(selection)) executing.value = false }
}
async function refreshRuns() {
  const plan = selectedPlan.value; if (!plan) return
  const selection = selectionVersion, version = ++runsVersion; runsLoading.value = true
  try {
    const result = await transferPlansApi.listRuns(plan.id); if (!isCurrent(selection) || version !== runsVersion) return; requireSuccess(result); runs.value = result.runs; runsError.value = ''
    if (!result.runs.some(run => run.id === selectedRunId.value)) selectedRunId.value = result.runs[0]?.id || ''
    const current = result.runs.find(run => run.id === selectedRunId.value); if (current) selectedRun.value = current
    if (selectedRunId.value && activeTab.value === 'runs') await loadReport(selectedRunId.value, reportPage.value)
  } catch (cause) { if (isCurrent(selection) && version === runsVersion) runsError.value = errorText(cause) }
  finally { if (isCurrent(selection) && version === runsVersion) runsLoading.value = false }
}
async function loadReport(id: string, targetPage: number) {
  if (!id) return
  const selection = selectionVersion, version = ++reportVersion; reportLoading.value = true; reportError.value = ''; reportPage.value = targetPage
  if (selectedRun.value?.id !== id) selectedRun.value = runs.value.find(run => run.id === id) || null
  try {
    const result = await transferPlansApi.getReport({ runId: id, page: targetPage, pageSize: REPORT_PAGE_SIZE }); if (!isCurrent(selection) || version !== reportVersion) return; requireSuccess(result)
    selectedRun.value = result.run; reportTotal.value = result.total
    const runIndex = runs.value.findIndex(run => run.id === result.run.id)
    if (runIndex >= 0) runs.value[runIndex] = result.run
    const last = Math.max(1, Math.ceil(result.total / REPORT_PAGE_SIZE)); if (targetPage > last) { await loadReport(id, last); return }
    reportItems.value = result.items; reportPage.value = result.page
    if (selectedPlan.value?.latestRunId === result.run.id && selectedPlan.value.status === 'running' && !['queued', 'running'].includes(result.run.status)) await loadPlans()
  } catch (cause) { if (isCurrent(selection) && version === reportVersion) { reportError.value = errorText(cause); reportItems.value = []; reportTotal.value = 0 } }
  finally { if (isCurrent(selection) && version === reportVersion) reportLoading.value = false }
}
function openTask(id: string) { void router.push({ path: '/tasks', query: { taskId: id, from: 'transfer-plans' } }) }
async function exportPlan() {
  const plan = selectedPlan.value; if (!plan || exporting.value) return
  const selection = selectionVersion, version = ++exportVersion; exporting.value = true; exportError.value = ''
  try {
    const run = activeTab.value === 'runs' ? selectedRun.value : null
    const result = await transferPlansApi.exportPlan({ planId: plan.id, previewId: run?.previewId || preview.value?.id, runId: run?.id }); requireSuccess(result); if (!isCurrent(selection) || version !== exportVersion) return
    const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = result.fileName; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch (cause) { if (isCurrent(selection) && version === exportVersion) exportError.value = errorText(cause) }
  finally { if (isCurrent(selection) && version === exportVersion) exporting.value = false }
}
async function poll() { await loadPlans(); if (!alive) return; if (selectedPlan.value && !busy.value) await refreshRuns(); if (alive) pollTimer = setTimeout(poll, 5000) }
onMounted(async () => { await Promise.allSettled([loadAccounts(), loadPlans()]); if (alive) pollTimer = setTimeout(poll, 5000) })
onBeforeUnmount(() => { alive = false; selectionVersion++; plansVersion++; accountsVersion++; previewVersion++; runsVersion++; reportVersion++; exportVersion++; clearTimeout(pollTimer) })
</script>

<style scoped>
.transfer-plans-page { display: flex; flex-direction: column; gap: 14px; height: 100%; min-height: 0; min-width: 0; overflow-y: auto; padding-bottom: 12px; color: var(--pl-text); font-size: 13px; }.panel { min-width: 0; background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }.page-header { display: flex; align-items: center; flex-shrink: 0; gap: 12px; padding: 18px 20px; }.header-icon { display: grid; place-items: center; flex-shrink: 0; width: 42px; height: 42px; border-radius: 12px; background: var(--pl-primary-soft); color: var(--pl-primary); }.header-copy { flex: 1; min-width: 0; }.header-copy h1 { margin: 0 0 3px; font-size: 18px; }.header-copy p { margin: 0; color: var(--pl-text-secondary); font-size: 12px; }.workspace-grid { display: grid; grid-template-columns: 215px minmax(0, 1fr); gap: 14px; align-items: start; }.plan-content { display: grid; gap: 14px; min-width: 0; }.plan-sidebar, .configuration-panel { padding: 16px; }.plan-sidebar { position: sticky; top: 0; max-height: 80vh; overflow-y: auto; }.section-heading { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; }.section-heading h2 { margin: 0; font-size: 14px; }.section-heading p { margin: 4px 0 0; }.plan-search { width: 100%; box-sizing: border-box; margin-bottom: 9px; }.plan-list { display: grid; gap: 5px; }.plan-item { display: flex; flex-direction: column; gap: 4px; padding: 11px; text-align: left; color: var(--pl-text); background: transparent; border: 1px solid transparent; border-radius: 8px; }.plan-item strong { overflow-wrap: anywhere; font-size: 13px; }.plan-item span, .plan-item small { color: var(--pl-text-secondary); font-size: 11px; }.plan-item.active { border-color: var(--pl-primary); background: var(--pl-primary-soft); }.plan-item:hover { background: var(--pl-hover); }
button, input, select, textarea { font: inherit; }button { cursor: pointer; }button:disabled { opacity: .5; cursor: default; }input, select, textarea { min-width: 0; color: var(--pl-text); background: var(--pl-surface); border: 1px solid var(--pl-border-strong); border-radius: 7px; padding: 7px 8px; font-size: 12px; }input:focus, select:focus, textarea:focus { outline: 2px solid var(--pl-primary-soft); border-color: var(--pl-primary); }input::placeholder, textarea::placeholder { color: var(--pl-text-muted); }textarea { resize: vertical; }.button, .text-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 7px 10px; border: 1px solid var(--pl-border); border-radius: 8px; color: var(--pl-text); background: var(--pl-surface); font-size: 12px; }.button:hover:enabled { background: var(--pl-hover); }.primary { color: white; background: var(--pl-primary); border-color: var(--pl-primary); }.primary:hover:enabled { background: var(--pl-primary-hover); }.text-button { padding: 4px 3px; color: var(--pl-primary); background: transparent; border: 0; }.text-button:hover:enabled { text-decoration: underline; }.danger { color: var(--pl-danger); }.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; color: var(--pl-text-secondary); font-size: 12px; }.field > input, .field > select, .field > textarea { width: 100%; box-sizing: border-box; }.hint { font-size: 11px; color: var(--pl-text-muted); line-height: 1.6; }.muted { color: var(--pl-text-secondary); font-size: 12px; }.plan-form { display: grid; gap: 14px; }.configuration-options { display: grid; grid-template-columns: 1.25fr 1fr; gap: 14px; }.configuration-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }.delete-plan { margin-left: auto; }.notice, .confirm-box { padding: 12px; border-radius: 8px; background: var(--pl-warning-soft); color: var(--pl-text-secondary); font-size: 12px; line-height: 1.7; }.confirm-box { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }.confirm-box > span { flex: 1 1 260px; overflow-wrap: anywhere; }.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 80px; padding: 30px 16px; text-align: center; color: var(--pl-text-secondary); font-size: 12px; }.review-panel > .empty-state { min-height: 150px; }.empty-state svg { color: var(--pl-text-muted); }.error-message { color: var(--pl-danger); font-size: 12px; overflow-wrap: anywhere; line-height: 1.6; }.success-message { color: var(--pl-success); font-size: 12px; }.section-message, .section-note { margin: 12px 16px; }
.review-panel { overflow: hidden; }.tab-bar { display: flex; gap: 16px; padding: 0 16px; border-bottom: 1px solid var(--pl-border); }.tab { padding: 14px 0 11px; border: 0; border-bottom: 3px solid transparent; background: transparent; color: var(--pl-text-secondary); font-size: 13px; }.tab.active { color: var(--pl-primary); border-bottom-color: var(--pl-primary); }.tab span { font-size: 11px; margin-left: 3px; }.preview-heading { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; padding: 16px 16px 0; }.preview-heading > span:not(.badge) { font-size: 12px; color: var(--pl-text-secondary); }.preview-reference, .run-reference { margin: 7px 16px 14px; color: var(--pl-text-muted); font-size: 11px; overflow-wrap: anywhere; }.summary-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); margin: 14px 16px; gap: 6px; }.summary-grid > div { display: flex; flex-direction: column; gap: 3px; padding: 10px 7px; background: var(--pl-surface-subtle); border-radius: 7px; text-align: center; }.summary-grid strong { color: var(--pl-text); font-size: 20px; }.summary-grid span { color: var(--pl-text-secondary); font-size: 11px; }.estimate-strip { display: flex; flex-wrap: wrap; gap: 12px; margin: 14px 16px 8px; }.estimate-strip > span { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 5px; color: var(--pl-text-secondary); font-size: 12px; }.estimate-strip svg { color: var(--pl-primary); }.estimate-strip strong { color: var(--pl-text); }.badge { display: inline-flex; width: max-content; max-width: 100%; padding: 2px 6px; border-radius: 5px; font-size: 11px; }.success { color: var(--pl-success); background: var(--pl-success-soft); }.warning { color: var(--pl-warning); background: var(--pl-warning-soft); }.neutral { color: var(--pl-text-secondary); background: var(--pl-hover); }.incomplete-box, .stale-box { margin: 12px 16px; padding: 12px; border-radius: 8px; background: var(--pl-warning-soft); color: var(--pl-warning); font-size: 12px; overflow-wrap: anywhere; }.incomplete-box ul { padding-left: 20px; max-height: 180px; overflow-y: auto; }.stale-box { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }.stale-box > span { flex: 1 1 240px; }.preview-tools { display: flex; align-items: end; flex-wrap: wrap; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--pl-border); background: var(--pl-surface-subtle); }.preview-tools .field { flex: 1 1 120px; max-width: 180px; }.category-confirmation, .execution-confirmation { margin: 10px 16px; }.table-scroll { overflow-x: auto; }table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 12px; }th { padding: 9px 10px; text-align: left; color: var(--pl-text-secondary); font-size: 11px; font-weight: 600; background: var(--pl-surface-subtle); }td { padding: 13px 10px; vertical-align: top; border-top: 1px solid var(--pl-border); overflow-wrap: anywhere; }tbody tr:hover { background: var(--pl-surface-subtle); }.preview-table th:nth-child(2) { width: 29%; }.preview-table th:nth-child(3) { width: auto; }.preview-table th:nth-child(4) { width: 94px; }.preview-table th:nth-child(5) { width: 128px; }.check-cell { width: 22px; padding-left: 13px; padding-right: 0; }.check-cell input { accent-color: var(--pl-primary); }.file-path { font-size: 12px; color: var(--pl-text); overflow-wrap: anywhere; }.row-line { display: block; margin-top: 5px; font-size: 11px; line-height: 1.65; }.reason { color: var(--pl-text-secondary); }.preview-table select { width: 100%; padding: 5px 4px; font-size: 11px; }.preview-table .text-button { margin-top: 4px; font-size: 11px; }.evidence { margin-top: 7px; color: var(--pl-text-secondary); font-size: 11px; }.evidence summary { cursor: pointer; }.evidence span { display: block; overflow-wrap: anywhere; margin-top: 5px; }.pagination { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--pl-border); color: var(--pl-text-secondary); font-size: 12px; }.pagination label { display: flex; align-items: center; gap: 5px; margin-right: auto; }.pagination select { padding: 4px 5px; }.execution-box { display: flex; align-items: center; gap: 12px; padding: 15px 16px; border-top: 1px solid var(--pl-border); background: var(--pl-surface-subtle); }.execution-box > div { flex: 1; }.execution-box strong { font-size: 13px; }.execution-box p { color: var(--pl-text-secondary); margin: 5px 0 0; font-size: 12px; }.run-selector { display: flex; align-items: end; gap: 12px; padding: 16px; }.run-selector .field { flex: 1; }.run-summary { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 0 16px; }.run-summary > div { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }.run-summary strong { display: block; flex-basis: 100%; margin-top: 7px; font-size: 13px; }.run-summary p { margin: 0; }.run-summary > button { flex-shrink: 0; }.report-table th:first-child { width: 42%; }.report-table th:nth-child(2) { width: 70px; }.spinning { animation: spin 1.2s linear infinite; }@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 1250px) { .workspace-grid { grid-template-columns: 1fr; }.plan-sidebar { position: static; max-height: 245px; }.plan-sidebar .section-heading { margin-bottom: 8px; }.plan-search { max-width: 320px; }.plan-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }.plan-item { padding: 8px; }.summary-grid strong { font-size: 18px; }.preview-table th:nth-child(2) { width: 28%; }.preview-table th:nth-child(4) { width: 83px; }.preview-table th:nth-child(5) { width: 120px; } }
@media (max-width: 760px) { .page-header { padding: 14px; flex-wrap: wrap; }.header-copy { flex-basis: calc(100% - 58px); }.plan-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }.configuration-options { grid-template-columns: 1fr; }.summary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }.preview-table { min-width: 650px; }.report-table { min-width: 510px; }.execution-box, .run-summary { flex-wrap: wrap; }.run-summary > button { margin-top: 6px; } }
</style>
