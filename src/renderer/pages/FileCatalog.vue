<template>
  <div class="catalog-page">
    <header class="page-header panel">
      <div class="header-icon"><Library :size="23" /></div>
      <div class="header-copy"><h1>统一文件目录</h1><p>搜索已索引的跨盘文件，离线也能查找位置。</p></div>
      <button type="button" class="button" @click="router.push('/global-search')"><Search :size="15" />在线搜索</button>
    </header>

    <p class="local-note"><Info :size="15" /><span>{{ networkOnline ? '搜索只读取本地元数据，账号可用不代表远端连接已验证。' : '当前设备离线，仍可搜索已有索引；扫描和来源定位需要网络。' }} 索引可能滞后于网盘，移动、删除和迁移请在核对来源后进入文件管理。</span></p>

    <section class="panel scope-panel">
      <div class="section-heading">
        <button type="button" class="section-toggle" :aria-expanded="showScopes" @click="showScopes = !showScopes"><ChevronDown :size="17" :class="{ collapsed: !showScopes }" /><strong>索引范围</strong><span>{{ scopes.length }} 个范围 · {{ runningCount }} 个扫描中</span></button>
        <button type="button" class="button" :disabled="accountsLoading" @click="showPicker = !showPicker; showScopes = true"><Plus :size="15" />添加目录</button>
      </div>
      <p v-if="accountsError" class="error-message" role="alert">{{ accountsError }} <button type="button" class="text-button" @click="loadAccounts">重新读取账号</button></p>
      <p v-if="scopesError" class="error-message" role="alert">{{ scopesError }} <button type="button" class="text-button" @click="loadScopes">重试</button></p>
      <template v-if="showScopes">
        <CatalogScopePicker v-if="showPicker" :accounts="accounts" :saving="addingScope" @cancel="showPicker = false" @select="addScope" />
        <p v-if="scopeActionError" class="error-message" role="alert">{{ scopeActionError }}</p>
        <div v-if="scopesLoading && !scopes.length" class="empty-state" role="status">正在读取索引范围…</div>
        <div v-else-if="!scopes.length && !scopesError" class="empty-state"><FolderSearch :size="28" /><strong>从一个常用目录开始</strong><span>选择账号和目录后启动扫描。仅保存文件名、路径等元数据，不下载文件正文。</span><button v-if="!accountsLoading && !accounts.length" class="text-button" type="button" @click="router.push('/accounts')">前往添加网盘账号</button></div>
        <div v-else class="scope-list">
          <article v-for="scope in scopes" :key="scope.id" class="scope-row" :data-scope-id="scope.id">
            <div class="scope-summary"><strong>{{ scope.rootPath }}</strong><span>{{ scope.accountNickname }} · {{ PLATFORM_LABELS[scope.platform] }}</span></div>
            <div class="scope-progress"><span class="badge" :class="statusTone(scope.status)">{{ STATUS_LABELS[scope.status] }}</span><span>已读 {{ scope.scannedDirectories }} 个目录 · 待处理 {{ scope.pendingDirectories }} · 失败 {{ scope.failedDirectories }} · {{ scope.entryCount.toLocaleString() }} 条索引</span><small>上次完整完成：{{ formatDate(scope.lastCompletedAt) }} · 状态更新：{{ formatDate(scope.updatedAt) }}</small><small v-if="scope.accountStatus !== 'active'" class="warning-text">{{ accountState(scope.accountStatus) }}</small></div>
            <div class="scope-actions">
              <button v-if="scope.status === 'running'" type="button" class="button" :disabled="scopeBusy.has(scope.id)" @click="scanAction(scope, 'pauseScan')">暂停</button>
              <button v-else-if="scope.status === 'paused' || scope.status === 'partial' || scope.status === 'error'" type="button" class="button" :disabled="scopeBusy.has(scope.id)" @click="scanAction(scope, 'resumeScan')">{{ scope.status === 'paused' ? '恢复' : '重试未完成目录' }}</button>
              <button v-if="scope.status !== 'running'" type="button" class="button" :disabled="scopeBusy.has(scope.id)" @click="scanAction(scope, 'startScan')">{{ scope.status === 'idle' ? '启动扫描' : '重新扫描' }}</button>
              <button type="button" class="text-button danger" :disabled="scopeBusy.has(scope.id) || scope.status === 'running'" @click="removeScopeTarget = removeScopeTarget === scope.id ? '' : scope.id">移除范围</button>
            </div>
            <details v-if="scope.failures.length" class="scope-failures"><summary>{{ scope.failedDirectories }} 个目录读取失败，旧索引已保留</summary><p v-if="scope.failures.length < scope.failedDirectories">显示前 {{ scope.failures.length }} 条失败记录。</p><ul><li v-for="failure in scope.failures" :key="failure.directoryId"><strong>{{ failure.path }}</strong>：{{ failure.error }}</li></ul></details>
            <div v-if="removeScopeTarget === scope.id" class="confirm-row"><span>移除此范围的扫描记录和不再被其他范围引用的索引；远端文件不受影响。</span><button class="button" type="button" :disabled="scopeBusy.has(scope.id)" @click="removeScopeTarget = ''">保留</button><button class="button danger" type="button" :disabled="scopeBusy.has(scope.id)" @click="removeScope(scope)">确认移除范围</button></div>
          </article>
        </div>
      </template>
    </section>

    <form class="panel search-panel" @submit.prevent="applySearch">
      <div class="search-main"><label class="search-input"><Search :size="18" /><input v-model="filters.keyword" aria-label="文件名称" maxlength="256" placeholder="搜索文件名称，支持中文短词" /></label><button class="button primary" type="submit">搜索本地目录</button><button class="button" type="button" :aria-expanded="showFilters" @click="showFilters = !showFilters"><SlidersHorizontal :size="15" />筛选</button></div>
      <div v-if="showFilters" class="filter-grid">
        <label class="field">路径包含<input v-model="filters.path" aria-label="路径包含" maxlength="4096" placeholder="如 /项目/设计" /></label>
        <label class="field">来源账号<select v-model="filters.accountId" aria-label="来源账号"><option value="">全部账号</option><option v-for="account in searchAccounts" :key="account.id" :value="account.id">{{ account.nickname }}</option></select></label>
        <label class="field">文件类型<select v-model="filters.fileType" aria-label="文件类型"><option value="">全部类型</option><option v-for="(name, type) in TYPE_LABELS" :key="type" :value="type">{{ name }}</option></select></label>
        <label class="field">标签包含<input v-model="filters.tags" aria-label="标签包含" list="catalog-tag-list" placeholder="多个标签用逗号分隔" /></label>
        <label class="field">最小大小（MB）<input v-model="filters.minSize" aria-label="最小大小" type="number" min="0" step="any" /></label>
        <label class="field">最大大小（MB）<input v-model="filters.maxSize" aria-label="最大大小" type="number" min="0" step="any" /></label>
        <label class="field">修改日期起<input v-model="filters.dateFrom" aria-label="修改日期起" type="date" /></label>
        <label class="field">修改日期止<input v-model="filters.dateTo" aria-label="修改日期止" type="date" /></label>
        <label class="field">索引范围<select v-model="filters.scopeId" aria-label="索引范围"><option value="">全部范围</option><option v-for="scope in scopes" :key="scope.id" :value="scope.id">{{ scope.accountNickname }} · {{ scope.rootPath }}</option></select></label>
        <label class="field">排序<select v-model="filters.sort" aria-label="排序"><option value="updatedAt:desc">最近修改</option><option value="indexedAt:desc">最近索引</option><option value="name:asc">名称升序</option><option value="size:desc">文件从大到小</option><option value="path:asc">路径升序</option></select></label>
        <button class="text-button reset-filter" type="button" @click="resetFilters">重置筛选</button>
      </div>
      <datalist id="catalog-tag-list"><option v-for="tag in tags.slice(0, 200)" :key="tag" :value="tag" /></datalist>
      <p v-if="filterError" class="error-message" role="alert">{{ filterError }}</p>
    </form>

    <section class="panel results-panel">
      <div class="collection-bar"><button type="button" class="collection-chip" :class="{ active: !activeCollection && !favoriteOnly }" @click="selectCollection('', false)">全部文件</button><button type="button" class="collection-chip" :class="{ active: favoriteOnly }" @click="selectCollection('', true)"><Star :size="14" />我的收藏</button><button v-for="collection in collections" :key="collection.id" type="button" class="collection-chip" :class="{ active: activeCollection === collection.id }" @click="selectCollection(collection.id, false)">{{ collection.name }}<small>{{ collection.entryCount }}</small></button><button type="button" class="text-button" @click="showCollectionManager = !showCollectionManager"><Plus :size="14" />管理集合</button></div>
      <div v-if="showCollectionManager" class="collection-manager">
        <form class="collection-create" @submit.prevent="saveCollection"><label class="field">{{ editingCollectionId ? '重命名集合' : '新建虚拟集合' }}<input v-model="collectionName" aria-label="集合名称" maxlength="80" placeholder="例如：项目参考资料" :disabled="collectionSaving" /></label><button class="button" type="submit" :disabled="!collectionName.trim() || collectionSaving">{{ collectionSaving ? '正在保存…' : '保存集合' }}</button><button v-if="editingCollectionId" type="button" class="text-button" :disabled="collectionSaving" @click="editingCollectionId = ''; collectionName = ''">取消重命名</button></form>
        <p class="muted">集合只保存本地引用，添加、移除成员不会移动远端文件。</p>
        <div v-for="collection in collections" :key="collection.id" class="collection-manage-row"><span>{{ collection.name }}</span><button type="button" class="text-button" :disabled="collectionSaving || collectionBusy.has(collection.id)" @click="editingCollectionId = collection.id; collectionName = collection.name">重命名</button><button type="button" class="text-button danger" :disabled="collectionBusy.has(collection.id)" @click="removeCollectionTarget = collection.id">删除集合</button><template v-if="removeCollectionTarget === collection.id"><span class="muted">仅删除集合及其成员引用。</span><button class="button danger" type="button" :disabled="collectionBusy.has(collection.id)" @click="removeCollection(collection.id)">确认删除集合</button><button class="text-button" type="button" @click="removeCollectionTarget = ''">取消</button></template></div>
      </div>
      <p v-if="collectionsError || tagsError" class="error-message" role="alert">{{ collectionsError || tagsError }} <button type="button" class="text-button" @click="loadMetadata">重试</button></p>
      <p v-if="collectionActionError" class="error-message" role="alert">{{ collectionActionError }}</p>
      <div class="results-heading"><strong>{{ searching ? '正在查询…' : `${total.toLocaleString()} 个结果` }}</strong><span>按页读取 · 不包含文件正文</span><button type="button" class="text-button" :disabled="searching" @click="searchPage(page)">刷新结果</button></div>

      <section v-if="selectedEntry" class="entry-editor" aria-label="编辑本地文件信息">
        <div class="editor-title"><strong>{{ selectedEntry.name }}</strong><button type="button" class="text-button" aria-label="关闭文件信息" @click="closeEditor"><X :size="16" /></button></div>
        <p class="editor-path">{{ selectedEntry.accountNickname }} · {{ selectedEntry.path }}</p>
        <div class="editor-forms">
          <form @submit.prevent="saveTags"><label class="field">本地标签<input v-model="tagsDraft" aria-label="本地标签" placeholder="用逗号分隔，例如：项目，待整理" :disabled="tagSaving" /></label><button class="button" type="submit" :disabled="tagSaving">{{ tagSaving ? '正在保存…' : '保存标签' }}</button></form>
          <form @submit.prevent="saveEntryCollections"><fieldset :disabled="entryCollectionsSaving || !!collectionsError"><legend>所属虚拟集合</legend><label v-for="collection in collections" :key="collection.id" class="checkbox-label"><input v-model="entryCollectionDraft" type="checkbox" :value="collection.id" :aria-label="`加入${collection.name}`" />{{ collection.name }}</label><span v-if="!collections.length" class="muted">先使用“管理集合”创建集合。</span></fieldset><button class="button" type="submit" :disabled="entryCollectionsSaving || !!collectionsError || !collections.length">{{ entryCollectionsSaving ? '正在保存…' : '保存集合归属' }}</button></form>
        </div>
        <p v-if="editorError" class="error-message" role="alert">{{ editorError }}</p><p v-if="editorNotice" class="success-message" role="status">{{ editorNotice }}</p>
      </section>

      <p v-if="entryActionError" class="error-message" role="alert">{{ entryActionError }}</p>
      <div v-if="searchError" class="empty-state error-message" role="alert"><strong>本地目录查询失败</strong><span>{{ searchError }}</span><button type="button" class="button" @click="searchPage(page)">重新查询</button></div>
      <div v-else-if="searching" class="empty-state" role="status">正在读取本页索引…</div>
      <div v-else-if="!entries.length" class="empty-state"><FolderSearch :size="32" /><strong>{{ scopes.length ? '没有匹配的索引文件' : '还没有索引内容' }}</strong><span>{{ scopes.length ? '调整筛选条件，或检查索引范围是否已完成扫描。' : '添加目录并启动扫描后，文件会显示在这里。' }}</span></div>
      <div v-else class="table-scroll">
        <table class="result-table"><thead><tr><th class="favorite-cell"><span class="sr-only">收藏</span></th><th>文件与来源</th><th>大小 / 修改日期</th><th title="索引超过 24 小时或账号不可用时标记待更新">索引状态 ⓘ</th><th><span class="sr-only">来源操作</span></th></tr></thead><tbody>
          <tr v-for="entry in entries" :key="entryKey(entry)" :class="{ selected: selectedEntry && entryKey(selectedEntry) === entryKey(entry) }" :data-entry-key="entryKey(entry)">
            <td class="favorite-cell"><button type="button" class="favorite-button" :class="{ marked: entry.favorite }" :aria-label="`${entry.favorite ? '取消收藏' : '收藏'}${entry.name}`" :aria-pressed="entry.favorite" :disabled="entryBusy.has(`favorite:${entryKey(entry)}`)" @click="toggleFavorite(entry)"><Star :size="17" :fill="entry.favorite ? 'currentColor' : 'none'" /></button></td>
            <td class="file-cell"><button class="file-name" type="button" @click="openEditor(entry)"><component :is="entry.isDir ? Folder : File" :size="17" /><strong>{{ entry.name }}</strong></button><div class="file-path" :title="entry.path">{{ entry.path }}</div><div class="file-source">{{ PLATFORM_LABELS[entry.platform] }} · {{ entry.accountNickname }} · {{ TYPE_LABELS[entry.fileType] }}</div><div v-if="entry.tags.length" class="tag-row"><span v-for="tag in entry.tags" :key="tag" class="tag">{{ tag }}</span></div></td>
            <td class="date-cell"><span>{{ entry.isDir ? '文件夹' : formatSize(entry.size) }}</span><small>{{ formatDate(entry.updatedAt) }}</small></td>
            <td class="index-cell"><span class="badge" :class="isStale(entry) ? 'warning' : 'neutral'">{{ isStale(entry) ? '索引待更新' : '本地索引' }}</span><small>{{ formatDate(entry.indexedAt) }}</small><small :class="{ 'warning-text': entry.accountStatus !== 'active' || !networkOnline }">{{ networkOnline ? accountState(entry.accountStatus) : '设备离线' }}</small></td>
            <td class="locate-cell"><button type="button" class="text-button" :disabled="entryBusy.has(`locate:${entryKey(entry)}`) || entry.accountStatus === 'missing'" @click="locateEntry(entry)"><ExternalLink :size="14" />{{ entryBusy.has(`locate:${entryKey(entry)}`) ? '核对中…' : '核对并定位' }}</button></td>
          </tr>
        </tbody></table>
      </div>
      <footer class="pagination"><label>每页<select v-model.number="pageSize" aria-label="每页条数" :disabled="searching" @change="searchPage(1)"><option :value="25">25</option><option :value="50">50</option><option :value="100">100</option></select>条</label><span>第 {{ page }} / {{ totalPages }} 页</span><button type="button" class="button" :disabled="page <= 1 || searching" @click="searchPage(page - 1)">上一页</button><button type="button" class="button" :disabled="page >= totalPages || searching" @click="searchPage(page + 1)">下一页</button></footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronDown, ExternalLink, File, Folder, FolderSearch, Info, Library, Plus, Search, SlidersHorizontal, Star, X } from 'lucide-vue-next'
import { PLATFORM_LABELS } from '@shared/constants'
import type { DriveAccount } from '@shared/types'
import type { CatalogCollection, CatalogEntry, CatalogFileType, CatalogQuery, CatalogResult, CatalogScanStatus, CatalogScope, CatalogScopeInput } from '@shared/catalog'
import { catalogApi } from '../api/catalog'
import { electronApi } from '../api/ipc'
import CatalogScopePicker from '../components/CatalogScopePicker.vue'

const router = useRouter()
const STATUS_LABELS: Record<CatalogScanStatus, string> = { idle: '未开始', running: '扫描中', paused: '已暂停', completed: '已完成', partial: '部分失败', error: '扫描失败' }
const TYPE_LABELS: Record<CatalogFileType, string> = { folder: '文件夹', video: '视频', audio: '音频', image: '图片', document: '文档', archive: '压缩包', other: '其他文件' }
const accounts = ref<Omit<DriveAccount, 'credential'>[]>([])
const accountsLoading = ref(false)
const accountsError = ref('')
const scopes = ref<CatalogScope[]>([])
const scopesLoading = ref(false)
const scopesError = ref('')
const scopeActionError = ref('')
const scopeBusy = reactive(new Set<string>())
const showScopes = ref(true)
const showPicker = ref(false)
const addingScope = ref(false)
const removeScopeTarget = ref('')
const runningCount = computed(() => scopes.value.filter(scope => scope.status === 'running').length)
const collections = ref<CatalogCollection[]>([])
const tags = ref<string[]>([])
const collectionsError = ref('')
const tagsError = ref('')
const collectionActionError = ref('')
const showCollectionManager = ref(false)
const collectionName = ref('')
const editingCollectionId = ref('')
const collectionSaving = ref(false)
const collectionBusy = reactive(new Set<string>())
const removeCollectionTarget = ref('')
const activeCollection = ref('')
const favoriteOnly = ref(false)
const networkOnline = ref(navigator.onLine)
const filters = reactive({ keyword: '', path: '', accountId: '', fileType: '' as CatalogFileType | '', tags: '', minSize: '', maxSize: '', dateFrom: '', dateTo: '', scopeId: '', sort: 'updatedAt:desc' })
const showFilters = ref(false)
const filterError = ref('')
const appliedQuery = ref<CatalogQuery>({ sortBy: 'updatedAt', sortOrder: 'desc' })
const entries = ref<CatalogEntry[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const searching = ref(false)
const searchError = ref('')
const entryActionError = ref('')
const entryBusy = reactive(new Set<string>())
const selectedEntry = ref<CatalogEntry | null>(null)
const tagsDraft = ref('')
const entryCollectionDraft = ref<string[]>([])
const tagSaving = ref(false)
const entryCollectionsSaving = ref(false)
const editorError = ref('')
const editorNotice = ref('')
const searchAccounts = computed(() => {
  const result = new Map(accounts.value.map(account => [account.id, { id: account.id, nickname: account.nickname }]))
  for (const scope of scopes.value) if (!result.has(scope.accountId)) result.set(scope.accountId, { id: scope.accountId, nickname: `${scope.accountNickname}（已移除）` })
  return [...result.values()]
})
let alive = true
let searchVersion = 0
let scopesVersion = 0
let metadataVersion = 0
let accountsVersion = 0
let editorVersion = 0
let locationVersion = 0
let pollTimer: ReturnType<typeof setTimeout> | undefined

function failure(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
function requireSuccess<T extends object>(result: CatalogResult<T>): asserts result is { success: true } & T { if (!result.success) throw new Error(result.error) }
function entryKey(entry: Pick<CatalogEntry, 'accountId' | 'fileId'>): string { return JSON.stringify([entry.accountId, entry.fileId]) }
function splitTags(value: string): string[] { return [...new Set(value.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))] }
function formatDate(value: number | null): string { return value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚无记录' }
function formatSize(value: number): string { if (!value) return '0 B'; const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}` }
function accountState(status: CatalogEntry['accountStatus']): string { return ({ active: '账号可用 · 连接未验证', expired: '账号登录已过期', error: '账号状态异常', missing: '来源账号已移除' })[status] }
function statusTone(status: CatalogScanStatus): string { return status === 'completed' ? 'success' : ['error', 'partial'].includes(status) ? 'warning' : status === 'running' ? 'primary-badge' : 'neutral' }
function isStale(entry: CatalogEntry): boolean { return !entry.indexedAt || Date.now() - entry.indexedAt > 24 * 60 * 60 * 1000 || entry.accountStatus !== 'active' }

async function loadAccounts() {
  const version = ++accountsVersion
  accountsLoading.value = true
  try {
    const result = await electronApi.listAccounts()
    if (!alive || version !== accountsVersion) return
    if (!result.success) throw new Error(result.error || '读取账号失败')
    accounts.value = result.accounts
    accountsError.value = ''
  } catch (cause) { if (alive && version === accountsVersion) accountsError.value = failure(cause) }
  finally { if (alive && version === accountsVersion) accountsLoading.value = false }
}

async function loadScopes() {
  const version = ++scopesVersion
  scopesLoading.value = true
  try {
    const result = await catalogApi.listScopes()
    if (!alive || version !== scopesVersion) return
    requireSuccess(result)
    scopes.value = result.scopes
    scopesError.value = ''
  } catch (cause) { if (alive && version === scopesVersion) scopesError.value = failure(cause) }
  finally { if (alive && version === scopesVersion) scopesLoading.value = false }
}

async function loadMetadata() {
  const version = ++metadataVersion
  const result = await Promise.allSettled([catalogApi.listCollections(), catalogApi.listTags()])
  if (!alive || version !== metadataVersion) return
  const [collectionResult, tagResult] = result
  if (collectionResult.status === 'fulfilled' && collectionResult.value.success) { collections.value = collectionResult.value.collections; collectionsError.value = '' }
  else collectionsError.value = collectionResult.status === 'rejected' ? failure(collectionResult.reason) : !collectionResult.value.success ? collectionResult.value.error : ''
  if (tagResult.status === 'fulfilled' && tagResult.value.success) { tags.value = tagResult.value.tags; tagsError.value = '' }
  else tagsError.value = tagResult.status === 'rejected' ? failure(tagResult.reason) : !tagResult.value.success ? tagResult.value.error : ''
}

async function addScope(input: CatalogScopeInput) {
  if (addingScope.value) return
  addingScope.value = true
  scopeActionError.value = ''
  try {
    const result = await catalogApi.addScope({ accountId: input.accountId, rootId: input.rootId, rootPath: input.rootPath })
    requireSuccess(result)
    if (!alive) return
    showPicker.value = false
    await loadScopes()
  } catch (cause) { if (alive) scopeActionError.value = failure(cause) }
  finally { if (alive) addingScope.value = false }
}

async function scanAction(scope: CatalogScope, action: 'startScan' | 'pauseScan' | 'resumeScan') {
  if (scopeBusy.has(scope.id)) return
  scopeBusy.add(scope.id)
  scopeActionError.value = ''
  try {
    const result = await catalogApi[action](scope.id)
    requireSuccess(result)
    if (!alive) return
    await loadScopes()
    await searchPage(page.value)
  } catch (cause) { if (alive) scopeActionError.value = `${scope.rootPath}：${failure(cause)}` }
  finally { scopeBusy.delete(scope.id) }
}

async function removeScope(scope: CatalogScope) {
  if (scopeBusy.has(scope.id)) return
  scopeBusy.add(scope.id)
  scopeActionError.value = ''
  try {
    requireSuccess(await catalogApi.removeScope(scope.id))
    if (!alive) return
    removeScopeTarget.value = ''
    if (filters.scopeId === scope.id) filters.scopeId = ''
    if (appliedQuery.value.scopeIds?.includes(scope.id)) appliedQuery.value = { ...appliedQuery.value, scopeIds: undefined }
    closeEditor()
    await Promise.allSettled([loadScopes(), loadMetadata(), searchPage(1)])
  } catch (cause) { if (alive) scopeActionError.value = failure(cause) }
  finally { scopeBusy.delete(scope.id) }
}

function applySearch() {
  filterError.value = ''
  const min = filters.minSize === '' ? undefined : Math.ceil(Number(filters.minSize) * 1024 ** 2)
  const max = filters.maxSize === '' ? undefined : Math.floor(Number(filters.maxSize) * 1024 ** 2)
  if ((min !== undefined && (!Number.isSafeInteger(min) || min < 0)) || (max !== undefined && (!Number.isSafeInteger(max) || max < 0)) || (min !== undefined && max !== undefined && min > max)) { filterError.value = '请填写有效的大小范围，最小值不能大于最大值。'; return }
  const selectedTags = splitTags(filters.tags)
  if (selectedTags.length > 30 || selectedTags.some(tag => tag.length > 64)) { filterError.value = '最多筛选 30 个标签，每个标签不超过 64 个字符。'; return }
  const dateFrom = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`).getTime() : undefined
  const dateTo = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59.999`).getTime() : undefined
  if ((dateFrom !== undefined && !Number.isFinite(dateFrom)) || (dateTo !== undefined && !Number.isFinite(dateTo)) || (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo)) { filterError.value = '修改日期起不能晚于修改日期止。'; return }
  const [sortBy, sortOrder] = filters.sort.split(':') as [CatalogQuery['sortBy'], CatalogQuery['sortOrder']]
  appliedQuery.value = { keyword: filters.keyword.trim() || undefined, path: filters.path.trim() || undefined, accountIds: filters.accountId ? [filters.accountId] : undefined, fileTypes: filters.fileType ? [filters.fileType] : undefined, tags: selectedTags, minSize: min, maxSize: max, dateFrom, dateTo, scopeIds: filters.scopeId ? [filters.scopeId] : undefined, sortBy, sortOrder }
  closeEditor()
  void searchPage(1)
}

function resetFilters() {
  Object.assign(filters, { keyword: '', path: '', accountId: '', fileType: '', tags: '', minSize: '', maxSize: '', dateFrom: '', dateTo: '', scopeId: '', sort: 'updatedAt:desc' })
  activeCollection.value = ''
  favoriteOnly.value = false
  applySearch()
}

function selectCollection(id: string, favorite: boolean) {
  activeCollection.value = id
  favoriteOnly.value = favorite
  closeEditor()
  void searchPage(1)
}

async function searchPage(target: number) {
  const version = ++searchVersion
  searching.value = true
  searchError.value = ''
  page.value = target
  try {
    const result = await catalogApi.search({ ...appliedQuery.value, collectionId: activeCollection.value || undefined, favorite: favoriteOnly.value || undefined, page: target, pageSize: pageSize.value })
    if (!alive || version !== searchVersion) return
    requireSuccess(result)
    total.value = result.total
    const lastPage = Math.max(1, Math.ceil(result.total / pageSize.value))
    if (target > lastPage) { await searchPage(lastPage); return }
    entries.value = result.entries
    page.value = result.page
  } catch (cause) {
    if (alive && version === searchVersion) { searchError.value = failure(cause); entries.value = []; total.value = 0 }
  } finally { if (alive && version === searchVersion) searching.value = false }
}

async function saveCollection() {
  if (collectionSaving.value || !collectionName.value.trim()) return
  collectionSaving.value = true
  collectionActionError.value = ''
  try {
    requireSuccess(await catalogApi.saveCollection({ id: editingCollectionId.value || undefined, name: collectionName.value.trim() }))
    if (!alive) return
    collectionName.value = ''
    editingCollectionId.value = ''
    await loadMetadata()
  } catch (cause) { if (alive) collectionActionError.value = failure(cause) }
  finally { if (alive) collectionSaving.value = false }
}

async function removeCollection(id: string) {
  if (collectionBusy.has(id)) return
  collectionBusy.add(id)
  collectionActionError.value = ''
  try {
    requireSuccess(await catalogApi.removeCollection(id))
    if (!alive) return
    removeCollectionTarget.value = ''
    if (editingCollectionId.value === id) { editingCollectionId.value = ''; collectionName.value = '' }
    if (activeCollection.value === id) activeCollection.value = ''
    entryCollectionDraft.value = entryCollectionDraft.value.filter(value => value !== id)
    await Promise.allSettled([loadMetadata(), searchPage(1)])
  } catch (cause) { if (alive) collectionActionError.value = failure(cause) }
  finally { collectionBusy.delete(id) }
}

function closeEditor() { editorVersion++; selectedEntry.value = null; editorError.value = ''; editorNotice.value = ''; tagSaving.value = false; entryCollectionsSaving.value = false }
function openEditor(entry: CatalogEntry) {
  closeEditor()
  selectedEntry.value = entry
  tagsDraft.value = entry.tags.join('，')
  entryCollectionDraft.value = [...entry.collectionIds]
  tagSaving.value = entryBusy.has(`tags:${entryKey(entry)}`)
  entryCollectionsSaving.value = entryBusy.has(`collections:${entryKey(entry)}`)
}

async function saveTags() {
  const entry = selectedEntry.value
  if (!entry || tagSaving.value) return
  const key = `tags:${entryKey(entry)}`
  const version = editorVersion
  const newTags = splitTags(tagsDraft.value)
  if (newTags.length > 30 || newTags.some(tag => tag.length > 64)) { editorError.value = '最多保存 30 个标签，每个标签不超过 64 个字符。'; editorNotice.value = ''; return }
  tagSaving.value = true
  entryBusy.add(key)
  editorError.value = ''; editorNotice.value = ''
  try {
    requireSuccess(await catalogApi.setTags({ accountId: entry.accountId, fileId: entry.fileId, tags: newTags }))
    if (!alive) return
    if (version === editorVersion && selectedEntry.value) { selectedEntry.value = { ...selectedEntry.value, tags: newTags }; editorNotice.value = '标签已保存到本地。' }
    await Promise.allSettled([loadMetadata(), searchPage(page.value)])
  } catch (cause) { if (alive && version === editorVersion) editorError.value = `标签未保存：${failure(cause)}` }
  finally { entryBusy.delete(key); if (alive && selectedEntry.value && entryKey(selectedEntry.value) === entryKey(entry)) tagSaving.value = false }
}

async function saveEntryCollections() {
  const entry = selectedEntry.value
  if (!entry || entryCollectionsSaving.value) return
  const key = `collections:${entryKey(entry)}`
  const version = editorVersion
  const ids = [...entryCollectionDraft.value]
  entryCollectionsSaving.value = true
  entryBusy.add(key)
  editorError.value = ''; editorNotice.value = ''
  try {
    requireSuccess(await catalogApi.setEntryCollections({ accountId: entry.accountId, fileId: entry.fileId, collectionIds: ids }))
    if (!alive) return
    if (version === editorVersion && selectedEntry.value) { selectedEntry.value = { ...selectedEntry.value, collectionIds: ids }; editorNotice.value = '集合归属已保存，远端文件位置未改变。' }
    await Promise.allSettled([loadMetadata(), searchPage(page.value)])
  } catch (cause) { if (alive && version === editorVersion) editorError.value = `集合归属未保存：${failure(cause)}` }
  finally { entryBusy.delete(key); if (alive && selectedEntry.value && entryKey(selectedEntry.value) === entryKey(entry)) entryCollectionsSaving.value = false }
}

async function toggleFavorite(entry: CatalogEntry) {
  const key = `favorite:${entryKey(entry)}`
  if (entryBusy.has(key)) return
  entryBusy.add(key)
  entryActionError.value = ''
  try {
    requireSuccess(await catalogApi.setFavorite({ accountId: entry.accountId, fileId: entry.fileId, favorite: !entry.favorite }))
    if (!alive) return
    if (selectedEntry.value && entryKey(selectedEntry.value) === entryKey(entry)) selectedEntry.value = { ...selectedEntry.value, favorite: !entry.favorite }
    await searchPage(page.value)
  } catch (cause) { if (alive) entryActionError.value = `${entry.name}：收藏未保存，${failure(cause)}` }
  finally { entryBusy.delete(key) }
}

async function locateEntry(entry: CatalogEntry) {
  const key = `locate:${entryKey(entry)}`
  if (entryBusy.has(key)) return
  const version = ++locationVersion
  entryBusy.add(key)
  entryActionError.value = ''
  try {
    const result = await catalogApi.resolveEntry({ accountId: entry.accountId, fileId: entry.fileId })
    requireSuccess(result)
    if (!alive || version !== locationVersion) return
    await router.push({ path: '/files', query: { accountId: result.entry.accountId, parentId: result.entry.parentId, fileId: result.entry.fileId, path: result.entry.path, from: 'catalog' } })
  } catch (cause) { if (alive && version === locationVersion) entryActionError.value = `无法确认 ${entry.name} 的远端位置：${failure(cause)}。请恢复连接或重新扫描后再操作。` }
  finally { entryBusy.delete(key) }
}

function updateNetwork() { networkOnline.value = navigator.onLine }
async function pollScopes() {
  const before = JSON.stringify(scopes.value.map(scope => [scope.id, scope.status, scope.entryCount, scope.updatedAt]))
  await loadScopes()
  if (!alive) return
  const after = JSON.stringify(scopes.value.map(scope => [scope.id, scope.status, scope.entryCount, scope.updatedAt]))
  if (before !== after && !searching.value) await searchPage(page.value)
  if (alive) pollTimer = setTimeout(pollScopes, 5000)
}

onMounted(async () => {
  window.addEventListener('online', updateNetwork)
  window.addEventListener('offline', updateNetwork)
  await Promise.allSettled([loadAccounts(), loadScopes(), loadMetadata(), searchPage(1)])
  if (alive) pollTimer = setTimeout(pollScopes, 5000)
})
onBeforeUnmount(() => {
  alive = false; searchVersion++; scopesVersion++; metadataVersion++; accountsVersion++; editorVersion++; locationVersion++
  clearTimeout(pollTimer)
  window.removeEventListener('online', updateNetwork)
  window.removeEventListener('offline', updateNetwork)
})
</script>

<style scoped>
.catalog-page { height: 100%; min-height: 0; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding-bottom: 12px; color: var(--pl-text); font-size: 13px; }
.panel { flex: 0 0 auto; min-width: 0; border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); background: var(--pl-surface); box-shadow: var(--pl-shadow-card); }
.page-header { display: flex; align-items: center; gap: 12px; padding: 18px 20px; }
.header-icon { display: grid; place-items: center; width: 42px; height: 42px; flex-shrink: 0; border-radius: 12px; background: var(--pl-primary-soft); color: var(--pl-primary); }
.header-copy { flex: 1; min-width: 0; }.header-copy h1 { margin: 0 0 3px; font-size: 18px; }.header-copy p { margin: 0; font-size: 12px; color: var(--pl-text-secondary); }
button, input, select { font: inherit; }button { cursor: pointer; }button:disabled { opacity: .5; cursor: default; }input, select { min-width: 0; min-height: 34px; padding: 6px 8px; color: var(--pl-text); background: var(--pl-surface); border: 1px solid var(--pl-border-strong); border-radius: 7px; }input::placeholder { color: var(--pl-text-muted); }input:focus, select:focus { outline: 2px solid var(--pl-primary-soft); border-color: var(--pl-primary); }
.button, .text-button { display: inline-flex; justify-content: center; align-items: center; gap: 5px; padding: 7px 10px; color: var(--pl-text); border: 1px solid var(--pl-border); background: var(--pl-surface); border-radius: 8px; white-space: nowrap; font-size: 12px; }.button:hover:enabled { background: var(--pl-hover); }.primary { background: var(--pl-primary); border-color: var(--pl-primary); color: white; }.primary:hover:enabled { background: var(--pl-primary-hover); }.text-button { padding: 4px 3px; color: var(--pl-primary); border: 0; background: transparent; }.text-button:hover:enabled { text-decoration: underline; }.danger { color: var(--pl-danger); }
.local-note { display: flex; align-items: flex-start; gap: 8px; margin: 0 4px; color: var(--pl-text-secondary); font-size: 12px; line-height: 1.65; }.local-note > svg { flex-shrink: 0; margin-top: 3px; color: var(--pl-primary); }
.scope-panel { padding: 14px 16px; }.section-heading { display: flex; justify-content: space-between; gap: 12px; align-items: center; }.section-toggle { display: flex; align-items: center; gap: 8px; padding: 0; color: var(--pl-text); border: 0; background: transparent; text-align: left; flex-wrap: wrap; }.section-toggle > span { color: var(--pl-text-secondary); font-size: 12px; }.section-toggle svg { transition: transform .15s; }.section-toggle svg.collapsed { transform: rotate(-90deg); }.scope-panel > .scope-picker { margin-top: 14px; }.scope-list { display: grid; margin-top: 10px; }.scope-row { display: grid; grid-template-columns: minmax(130px, .7fr) minmax(220px, 1.3fr) auto; gap: 10px 16px; padding: 14px 0; border-top: 1px solid var(--pl-border); }.scope-summary, .scope-progress { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; gap: 5px; font-size: 12px; }.scope-summary strong { overflow-wrap: anywhere; font-size: 13px; }.scope-summary span, .scope-progress > span:not(.badge), .scope-progress small { color: var(--pl-text-secondary); }.scope-progress small { line-height: 1.6; }.scope-actions { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: flex-end; gap: 6px; }.scope-failures { grid-column: 1 / -1; color: var(--pl-warning); font-size: 12px; overflow-wrap: anywhere; }.scope-failures summary { cursor: pointer; }.scope-failures ul { margin: 7px 0 0; max-height: 160px; overflow-y: auto; padding-left: 22px; }.confirm-row { display: flex; grid-column: 1 / -1; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px; border-radius: 8px; background: var(--pl-warning-soft); font-size: 12px; }.confirm-row > span { flex: 1 1 250px; }
.search-panel { display: grid; gap: 14px; padding: 16px; }.search-main { display: flex; gap: 8px; }.search-input { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; padding: 0 10px; border: 1px solid var(--pl-border-strong); border-radius: 8px; color: var(--pl-text-muted); }.search-input input { width: 100%; border: 0; background: transparent; padding-left: 0; min-height: 38px; }.filter-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }.field { display: flex; flex-direction: column; gap: 5px; color: var(--pl-text-secondary); font-size: 12px; min-width: 0; }.field > input, .field > select { width: 100%; box-sizing: border-box; }.reset-filter { justify-self: start; align-self: end; }
.results-panel { padding-top: 12px; overflow: hidden; }.collection-bar { display: flex; flex-wrap: wrap; gap: 7px; padding: 0 16px 12px; }.collection-chip { display: inline-flex; align-items: center; gap: 5px; color: var(--pl-text-secondary); background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); border-radius: 20px; padding: 6px 11px; font-size: 12px; overflow-wrap: anywhere; }.collection-chip.active { color: var(--pl-primary); border-color: var(--pl-primary); background: var(--pl-primary-soft); }.collection-chip small { color: var(--pl-text-muted); }.collection-manager { border-top: 1px solid var(--pl-border); padding: 14px 16px; background: var(--pl-surface-subtle); }.collection-create { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }.collection-create .field { flex: 1 1 200px; }.collection-manage-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 0; }.collection-manage-row > span:first-child { flex: 1 1 150px; overflow-wrap: anywhere; }.muted { color: var(--pl-text-secondary); font-size: 12px; }.results-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 13px 16px; border-top: 1px solid var(--pl-border); border-bottom: 1px solid var(--pl-border); }.results-heading > span { flex: 1; color: var(--pl-text-muted); font-size: 12px; }
.empty-state { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 9px; padding: 32px 20px; text-align: center; color: var(--pl-text-secondary); font-size: 12px; }.empty-state > svg { color: var(--pl-text-muted); }.empty-state strong { font-size: 13px; }.results-panel > .empty-state { min-height: 160px; }.error-message { color: var(--pl-danger); font-size: 12px; overflow-wrap: anywhere; }.scope-panel > .error-message, .search-panel > .error-message { margin: 10px 0 0; }.results-panel > .error-message { margin: 10px 16px; }.success-message { color: var(--pl-success); font-size: 12px; }.warning-text { color: var(--pl-warning) !important; }.badge { display: inline-flex; align-self: flex-start; width: max-content; font-size: 11px; padding: 2px 6px; border-radius: 5px; }.neutral { color: var(--pl-text-secondary); background: var(--pl-hover); }.success { color: var(--pl-success); background: var(--pl-success-soft); }.warning { color: var(--pl-warning); background: var(--pl-warning-soft); }.primary-badge { color: var(--pl-primary); background: var(--pl-primary-soft); }
.entry-editor { margin: 12px 16px; padding: 14px; background: var(--pl-surface-subtle); border: 1px solid var(--pl-border-strong); border-radius: 9px; }.editor-title { display: flex; gap: 12px; align-items: flex-start; }.editor-title > strong { flex: 1; overflow-wrap: anywhere; }.editor-path { margin: 2px 0 14px; color: var(--pl-text-secondary); overflow-wrap: anywhere; font-size: 12px; }.editor-forms { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }.editor-forms form { display: grid; align-content: start; gap: 9px; min-width: 0; }.editor-forms .button { justify-self: start; }.editor-forms fieldset { display: flex; flex-wrap: wrap; gap: 9px; min-width: 0; padding: 0; border: 0; }.editor-forms legend { margin-bottom: 8px; padding: 0; color: var(--pl-text-secondary); font-size: 12px; }.checkbox-label { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; overflow-wrap: anywhere; }.checkbox-label input { min-height: auto; accent-color: var(--pl-primary); }
.table-scroll { overflow-x: auto; }.result-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 12px; }.result-table th { background: var(--pl-surface-subtle); color: var(--pl-text-secondary); font-size: 11px; font-weight: 600; text-align: left; padding: 9px 8px; }.result-table td { padding: 13px 8px; vertical-align: top; border-top: 1px solid var(--pl-border); }.result-table tbody tr:hover { background: var(--pl-surface-subtle); }.result-table tr.selected { background: var(--pl-primary-soft); }.result-table th:nth-child(2) { width: auto; }.result-table th:nth-child(3) { width: 116px; }.result-table th:nth-child(4) { width: 142px; }.result-table th:nth-child(5) { width: 104px; }.result-table .favorite-cell { width: 26px; padding-left: 13px; padding-right: 0; }.favorite-button { padding: 2px; border: 0; color: var(--pl-text-muted); background: transparent; }.favorite-button.marked { color: var(--pl-warning); }.file-name { display: flex; align-items: flex-start; gap: 6px; min-width: 0; padding: 0; color: var(--pl-text); background: transparent; border: 0; text-align: left; }.file-name > svg { flex-shrink: 0; margin-top: 1px; color: var(--pl-primary); }.file-name strong { overflow-wrap: anywhere; font-weight: 600; line-height: 1.55; }.file-name:hover { color: var(--pl-primary); }.file-path { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--pl-text-secondary); margin-top: 5px; }.file-source { color: var(--pl-text-secondary); font-size: 11px; overflow-wrap: anywhere; margin-top: 3px; }.tag-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }.tag { background: var(--pl-hover); color: var(--pl-text-secondary); border-radius: 4px; padding: 1px 5px; font-size: 11px; overflow-wrap: anywhere; }.date-cell small, .index-cell small { display: block; color: var(--pl-text-secondary); font-size: 11px; margin-top: 5px; }.locate-cell .text-button { white-space: normal; text-align: left; }.pagination { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 9px; padding: 12px 16px; border-top: 1px solid var(--pl-border); color: var(--pl-text-secondary); font-size: 12px; }.pagination label { display: flex; align-items: center; gap: 6px; margin-right: auto; }.pagination select { min-height: 29px; padding: 3px 5px; }.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
@media (max-width: 1150px) { .filter-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }.scope-row { grid-template-columns: minmax(130px, .7fr) minmax(200px, 1.3fr); }.scope-actions { grid-column: 1 / -1; justify-content: flex-start; }.result-table th:nth-child(3) { width: 99px; }.result-table th:nth-child(4) { width: 121px; }.result-table th:nth-child(5) { width: 88px; } }
@media (max-width: 760px) { .page-header { padding: 14px; flex-wrap: wrap; }.header-copy { flex-basis: calc(100% - 60px); }.header-copy h1 { font-size: 16px; }.section-toggle > span { flex-basis: 100%; margin-left: 25px; }.filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.search-main { flex-wrap: wrap; }.search-input { flex-basis: 100%; }.scope-row { grid-template-columns: 1fr; }.scope-actions { grid-column: 1; }.editor-forms { grid-template-columns: 1fr; }.result-table { min-width: 600px; } }
</style>
