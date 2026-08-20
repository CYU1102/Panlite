<template>
  <div class="global-search-page">
    <header class="page-header">
      <div class="header-icon"><Search :size="20" /></div>
      <div class="header-copy">
        <h2>全局搜索</h2>
        <p>同时搜索多个账号，并用类型、大小和更新时间缩小结果范围</p>
      </div>
      <el-button :disabled="!keyword.trim()" @click="saveCurrentSearch">
        <BookmarkPlus :size="14" />保存条件
      </el-button>
    </header>

    <section class="search-panel">
      <div class="keyword-row">
        <el-input
          v-model="keyword"
          clearable
          size="large"
          placeholder="输入文件或文件夹名称"
          @keyup.enter="runSearch()"
        >
          <template #prefix><Search :size="16" /></template>
        </el-input>
        <el-button type="primary" size="large" :loading="searching" @click="runSearch()">
          搜索全部账号
        </el-button>
      </div>

      <div class="filter-grid">
        <label class="filter-field">
          <span>平台</span>
          <el-select v-model="selectedPlatforms" multiple collapse-tags clearable placeholder="全部平台">
            <el-option v-for="platform in platformOptions" :key="platform" :label="PLATFORM_LABELS[platform]" :value="platform" />
          </el-select>
        </label>
        <label class="filter-field account-field">
          <span>账号</span>
          <el-select v-model="selectedAccountIds" multiple collapse-tags collapse-tags-tooltip clearable placeholder="全部可用账号">
            <el-option
              v-for="account in availableAccounts"
              :key="account.id"
              :label="`${PLATFORM_LABELS[account.platform]} · ${account.nickname}`"
              :value="account.id"
              :disabled="account.status !== 'active'"
            />
          </el-select>
        </label>
        <label class="filter-field type-field">
          <span>文件类型</span>
          <el-select v-model="selectedFileTypes" multiple collapse-tags clearable placeholder="全部类型">
            <el-option v-for="option in fileTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </label>
        <label class="filter-field size-field">
          <span>大小范围（MB）</span>
          <div class="size-inputs">
            <el-input-number v-model="minSizeMb" :min="0" :precision="0" controls-position="right" placeholder="最小" />
            <span>—</span>
            <el-input-number v-model="maxSizeMb" :min="0" :precision="0" controls-position="right" placeholder="最大" />
          </div>
        </label>
        <label class="filter-field date-field">
          <span>更新时间</span>
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            unlink-panels
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            range-separator="至"
          />
        </label>
      </div>
    </section>

    <div class="content-grid">
      <aside class="collections-panel">
        <div class="collection-section">
          <div class="section-title">
            <span><Bookmark :size="14" />保存的搜索</span>
          </div>
          <div v-if="savedSearches.length === 0" class="collection-empty">还没有保存条件</div>
          <button v-for="saved in savedSearches" :key="saved.id" class="collection-item" @click="applyAndSearch(saved.query)">
            <span class="collection-copy">
              <strong>{{ saved.name }}</strong>
              <small>{{ describeQuery(saved.query) }}</small>
            </span>
            <span class="remove-button" title="删除" @click.stop="removeSavedSearch(saved.id)"><Trash2 :size="13" /></span>
          </button>
        </div>

        <div class="collection-section history-section">
          <div class="section-title">
            <span><History :size="14" />搜索历史</span>
            <button v-if="history.length" @click="clearHistory">清空</button>
          </div>
          <div v-if="history.length === 0" class="collection-empty">暂无搜索历史</div>
          <button v-for="entry in history" :key="entry.id" class="collection-item" @click="applyAndSearch(entry.query)">
            <span class="collection-copy">
              <strong>{{ entry.query.keyword }}</strong>
              <small>{{ entry.resultCount }} 个结果 · {{ formatTime(entry.createdAt) }}</small>
            </span>
          </button>
        </div>
      </aside>

      <section class="results-panel">
        <div class="results-header">
          <div>
            <strong>{{ hasSearched ? `${results.length} 个结果` : '搜索结果' }}</strong>
            <span v-if="hasSearched">已搜索 {{ searchedAccountCount }} 个账号</span>
          </div>
          <el-tag v-if="failures.length" type="warning" effect="plain">{{ failures.length }} 个账号搜索失败</el-tag>
        </div>

        <el-alert
          v-if="failures.length"
          :title="failures.map((failure) => `${failure.accountNickname}：${failure.error}`).join('；')"
          type="warning"
          :closable="false"
          show-icon
          class="failure-alert"
        />

        <el-table v-if="results.length" :data="results" height="100%" stripe>
          <el-table-column label="名称" min-width="270">
            <template #default="{ row }">
              <div class="file-cell">
                <Folder v-if="row.isDir" :size="16" class="folder-icon" />
                <File v-else :size="16" class="file-icon" />
                <span :title="row.name">{{ row.name }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="账号" min-width="150">
            <template #default="{ row }">
              <span>{{ row.accountNickname }}</span>
              <el-tag size="small" effect="plain" class="platform-tag">{{ PLATFORM_LABELS[row.platform] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="path" label="路径" min-width="180" show-overflow-tooltip />
          <el-table-column label="大小" width="110" align="right">
            <template #default="{ row }">{{ row.isDir ? '文件夹' : formatSize(row.size) }}</template>
          </el-table-column>
          <el-table-column label="更新时间" width="170">
            <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
          </el-table-column>
        </el-table>

        <div v-else class="empty-results" v-loading="searching">
          <SearchX :size="42" :stroke-width="1.2" />
          <strong>{{ hasSearched ? '没有符合条件的文件' : '搜索所有网盘账号' }}</strong>
          <span>{{ hasSearched ? '尝试放宽筛选条件或更换关键词' : '输入关键词后，可跨账号同时查找文件' }}</span>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs'
import { Bookmark, BookmarkPlus, File, Folder, History, Search, SearchX, Trash2 } from 'lucide-vue-next'
import type { FileItem, Platform } from '@shared/types'
import { PLATFORM_LABELS } from '@shared/constants'
import type {
  GlobalSearchFailure,
  GlobalSearchFilters,
  GlobalSearchHistoryEntry,
  GlobalSearchQuery,
  GlobalSearchResult,
  SavedGlobalSearch,
} from '../../main/global-search'
import { electronApi } from '../api/ipc'
import { useAccountStore } from '../stores/account'

const HISTORY_KEY = 'panlite:global-search-history:v1'
const SAVED_KEY = 'panlite:saved-global-searches:v1'
const HISTORY_LIMIT = 30
const MB = 1024 * 1024

const platformOptions: Platform[] = ['quark', 'baidu', 'uc', 'xunlei']
const fileTypeOptions = [
  { label: '文件夹', value: 'folder' },
  { label: '视频', value: 'video' },
  { label: '音频', value: 'audio' },
  { label: '图片', value: 'image' },
  { label: '文档', value: 'document' },
  { label: '压缩包', value: 'archive' },
]

const accountStore = useAccountStore()
const keyword = ref('')
const selectedPlatforms = ref<Platform[]>([])
const selectedAccountIds = ref<string[]>([])
const selectedFileTypes = ref<string[]>([])
const minSizeMb = ref<number | undefined>()
const maxSizeMb = ref<number | undefined>()
const dateRange = ref<[Date, Date] | null>(null)
const searching = ref(false)
const hasSearched = ref(false)
const results = ref<GlobalSearchResult[]>([])
const failures = ref<GlobalSearchFailure[]>([])
const searchedAccountCount = ref(0)
const history = ref<GlobalSearchHistoryEntry[]>(readStoredArray(HISTORY_KEY))
const savedSearches = ref<SavedGlobalSearch[]>(readStoredArray(SAVED_KEY))

const availableAccounts = computed(() => accountStore.accounts.filter((account) => (
  selectedPlatforms.value.length === 0 || selectedPlatforms.value.includes(account.platform)
)))

function readStoredArray<T>(key: string): T[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? value as T[] : []
  } catch {
    return []
  }
}

function persistCollections(): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value))
  localStorage.setItem(SAVED_KEY, JSON.stringify(savedSearches.value))
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function currentQuery(): GlobalSearchQuery {
  const startDate = dateRange.value?.[0]
  const endDate = dateRange.value?.[1]
  const filters: GlobalSearchFilters = {
    platforms: selectedPlatforms.value.length ? [...selectedPlatforms.value] : undefined,
    accountIds: selectedAccountIds.value.length ? [...selectedAccountIds.value] : undefined,
    fileTypes: selectedFileTypes.value.length ? [...selectedFileTypes.value] : undefined,
    minSize: minSizeMb.value === undefined ? undefined : minSizeMb.value * MB,
    maxSize: maxSizeMb.value === undefined ? undefined : maxSizeMb.value * MB,
    dateFrom: startDate?.getTime(),
    dateTo: endDate ? new Date(endDate).setHours(23, 59, 59, 999) : undefined,
  }
  return { keyword: keyword.value.trim(), filters }
}

function applyQuery(query: GlobalSearchQuery): void {
  keyword.value = query.keyword
  selectedPlatforms.value = [...(query.filters.platforms || [])]
  selectedAccountIds.value = [...(query.filters.accountIds || [])]
  selectedFileTypes.value = [...(query.filters.fileTypes || [])]
  minSizeMb.value = query.filters.minSize === undefined ? undefined : query.filters.minSize / MB
  maxSizeMb.value = query.filters.maxSize === undefined ? undefined : query.filters.maxSize / MB
  dateRange.value = query.filters.dateFrom !== undefined && query.filters.dateTo !== undefined
    ? [new Date(query.filters.dateFrom), new Date(query.filters.dateTo)]
    : null
}

async function applyAndSearch(query: GlobalSearchQuery): Promise<void> {
  applyQuery(query)
  await runSearch(query)
}

async function runSearch(queryOverride?: GlobalSearchQuery): Promise<void> {
  const query = queryOverride || currentQuery()
  if (!query.keyword) {
    ElMessage.warning('请输入搜索关键词')
    return
  }
  if (query.filters.minSize !== undefined && query.filters.maxSize !== undefined
    && query.filters.minSize > query.filters.maxSize) {
    ElMessage.warning('最小文件大小不能大于最大文件大小')
    return
  }

  const accountIdFilter = query.filters.accountIds?.length ? new Set(query.filters.accountIds) : null
  const platformFilter = query.filters.platforms?.length ? new Set(query.filters.platforms) : null
  const targetAccounts = accountStore.accounts.filter((account) => (
    account.status === 'active'
    && (!accountIdFilter || accountIdFilter.has(account.id))
    && (!platformFilter || platformFilter.has(account.platform))
  ))
  if (targetAccounts.length === 0) {
    ElMessage.warning('没有可搜索的有效账号')
    return
  }

  searching.value = true
  failures.value = []
  try {
    const settled = await Promise.all(targetAccounts.map(async (account) => {
      try {
        const response = await electronApi.searchFiles(account.id, query.keyword, {
          minSize: query.filters.minSize,
          maxSize: query.filters.maxSize,
          fileTypes: query.filters.fileTypes,
          dateFrom: query.filters.dateFrom,
          dateTo: query.filters.dateTo,
        })
        if (!response.success) throw new Error(response.error || '搜索失败')
        return {
          files: (response.files as FileItem[]).map((file) => ({ ...file, accountNickname: account.nickname })),
          failure: null,
        }
      } catch (error) {
        return {
          files: [] as GlobalSearchResult[],
          failure: {
            accountId: account.id,
            accountNickname: account.nickname,
            platform: account.platform,
            error: error instanceof Error ? error.message : String(error),
          } satisfies GlobalSearchFailure,
        }
      }
    }))

    results.value = settled.flatMap((item) => item.files)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    failures.value = settled.flatMap((item) => item.failure ? [item.failure] : [])
    searchedAccountCount.value = targetAccounts.length
    hasSearched.value = true
    const entry: GlobalSearchHistoryEntry = {
      id: createId('history'),
      query,
      resultCount: results.value.length,
      failureCount: failures.value.length,
      createdAt: Date.now(),
    }
    const queryKey = JSON.stringify(query)
    history.value = [entry, ...history.value.filter((item) => JSON.stringify(item.query) !== queryKey)].slice(0, HISTORY_LIMIT)
    persistCollections()
  } finally {
    searching.value = false
  }
}

async function saveCurrentSearch(): Promise<void> {
  const query = currentQuery()
  if (!query.keyword) return
  try {
    const { value } = await ElMessageBox.prompt('为当前搜索条件命名', '保存搜索', {
      inputPlaceholder: '例如：最近一周的大型视频',
      inputValue: query.keyword,
      inputValidator: (input) => Boolean(input.trim()) || '名称不能为空',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    })
    const now = Date.now()
    savedSearches.value = [{
      id: createId('saved'),
      name: value.trim(),
      query,
      createdAt: now,
      updatedAt: now,
    }, ...savedSearches.value]
    persistCollections()
    ElMessage.success('搜索条件已保存')
  } catch {}
}

function removeSavedSearch(id: string): void {
  savedSearches.value = savedSearches.value.filter((item) => item.id !== id)
  persistCollections()
}

function clearHistory(): void {
  history.value = []
  persistCollections()
}

function describeQuery(query: GlobalSearchQuery): string {
  const parts = [query.keyword]
  if (query.filters.platforms?.length) parts.push(query.filters.platforms.map((item) => PLATFORM_LABELS[item]).join('/'))
  if (query.filters.accountIds?.length) parts.push(`${query.filters.accountIds.length} 个账号`)
  if (query.filters.fileTypes?.length) parts.push(`${query.filters.fileTypes.length} 类文件`)
  return parts.filter(Boolean).join(' · ')
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatDate(timestamp: number): string {
  return timestamp ? new Date(timestamp).toLocaleString('zh-CN') : '-'
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('zh-CN')
}

onMounted(async () => {
  if (accountStore.accounts.length === 0) await accountStore.fetchAccounts()
})
</script>

<style scoped>
.global-search-page { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--pl-space-4); }
.page-header { display: flex; align-items: center; gap: var(--pl-space-3); padding: var(--pl-space-5) var(--pl-space-6); background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }
.header-icon { width: 40px; height: 40px; display: grid; flex: 0 0 auto; place-items: center; color: var(--pl-primary); background: var(--pl-primary-soft); border-radius: var(--pl-radius-control); }
.header-copy { min-width: 0; flex: 1; }
.header-copy h2 { margin: 0 0 2px; color: var(--pl-text); font-size: 16px; }
.header-copy p { margin: 0; color: var(--pl-text-secondary); font-size: 12px; }
.page-header :deep(.el-button) { gap: 6px; }
.search-panel { display: grid; gap: var(--pl-space-4); padding: var(--pl-space-5); background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }
.keyword-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--pl-space-3); }
.filter-grid { display: grid; grid-template-columns: .8fr 1.2fr 1fr 1.2fr 1.45fr; gap: var(--pl-space-3); align-items: end; }
.filter-field { min-width: 0; display: grid; gap: 6px; color: var(--pl-text-secondary); font-size: 11px; font-weight: 600; }
.filter-field :deep(.el-select), .filter-field :deep(.el-date-editor) { width: 100%; }
.size-inputs { min-width: 0; display: flex; align-items: center; gap: 5px; color: var(--pl-text-muted); }
.size-inputs :deep(.el-input-number) { min-width: 0; width: 50%; }
.content-grid { min-height: 0; flex: 1; display: grid; grid-template-columns: 245px minmax(0, 1fr); gap: var(--pl-space-4); }
.collections-panel, .results-panel { min-height: 0; background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }
.collections-panel { overflow-y: auto; padding: var(--pl-space-3); }
.collection-section { display: grid; gap: 6px; }
.history-section { margin-top: var(--pl-space-4); padding-top: var(--pl-space-4); border-top: 1px solid var(--pl-border); }
.section-title { min-height: 28px; display: flex; align-items: center; justify-content: space-between; padding: 0 5px; color: var(--pl-text); font-size: 12px; font-weight: 700; }
.section-title span { display: flex; align-items: center; gap: 6px; }
.section-title button { color: var(--pl-text-muted); background: transparent; border: 0; cursor: pointer; font-size: 11px; }
.collection-item { width: 100%; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 9px 10px; color: var(--pl-text); background: transparent; border: 0; border-radius: var(--pl-radius-control); text-align: left; cursor: pointer; }
.collection-item:hover { background: var(--pl-primary-soft); }
.collection-copy { min-width: 0; flex: 1; display: grid; gap: 3px; }
.collection-copy strong, .collection-copy small { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.collection-copy strong { font-size: 12px; font-weight: 600; }
.collection-copy small { color: var(--pl-text-muted); font-size: 10px; }
.remove-button { width: 24px; height: 24px; display: grid; flex: 0 0 auto; place-items: center; color: var(--pl-text-muted); border-radius: 7px; }
.remove-button:hover { color: var(--pl-danger); background: var(--pl-danger-soft); }
.collection-empty { padding: 14px 8px; color: var(--pl-text-muted); font-size: 11px; text-align: center; }
.results-panel { overflow: hidden; display: flex; flex-direction: column; }
.results-header { min-height: 52px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 var(--pl-space-5); border-bottom: 1px solid var(--pl-border); }
.results-header > div { display: flex; align-items: baseline; gap: 9px; }
.results-header strong { color: var(--pl-text); font-size: 13px; }
.results-header span { color: var(--pl-text-muted); font-size: 11px; }
.failure-alert { margin: 10px 12px 0; width: auto; }
.results-panel :deep(.el-table) { flex: 1; }
.file-cell { min-width: 0; display: flex; align-items: center; gap: 8px; }
.file-cell span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.folder-icon { flex: 0 0 auto; color: var(--pl-warning); }
.file-icon { flex: 0 0 auto; color: var(--pl-text-muted); }
.platform-tag { margin-left: 7px; }
.empty-results { min-height: 260px; flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--pl-text-muted); }
.empty-results strong { color: var(--pl-text-secondary); font-size: 13px; }
.empty-results span { font-size: 11px; }
@media (max-width: 1100px) {
  .filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .date-field { grid-column: span 2; }
}
@media (max-width: 760px) {
  .global-search-page { overflow-y: auto; }
  .page-header { align-items: flex-start; flex-wrap: wrap; }
  .keyword-row, .content-grid { grid-template-columns: 1fr; }
  .filter-grid { grid-template-columns: 1fr; }
  .date-field { grid-column: auto; }
  .collections-panel { max-height: 280px; }
  .results-panel { min-height: 460px; }
}
</style>
