<template>
  <div class="storage-page">
    <header class="panel page-header"><div class="hero-icon"><ChartPie :size="24" /></div><div class="heading"><h1>空间分析</h1><p>从已索引文件看清占用，逐项核对重复候选。</p></div><button type="button" @click="router.push('/file-catalog')">管理索引范围</button><button type="button" :disabled="loading" @click="refresh">刷新分析</button></header>
    <form class="panel filters" @submit.prevent="applyFilters">
      <label>来源账号<select v-model="draft.accountId" aria-label="来源账号" @change="draft.scopeId = ''"><option value="">全部账号</option><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.name }}</option></select></label>
      <label>索引范围<select v-model="draft.scopeId" aria-label="索引范围"><option value="">全部范围</option><option v-for="scope in availableScopes" :key="scope.id" :value="scope.id">{{ scope.accountNickname }} · {{ scope.rootPath }}</option></select></label>
      <label>文件类型<select v-model="draft.fileType" aria-label="文件类型"><option value="">全部文件类型</option><option v-for="(label, type) in TYPE_LABELS" :key="type" :value="type">{{ label }}</option></select></label>
      <button type="submit" class="primary">应用筛选</button><button type="button" @click="resetFilters">重置</button>
    </form>
    <p class="note">只统计选定范围内已索引的文件字节，同一账号的重叠范围按文件标识去重。文件夹自身的 size 不参与总量；结果会受扫描覆盖与索引更新时间影响。</p>
    <p v-if="error" class="error" role="alert">{{ error }} <button type="button" @click="refresh">重试</button></p>
    <p v-if="metadataError" class="error" role="alert">{{ metadataError }} <button type="button" @click="loadScopes">重读范围</button></p>
    <div v-if="loading && !summary" class="panel empty" role="status">正在汇总本地索引…</div>
    <template v-if="summary">
      <section class="metrics" aria-label="索引空间概览">
        <article class="panel metric"><span>已索引文件占用</span><strong>{{ size(summary.bytes) }}</strong><small>{{ summary.fileCount.toLocaleString() }} 个文件 · {{ summary.directoryCount.toLocaleString() }} 个目录条目</small></article>
        <article class="panel metric"><span>完整扫描范围</span><strong>{{ summary.coverage.completeScopes }} <small>/ {{ summary.coverage.totalScopes }}</small></strong><small>表示已选范围的扫描完成数，不代表全盘覆盖率</small></article>
        <article class="panel metric"><span>扫描未完成</span><strong :class="{ warning: summary.coverage.failedDirectories }">{{ summary.coverage.failedDirectories }} <small>个失败目录</small></strong><small>{{ summary.coverage.pendingDirectories }} 个目录待扫描 · 失败范围可能保留旧索引</small></article>
        <article class="panel metric"><span>最近索引更新</span><strong class="time">{{ date(summary.lastIndexedAt) }}</strong><small>分析生成：{{ date(summary.generatedAt) }}</small></article>
      </section>
      <section v-if="!summary.coverage.totalScopes" class="panel empty"><FolderSearch :size="32" /><strong>还没有可分析的索引范围</strong><span>在文件目录添加范围并启动扫描后，即可分析占用和重复候选。</span><button type="button" @click="router.push('/file-catalog')">前往文件目录</button></section>
      <section v-else class="overview-grid">
        <article class="panel breakdown"><h2>按文件类型</h2><p v-if="!summary.types.length" class="note">当前筛选尚无已索引文件。</p><div v-for="item in summary.types" :key="item.fileType" class="type-row"><div><span>{{ TYPE_LABELS[item.fileType] }}</span><strong>{{ size(item.bytes) }}</strong><small>{{ item.fileCount.toLocaleString() }} 个</small></div><div class="bar"><i :style="{ width: `${summary.bytes ? item.bytes / summary.bytes * 100 : 0}%` }" /></div></div></article>
        <article class="panel breakdown"><div class="section-heading"><h2>账号容量与索引差异</h2><button type="button" :disabled="quotaBusy || !summary.accounts.length" @click="refreshQuotas">{{ quotaBusy ? '正在读取…' : '更新平台容量' }}</button></div><p class="note">平台已用量可能包含未索引范围、回收站与平台计费差异。差值 = 平台已用 − 当前筛选索引量，不能作为扫描覆盖率。</p><div v-for="account in summary.accounts" :key="account.accountId" class="account-row"><strong>{{ account.nickname }} <small>{{ PLATFORM_LABELS[account.platform] }}</small></strong><span>索引 {{ size(account.bytes) }} · {{ account.fileCount.toLocaleString() }} 个文件</span><span v-if="account.quota">平台已用 {{ size(account.quota.used) }} / {{ account.quota.total ? size(account.quota.total) : '总量未知' }} · 差值 {{ signedSize(account.quotaDifference!) }}<small>容量更新 {{ date(account.quota.checkedAt) }}</small></span><span v-else class="note">尚无平台容量快照</span><small v-if="account.status !== 'active'" class="warning">账号不可用，需重新登录后更新</small></div></article>
      </section>
      <details v-if="summary.scopes.length" class="panel coverage"><summary>扫描覆盖与范围占用 · {{ summary.scopes.length }} 个范围</summary><p class="note">每个范围独立统计，重叠范围不能相加。完整完成时间为空表示尚未完整扫描。</p><article v-for="scope in summary.scopes" :key="scope.id" class="scope-row"><div><strong>{{ scope.accountNickname }} · {{ scope.rootPath }}</strong><span class="badge" :class="scope.status === 'completed' ? 'confirmed' : 'candidate'">{{ STATUS_LABELS[scope.status] }}</span></div><p>{{ size(scope.indexedBytes) }} · {{ scope.indexedFiles }} 个文件 · 已读 {{ scope.scannedDirectories }} / 待处理 {{ scope.pendingDirectories }} / 失败 {{ scope.failedDirectories }} 个目录</p><small>完整完成 {{ date(scope.lastCompletedAt) }} · 状态更新 {{ date(scope.updatedAt) }}</small><ul v-if="scope.failures.length"><li v-for="failure in scope.failures" :key="failure.directoryId">{{ failure.path }}：{{ failure.error }}</li></ul></article></details>
    </template>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p><p v-if="actionError" class="error" role="alert">{{ actionError }}</p>
    <section class="panel results">
      <div class="tabs" role="tablist" aria-label="空间分析结果"><button v-for="(label, name) in TABS" :key="name" type="button" role="tab" :aria-selected="tab === name" :class="{ active: tab === name }" @click="changeTab(name)">{{ label }}</button></div>
      <div class="results-heading"><strong>{{ listLoading ? '正在查询…' : `${total.toLocaleString()} ${tab === 'duplicates' ? '个分组' : '条结果'}` }}</strong><label v-if="tab === 'duplicates'">证据状态<select v-model="status" aria-label="证据状态" @change="closeGroup(); loadList(1)"><option value="all">全部</option><option value="candidate">待核验候选</option><option value="confirmed">哈希相同</option><option value="different">已知内容不同</option></select></label></div>
      <p class="note table-note">{{ tab === 'directories' ? '目录占用包含已索引后代文件，父子目录不能相加。' : tab === 'duplicates' ? '同名（忽略大小写）且同大小仅为候选。同算法的可信完整内容哈希相同才标记已确认；内容不同的文件不能作为同一副本整理。' : '按文件字节从大到小排列，仅展示当前筛选内的索引文件。' }}</p>
      <p v-if="listError" class="error table-note" role="alert">{{ listError }} <button type="button" @click="loadList(page)">重读结果</button></p>
      <div v-else-if="listLoading" class="empty" role="status">正在读取本页结果…</div>
      <div v-else-if="!total" class="empty"><FolderSearch :size="30" /><strong>{{ tab === 'duplicates' ? '没有匹配的重复候选分组' : '没有匹配的索引内容' }}</strong><span>可以调整筛选，或前往文件目录检查扫描范围。</span></div>
      <div v-else class="table-scroll"><table><thead><tr><th>{{ tab === 'duplicates' ? '候选名称' : '名称与来源' }}</th><th>{{ tab === 'duplicates' ? '副本 / 潜在占用' : '已索引占用' }}</th><th>{{ tab === 'duplicates' ? '证据状态' : '索引信息' }}</th><th>操作</th></tr></thead><tbody>
        <template v-if="tab === 'directories'"><tr v-for="item in directories" :key="key(item)"><td><strong>{{ item.path }}</strong><small>{{ item.accountNickname }}{{ item.isScopeRoot ? ' · 范围根目录' : '' }}</small></td><td>{{ size(item.bytes) }}</td><td>{{ item.fileCount }} 个后代文件</td><td><button v-if="!item.isScopeRoot" type="button" @click="locate(item)">核对并定位</button><button v-else type="button" @click="router.push('/file-catalog')">管理范围</button></td></tr></template>
        <template v-else-if="tab === 'large'"><tr v-for="item in largeFiles" :key="key(item)"><td><strong>{{ item.name }}</strong><small>{{ item.accountNickname }} · {{ item.path }}</small></td><td>{{ size(item.size) }}</td><td><small>{{ date(item.indexedAt) }}</small><small v-if="item.accountStatus !== 'active'" class="warning">来源账号不可用</small></td><td><button type="button" @click="locate(item)">核对并定位</button></td></tr></template>
        <template v-else><tr v-for="item in groups" :key="JSON.stringify([item.name, item.size])"><td><strong>{{ item.displayName }}</strong><small>单个 {{ size(item.size) }}</small></td><td>{{ item.count }} 份<small>{{ item.status === 'different' ? '内容不同，无重复释放估算' : `保留 1 份最多 ${size(item.possibleReleaseBytes)}` }}</small></td><td><span class="badge" :class="item.status">{{ GROUP_LABELS[item.status] }}</span><small>{{ item.evidenceCount }} / {{ item.count }} 份有哈希证据</small></td><td><button type="button" @click="openGroup(item)">查看副本</button></td></tr></template>
      </tbody></table></div>
      <footer class="pagination"><label>每页<select v-model.number="pageSize" aria-label="每页数量" @change="loadList(1)"><option :value="25">25</option><option :value="50">50</option><option :value="100">100</option></select></label><span>第 {{ page }} / {{ pages }} 页</span><button type="button" :disabled="page <= 1 || listLoading" @click="loadList(page - 1)">上一页</button><button type="button" :disabled="page >= pages || listLoading" @click="loadList(page + 1)">下一页</button></footer>
    </section>
    <section v-if="selectedGroup" class="panel members" aria-label="重复候选副本">
      <div class="section-heading"><h2>{{ selectedGroup.displayName }} · 副本核对</h2><button type="button" @click="closeGroup">关闭副本</button></div>
      <p class="note">先选一份保留，再勾选需要人工核对的整理项。核验只读取本页最多 50 份文件的平台元数据，不下载正文。当前支持 123 云盘 MD5、阿里云盘 SHA1；无支持证据时保持候选。</p>
      <div class="member-actions"><button type="button" :disabled="memberLoading || verifyBusy || !members.length" @click="verify">{{ verifyBusy ? '正在核验…' : '核验本页哈希' }}</button><span v-if="keep">保留：{{ keep.accountNickname }} · {{ keep.path }}</span><span>已选 {{ removeRefs.length }} 个整理项</span></div>
      <p v-if="memberError" class="error" role="alert">{{ memberError }} <button type="button" @click="loadMembers(memberPage)">重读副本</button></p>
      <div v-if="memberLoading" class="empty" role="status">正在读取副本…</div><div v-else-if="!members.length" class="empty">此分组已没有可见副本，请刷新分析。</div>
      <div v-else class="table-scroll"><table><thead><tr><th>保留</th><th>整理项</th><th>文件位置</th><th>内容证据</th><th>来源</th></tr></thead><tbody><tr v-for="item in members" :key="key(item)"><td><input type="radio" name="storage-keep" :checked="!!keep && key(keep) === key(item)" :aria-label="`保留 ${item.accountNickname} ${item.path}`" @change="chooseKeep(item)" /></td><td><input type="checkbox" :checked="removeRefs.some(ref => key(ref) === key(item))" :disabled="!!keep && key(keep) === key(item)" :aria-label="`整理 ${item.accountNickname} ${item.path}`" @change="toggleRemove(item, ($event.target as HTMLInputElement).checked)" /></td><td><strong>{{ item.accountNickname }}</strong><small>{{ item.path }}</small><small>{{ size(item.size) }} · 索引 {{ date(item.indexedAt) }}</small></td><td><template v-if="item.evidence"><strong>{{ item.evidence.algorithm.toUpperCase() }}</strong><code>{{ item.evidence.value }}</code><small>核验 {{ date(item.evidence.checkedAt) }}</small></template><span v-else class="warning">无可信哈希 · 仅候选</span></td><td><button type="button" @click="locate(item)">核对并定位</button></td></tr></tbody></table></div>
      <footer class="pagination"><span>副本第 {{ memberPage }} / {{ memberPages }} 页 · 每页 25 份</span><button type="button" :disabled="memberPage <= 1 || memberLoading" @click="loadMembers(memberPage - 1)">副本上一页</button><button type="button" :disabled="memberPage >= memberPages || memberLoading" @click="loadMembers(memberPage + 1)">副本下一页</button></footer>
      <div class="plan-controls"><button type="button" class="primary" :disabled="!keep || !removeRefs.length || planBusy || verifyBusy" @click="previewPlan">{{ planBusy ? '正在生成…' : '生成整理清单' }}</button><button type="button" @click="clearSelection">清空选择</button></div>
      <article v-if="plan" class="plan-preview" aria-label="整理清单预览"><h3>整理清单预览 · {{ plan.review.length }} 项</h3><p>已确认重复预计释放 <strong>{{ size(plan.confirmedReleaseBytes) }}</strong> · 候选估算 <strong class="warning">{{ size(plan.candidateReleaseBytes) }}</strong></p><p class="note">{{ plan.notice }}</p><div class="export-actions"><button type="button" :disabled="exportBusy" @click="exportPlan('csv')">导出 CSV 清单</button><button type="button" :disabled="exportBusy" @click="exportPlan('json')">导出 JSON 清单</button></div></article>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChartPie, FolderSearch } from 'lucide-vue-next'
import { PLATFORM_LABELS } from '@shared/constants'
import type { CatalogFileType, CatalogRef, CatalogResult, CatalogScanStatus, CatalogScope } from '@shared/catalog'
import type { StorageDirectory, StorageDuplicateGroup, StorageFilter, StorageGroupQuery, StorageMember, StoragePlan, StoragePlanInput, StorageSummary } from '@shared/storage-analysis'
import { storageAnalysisApi as api } from '../api/storage-analysis'
import { catalogApi } from '../api/catalog'

const router = useRouter()
const TYPE_LABELS: Record<CatalogFileType, string> = { folder: '文件夹', video: '视频', audio: '音频', image: '图片', document: '文档', archive: '压缩包', other: '其他文件' }
const STATUS_LABELS: Record<CatalogScanStatus, string> = { idle: '未开始', running: '扫描中', paused: '已暂停', completed: '完整完成', partial: '部分失败', error: '扫描失败' }
const GROUP_LABELS = { candidate: '待核验候选', confirmed: '同算法哈希相同', different: '已知内容不同' }
const TABS = { directories: '目录占用', large: '大文件排行', duplicates: '重复文件候选' }
type Tab = keyof typeof TABS
const draft = reactive({ accountId: '', scopeId: '', fileType: '' as CatalogFileType | '' })
const applied = ref<StorageFilter>({}), scopes = ref<CatalogScope[]>([]), summary = ref<StorageSummary | null>(null)
const accounts = computed(() => [...new Map(scopes.value.map(scope => [scope.accountId, { id: scope.accountId, name: scope.accountNickname }])).values()])
const availableScopes = computed(() => scopes.value.filter(scope => !draft.accountId || scope.accountId === draft.accountId))
const loading = ref(false), error = ref(''), metadataError = ref(''), notice = ref(''), actionError = ref(''), quotaBusy = ref(false)
const tab = ref<Tab>('directories'), page = ref(1), pageSize = ref(25), total = ref(0), status = ref<NonNullable<StorageGroupQuery['status']>>('all')
const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const directories = ref<StorageDirectory[]>([]), largeFiles = ref<StorageMember[]>([]), groups = ref<StorageDuplicateGroup[]>([])
const listLoading = ref(false), listError = ref(''), selectedGroup = ref<StorageDuplicateGroup | null>(null)
const members = ref<StorageMember[]>([]), memberPage = ref(1), memberTotal = ref(0), memberLoading = ref(false), memberError = ref('')
const memberPages = computed(() => Math.max(1, Math.ceil(memberTotal.value / 25)))
const keep = ref<StorageMember | null>(null), removeRefs = ref<CatalogRef[]>([]), plan = ref<StoragePlan | null>(null)
const verifyBusy = ref(false), planBusy = ref(false), exportBusy = ref(false)
let alive = true, summaryVersion = 0, listVersion = 0, memberVersion = 0, groupVersion = 0, planVersion = 0, locationVersion = 0
const key = (item: CatalogRef) => JSON.stringify([item.accountId, item.fileId])
function size(bytes: number) { if (!bytes) return '0 B'; const unit = Math.min(4, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024))); return `${(bytes / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}` }
function signedSize(bytes: number) { return `${bytes < 0 ? '−' : '+'}${size(Math.abs(bytes))}` }
function date(value: number | null) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无记录' }
function ok<T extends object>(result: CatalogResult<T>): T { if (!result.success) throw new Error(result.error); return result }
function failure(cause: unknown) { return cause instanceof Error ? cause.message : '操作未完成，请重试' }
async function loadScopes() {
  try { const result = ok(await catalogApi.listScopes()); if (alive) { scopes.value = result.scopes; metadataError.value = '' } }
  catch (cause) { if (alive) metadataError.value = failure(cause) }
}
async function loadSummary() {
  const version = ++summaryVersion; loading.value = true; error.value = ''
  try { const result = ok(await api.summary(applied.value)); if (alive && version === summaryVersion) summary.value = result.summary }
  catch (cause) { if (alive && version === summaryVersion) error.value = failure(cause) }
  finally { if (alive && version === summaryVersion) loading.value = false }
}
async function loadList(target: number) {
  const version = ++listVersion, selectedTab = tab.value; listLoading.value = true; listError.value = ''; page.value = target
  const query = { ...applied.value, page: target, pageSize: pageSize.value }
  try {
    if (selectedTab === 'directories') { const result = ok(await api.listDirectories(query)); if (!alive || version !== listVersion) return; directories.value = result.items; total.value = result.total }
    else if (selectedTab === 'large') { const result = ok(await api.listLargeFiles(query)); if (!alive || version !== listVersion) return; largeFiles.value = result.items; total.value = result.total }
    else { const result = ok(await api.listDuplicateGroups({ ...query, status: status.value })); if (!alive || version !== listVersion) return; groups.value = result.items; total.value = result.total }
  } catch (cause) { if (alive && version === listVersion) { listError.value = failure(cause); total.value = 0 } }
  finally { if (alive && version === listVersion) listLoading.value = false }
}
function closeGroup() { groupVersion++; memberVersion++; selectedGroup.value = null; members.value = []; memberError.value = ''; verifyBusy.value = false; clearSelection() }
function clearSelection() { keep.value = null; removeRefs.value = []; invalidatePlan() }
function invalidatePlan() { planVersion++; plan.value = null; planBusy.value = false; exportBusy.value = false }
function applyFilters() { applied.value = { accountIds: draft.accountId ? [draft.accountId] : [], scopeIds: draft.scopeId ? [draft.scopeId] : [], fileTypes: draft.fileType ? [draft.fileType] : [] }; closeGroup(); notice.value = ''; actionError.value = ''; summary.value = null; void Promise.allSettled([loadSummary(), loadList(1)]) }
function resetFilters() { Object.assign(draft, { accountId: '', scopeId: '', fileType: '' }); applyFilters() }
function refresh() { closeGroup(); void Promise.allSettled([loadScopes(), loadSummary(), loadList(1)]) }
function changeTab(value: Tab) { if (tab.value === value) return; tab.value = value; closeGroup(); void loadList(1) }
async function openGroup(group: StorageDuplicateGroup) { closeGroup(); selectedGroup.value = group; await loadMembers(1) }
async function loadMembers(target: number) {
  if (!selectedGroup.value) return
  const version = ++memberVersion; memberLoading.value = true; memberError.value = ''; memberPage.value = target
  try { const result = ok(await api.listGroupMembers({ ...applied.value, group: { name: selectedGroup.value.name, size: selectedGroup.value.size }, page: target, pageSize: 25 })); if (alive && version === memberVersion) { members.value = result.items; memberTotal.value = result.total } }
  catch (cause) { if (alive && version === memberVersion) memberError.value = failure(cause) }
  finally { if (alive && version === memberVersion) memberLoading.value = false }
}
function chooseKeep(item: StorageMember) { keep.value = item; removeRefs.value = removeRefs.value.filter(ref => key(ref) !== key(item)); invalidatePlan() }
function toggleRemove(item: StorageMember, checked: boolean) { if (checked && removeRefs.value.length >= 500) { actionError.value = '每份清单最多 500 项，请分批整理'; return }; removeRefs.value = removeRefs.value.filter(ref => key(ref) !== key(item)); if (checked) removeRefs.value.push({ accountId: item.accountId, fileId: item.fileId }); invalidatePlan() }
function planInput(): StoragePlanInput { if (!selectedGroup.value || !keep.value || !removeRefs.value.length) throw new Error('请先选择保留副本及整理项'); return { ...applied.value, group: { name: selectedGroup.value.name, size: selectedGroup.value.size }, keep: { accountId: keep.value.accountId, fileId: keep.value.fileId }, remove: removeRefs.value } }
async function previewPlan() {
  const version = ++planVersion; planBusy.value = true; actionError.value = ''
  try { const result = ok(await api.createPlan(planInput())); if (alive && version === planVersion) plan.value = result.plan }
  catch (cause) { if (alive && version === planVersion) actionError.value = failure(cause) }
  finally { if (alive && version === planVersion) planBusy.value = false }
}
async function exportPlan(format: 'csv' | 'json') {
  const version = planVersion; exportBusy.value = true; actionError.value = ''
  try { const result = ok(await api.exportPlan({ ...planInput(), format })); if (alive && version === planVersion) notice.value = result.cancelled ? '已取消导出，清单仍保留在本页。' : `整理清单已导出：${result.filePath}` }
  catch (cause) { if (alive && version === planVersion) actionError.value = failure(cause) }
  finally { if (alive && version === planVersion) exportBusy.value = false }
}
async function verify() {
  const version = groupVersion; verifyBusy.value = true; actionError.value = ''; invalidatePlan()
  try {
    const result = ok(await api.verifyEvidence({ refs: members.value.slice(0, 50).map(item => ({ accountId: item.accountId, fileId: item.fileId })) }))
    if (!alive || version !== groupVersion) return
    const verified = result.results.filter(item => item.status === 'verified').length
    notice.value = `本次已取得 ${verified} 份哈希证据。${result.results.filter(item => item.status !== 'verified').map(item => item.message).filter((item, index, all) => all.indexOf(item) === index).join('；')}`
    await Promise.allSettled([loadMembers(memberPage.value), loadList(page.value)])
  } catch (cause) { if (alive && version === groupVersion) actionError.value = failure(cause) }
  finally { if (alive && version === groupVersion) verifyBusy.value = false }
}
async function refreshQuotas() {
  quotaBusy.value = true; actionError.value = ''
  try { const ids = summary.value?.accounts.map(item => item.accountId) ?? []; const messages: string[] = []; for (let offset = 0; offset < ids.length; offset += 20) { const result = ok(await api.refreshQuotas({ accountIds: ids.slice(offset, offset + 20) })); messages.push(...result.results.filter(item => !item.success).map(item => `${accounts.value.find(account => account.id === item.accountId)?.name ?? item.accountId}：${item.message}`)) }; if (alive) { notice.value = messages.length ? messages.join('；') : '平台容量已更新。'; await loadSummary() } }
  catch (cause) { if (alive) actionError.value = failure(cause) }
  finally { if (alive) quotaBusy.value = false }
}
async function locate(item: CatalogRef) {
  const version = ++locationVersion; actionError.value = ''
  try { const result = ok(await catalogApi.resolveEntry({ accountId: item.accountId, fileId: item.fileId })); if (alive && version === locationVersion) await router.push({ path: '/files', query: { accountId: result.entry.accountId, fileId: result.entry.fileId, parentId: result.entry.parentId, path: result.entry.path, from: 'catalog' } }) }
  catch (cause) { if (alive && version === locationVersion) actionError.value = `无法确认来源：${failure(cause)}` }
}
onMounted(() => { void Promise.allSettled([loadScopes(), loadSummary(), loadList(1)]) })
onBeforeUnmount(() => { alive = false; summaryVersion++; listVersion++; memberVersion++; groupVersion++; planVersion++; locationVersion++ })
</script>

<style scoped>
.storage-page { height: 100%; min-height: 0; overflow-y: auto; color: var(--pl-text); font-size: 13px; display: flex; flex-direction: column; gap: 14px; padding-bottom: 20px; }
.panel { flex-shrink: 0; min-width: 0; background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }.page-header { display: flex; gap: 12px; align-items: center; padding: 19px 20px; }.hero-icon { padding: 12px; border-radius: 12px; color: var(--pl-primary); background: var(--pl-primary-soft); }.heading { flex: 1; }h1 { margin: 0 0 5px; font-size: 20px; }h2 { margin: 0; font-size: 14px; }h3 { font-size: 14px; margin: 0; }.heading p { margin: 0; color: var(--pl-text-secondary); }
button, select, input { font: inherit; }button { cursor: pointer; border: 1px solid var(--pl-border-strong); background: var(--pl-surface); color: var(--pl-text); border-radius: 7px; padding: 7px 10px; white-space: nowrap; }button:hover:enabled { background: var(--pl-hover); }button:disabled { opacity: .5; cursor: default; }button.primary { background: var(--pl-primary); color: white; border-color: var(--pl-primary); }button.primary:hover:enabled { background: var(--pl-primary-hover); }button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--pl-primary); outline-offset: 2px; }select { min-width: 0; min-height: 34px; padding: 5px 8px; border: 1px solid var(--pl-border-strong); border-radius: 7px; background: var(--pl-surface); color: var(--pl-text); }input { accent-color: var(--pl-primary); }.filters { padding: 16px; display: flex; align-items: end; gap: 12px; flex-wrap: wrap; }.filters label { display: grid; gap: 6px; flex: 1 1 180px; min-width: 0; color: var(--pl-text-secondary); font-size: 12px; }.note { font-size: 12px; color: var(--pl-text-secondary); line-height: 1.7; margin: 0; }.storage-page > .note { padding: 0 4px; }.metrics { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; }.metric { padding: 18px; display: flex; flex-direction: column; gap: 9px; }.metric > span { color: var(--pl-text-secondary); }.metric > strong { font-size: 27px; font-weight: 650; letter-spacing: -.5px; }.metric > strong small { font-size: 13px; font-weight: 400; }.metric .time { font-size: 17px; line-height: 1.5; letter-spacing: 0; }small { color: var(--pl-text-secondary); font-size: 11px; line-height: 1.6; }.metric small { margin-top: auto; }
.overview-grid { display: grid; grid-template-columns: 1fr 1.3fr; gap: 14px; }.breakdown { padding: 18px; }.breakdown h2 { margin-bottom: 14px; }.type-row { margin-top: 16px; }.type-row > div:first-child { display: flex; align-items: baseline; gap: 9px; }.type-row span { flex: 1; }.bar { height: 6px; border-radius: 3px; background: var(--pl-hover); overflow: hidden; margin-top: 7px; }.bar i { display: block; height: 100%; background: var(--pl-primary); border-radius: inherit; }.section-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; }.section-heading h2 { margin: 0; }.breakdown > .note { margin-top: 12px; }.account-row { display: grid; gap: 6px; padding: 13px 0; border-bottom: 1px solid var(--pl-border); }.account-row:last-child { border-bottom: 0; padding-bottom: 0; }.account-row span { font-size: 12px; }.account-row small { display: block; }.account-row strong small { display: inline; font-weight: 400; }.coverage { padding: 16px 18px; }.coverage > summary { cursor: pointer; font-weight: 600; }.coverage > .note { margin-top: 12px; }.scope-row { padding: 13px 0; border-bottom: 1px solid var(--pl-border); }.scope-row:last-child { border: 0; padding-bottom: 0; }.scope-row > div { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }.scope-row p { margin: 8px 0 3px; color: var(--pl-text-secondary); font-size: 12px; }.scope-row ul { color: var(--pl-warning); max-height: 160px; overflow: auto; padding-left: 20px; overflow-wrap: anywhere; }
.tabs { display: flex; gap: 6px; padding: 12px 16px; border-bottom: 1px solid var(--pl-border); }.tabs button { border-color: transparent; background: transparent; color: var(--pl-text-secondary); }.tabs button.active { color: var(--pl-primary); border-color: var(--pl-primary); background: var(--pl-primary-soft); }.results { overflow: hidden; }.results-heading { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px 8px; gap: 14px; }.results-heading label { display: flex; align-items: center; gap: 8px; font-size: 12px; }.table-note { margin: 0 18px 12px; }.table-scroll { overflow-x: auto; }table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }th { background: var(--pl-surface-subtle); color: var(--pl-text-secondary); font-weight: 500; text-align: left; padding: 10px 16px; }td { border-top: 1px solid var(--pl-border); padding: 13px 16px; vertical-align: top; overflow-wrap: anywhere; }td strong { font-size: 13px; }td small { display: block; margin-top: 4px; }th:first-child { width: 35%; }th:last-child { width: 112px; }tbody tr:hover { background: var(--pl-surface-subtle); }.badge { display: inline-block; font-size: 11px; line-height: 1.4; padding: 3px 6px; border-radius: 5px; }.candidate { color: var(--pl-warning); background: var(--pl-warning-soft); }.confirmed { color: var(--pl-success); background: var(--pl-success-soft); }.different { color: var(--pl-text-secondary); background: var(--pl-hover); }.warning { color: var(--pl-warning); }.empty { min-height: 120px; padding: 28px 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 10px; color: var(--pl-text-secondary); }.empty svg { color: var(--pl-text-muted); }.pagination { border-top: 1px solid var(--pl-border); padding: 12px 16px; display: flex; gap: 10px; align-items: center; justify-content: flex-end; flex-wrap: wrap; font-size: 12px; color: var(--pl-text-secondary); }.pagination label { margin-right: auto; display: flex; align-items: center; gap: 7px; }.pagination select { min-height: 30px; }
.members { padding: 18px; }.members > .note { margin-top: 12px; }.member-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 14px 0; }.member-actions span { font-size: 12px; overflow-wrap: anywhere; color: var(--pl-text-secondary); }.members table th:first-child, .members table th:nth-child(2) { width: 45px; }.members table th:nth-child(3) { width: 36%; }.members td, .members th { padding: 10px 8px; }.members code { display: block; max-width: 100%; overflow-wrap: anywhere; color: var(--pl-text-secondary); font-size: 10px; margin-top: 5px; }.plan-controls, .export-actions { display: flex; gap: 9px; flex-wrap: wrap; }.plan-controls { padding-top: 15px; }.plan-preview { margin-top: 16px; padding: 16px; border: 1px solid var(--pl-border-strong); border-radius: 9px; background: var(--pl-surface-subtle); }.plan-preview p { line-height: 1.7; }.export-actions { margin-top: 12px; }.error { color: var(--pl-danger); font-size: 12px; overflow-wrap: anywhere; line-height: 1.7; margin: 0; }.notice { background: var(--pl-primary-soft); color: var(--pl-primary); font-size: 12px; border-radius: 8px; padding: 11px 14px; margin: 0; overflow-wrap: anywhere; line-height: 1.7; }
@media (max-width: 1150px) { .metrics { grid-template-columns: repeat(2,minmax(0,1fr)); }.overview-grid { grid-template-columns: 1fr 1fr; }.page-header { flex-wrap: wrap; }.heading { min-width: 250px; } }
@media (max-width: 780px) { .overview-grid { grid-template-columns: 1fr; }.metrics { gap: 8px; }.metric { padding: 14px; }.metric > strong { font-size: 22px; }.page-header { padding: 15px; }.heading { min-width: 180px; }.tabs { flex-wrap: wrap; }table { min-width: 620px; }.members table { min-width: 720px; }.results-heading { flex-wrap: wrap; }.section-heading { flex-wrap: wrap; } }
</style>
