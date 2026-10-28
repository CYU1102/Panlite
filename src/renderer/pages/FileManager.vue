<template>

 <div class="file-manager">

 <div class="page-heading">
   <div class="heading-title"><h1>文件管理</h1><span>浏览与整理云端文件</span></div>
   <div class="density-control" role="group" aria-label="文件列表显示密度">
     <button :class="{ active: tableDensity === 'comfortable' }" :aria-pressed="tableDensity === 'comfortable'" @click="tableDensity = 'comfortable'">舒适</button>
     <button :class="{ active: tableDensity === 'compact' }" :aria-pressed="tableDensity === 'compact'" @click="tableDensity = 'compact'">紧凑</button>
   </div>
 </div>

 <!-- Breadcrumb / navigation bar -->

 <div class="path-bar">

 <div class="path-bar-left">

 <button

 class="path-btn"

 aria-label="返回上一级"

 title="返回上一级"

 :disabled="appStore.pathStack.length <= 1 || appStore.isSearching"

 @click="onBack"

 >

 <ArrowLeft :size="16" :stroke-width="2" />

 </button>

 <button class="path-btn" aria-label="刷新文件列表" title="刷新文件列表" @click="onRefresh" :disabled="loading">

 <RefreshCw :size="16" :stroke-width="2" :class="{ spinning: loading }" />

 </button>

 <div class="path-sep"></div>

 <template v-if="appStore.isSearching">

 <span class="search-tag">

 <Search :size="14" />

 {{ appStore.searchKeyword }}

 <button class="search-clear" aria-label="清除文件搜索" title="清除文件搜索" @click="onClearSearch">

 <X :size="12" />

 </button>

 </span>

 <el-button size="small" @click="showSearchFilter = true" :type="Object.keys(searchFilters).length > 0 ? 'primary' : 'default'" style="margin-left: 8px;">

 <Filter :size="14" style="margin-right: 4px" />

 筛选

 </el-button>

 <el-button v-if="Object.keys(searchFilters).length > 0" size="small" @click="onClearSearchFilters">

 清除筛选

 </el-button>

 </template>

        <template v-else>

          <div class="breadcrumbs">

            <template v-for="(item, index) in appStore.pathStack" :key="item.id">

              <ChevronRight v-if="index > 0" class="crumb-sep" :size="12" />

              <button

                class="crumb"

                :class="{ active: index === appStore.pathStack.length - 1 }"
                :aria-current="index === appStore.pathStack.length - 1 ? 'location' : undefined"
                :title="item.name"

                @click="onBreadcrumbClick(item, index)"

              >

                {{ item.name }}

              </button>

            </template>

          </div>

        </template>

      </div>

      <div class="path-bar-right">

        <el-button
          size="small"
          type="primary"
          plain
          :disabled="!appStore.hasAccount || !capabilities.createFolder"
          :title="capabilityTitle('createFolder', '新建文件夹')"
          @click="showNewFolder = true"
        >
          <FolderPlus :size="14" style="margin-right: 4px" />
          新建文件夹
        </el-button>

        <el-button size="small" text @click="onExportCsv" :disabled="!appStore.hasAccount" :loading="exporting">
          <Download :size="14" style="margin-right: 4px" />
          导出 CSV
        </el-button>

      </div>

    </div>
    <!-- Cache status badge -->
    <div v-if="catalogNavigationMessage" class="cache-badge" role="status">
      <Database :size="14" />
      <span>{{ catalogNavigationMessage }}</span>
      <el-button size="small" text @click="router.push('/file-catalog')">返回文件目录</el-button>
    </div>
    <div v-if="isCached && appStore.hasAccount && !appStore.isSearching" class="cache-badge">
      <Database :size="14" />
      <span>离线缓存数据 · {{ formatCacheTime(cacheTime) }}</span>
      <span v-if="offlineReason" class="cache-reason" :title="offlineReason">在线加载失败：{{ offlineReason }}</span>
      <el-button size="small" text @click="onRefresh">
        <RefreshCw :size="12" />
        刷新
      </el-button>
    </div>





    <!-- Batch action bar -->

    <div v-if="appStore.hasAccount" class="selection-slot">
    <div v-if="selectedFiles.length === 0" class="selection-hint"><span>{{ appStore.isSearching ? '搜索结果' : '当前目录' }} · {{ fileList.length }} 项</span><span>点击名称打开文件或文件夹</span></div>
    <transition name="slide-fade">

      <div v-if="selectedFiles.length > 0" class="batch-bar">

        <div class="batch-info">

          <span class="batch-check"><CheckCircle2 :size="15" /></span>

          已选择 <strong>{{ selectedFiles.length }}</strong> 个项目
        </div>

        <div class="batch-actions">

          <el-button size="small" :disabled="!capabilities.rename" :title="capabilityTitle('rename', '批量重命名')" @click="showBatchRename = true">

            <PenSquare :size="14" style="margin-right: 4px" />
            批量重命名
          </el-button>

          <el-button size="small" :disabled="!capabilities.move" :title="capabilityTitle('move', '批量移动')" @click="showBatchMove = true">

            <FolderInput :size="14" style="margin-right: 4px" />
            批量移动
          </el-button>

          <el-button size="small" :disabled="!capabilities.share" :title="capabilityTitle('share', '批量分享')" @click="$router.push('/batch-share')">

            <Share2 :size="14" style="margin-right: 4px" />
            批量分享
          </el-button>

          <el-button size="small" :disabled="!capabilities.downloadFile || selectedCloudFiles.length === 0" :loading="aiImporting" title="把选中文件下载并导入 AI 工作台问答" @click="importSelectionToAi">

            <Sparkles :size="14" style="margin-right: 4px" />
            AI 问答{{ selectedCloudFiles.length ? `（${selectedCloudFiles.length}）` : '' }}
          </el-button>

          <el-button size="small" type="danger" plain :disabled="!capabilities.delete" :title="capabilityTitle('delete', '批量删除')" @click="onBatchDelete">

            <Trash2 :size="14" style="margin-right: 4px" />
            批量删除
          </el-button>

          <el-button size="small" :disabled="!canDownloadSelection" :title="downloadSelectionTitle" @click="showDownloadDialog = true">

            <Download :size="14" style="margin-right: 4px" />
            下载
          </el-button>

          <el-button v-if="capabilities.copy" size="small" @click="onBatchCopy">
            <Copy :size="14" style="margin-right: 4px" />
            复制
          </el-button>

          <el-button
            v-if="capabilities.createArchive"
            size="small"
            :disabled="!canCompressSelection"
            :title="compressSelectionTitle"
            @click="onBatchCompress"
          >
            <FolderArchive :size="14" style="margin-right: 4px" />
            压缩
          </el-button>

        </div>

      </div>

    </transition>
    </div>



    <!-- No account hint -->

    <div v-if="!appStore.hasAccount" class="empty-state">

      <div class="empty-icon">

        <HardDrive :size="48" :stroke-width="1" />

      </div>

      <h3>未添加账号</h3>
      <p>请先添加一个网盘账号以管理文件</p>
      <el-button type="primary" @click="$router.push('/accounts')">
        去添加
      </el-button>

    </div>



    <!-- File table card -->

    <div v-else class="file-card">

      <FileTable

        :files="fileList"
        :selected-files="selectedFiles"
        :selection-context="fileQueryKey"
        :density="tableDensity"
        :empty-title="appStore.isSearching ? '未找到匹配文件' : '此文件夹为空'"
        :empty-description="appStore.isSearching ? '尝试更换关键词或清除筛选条件' : '上传文件或新建文件夹后，内容会显示在这里'"

        :loading="loading"

        :capabilities="capabilities"

        @enter="onEnterDir"

        @rename="onRenameFile"

        @delete="onDeleteFile"

        @copy="onCopyFile"

        @archive="onArchiveFile"

        @compress="onCompressFile"

        @preview="onPreviewFile"

        @selection-change="onSelectionChange"

      />

      <div class="file-footer" role="status" aria-live="polite">
        <span>{{ loading ? '正在加载文件…' : `共 ${fileList.length} 项` }}<span v-if="selectedFiles.length"> · 已选择 {{ selectedFiles.length }} 项</span></span>
        <span>{{ isCached ? '离线缓存' : appStore.isSearching ? '网盘搜索结果' : '云端目录' }}</span>
      </div>
    </div>

    <!-- New Folder Dialog -->

    <el-dialog v-model="showNewFolder" title="新建文件夹" width="420px" class="folder-create-dialog">

      <div class="folder-create-content">
        <div class="dialog-feature-icon"><FolderPlus :size="20" /></div>
        <div class="folder-create-field">
          <label for="new-folder-name">文件夹名称</label>
          <el-input
            id="new-folder-name"
            v-model="newFolderName"
            placeholder="例如：项目资料"
            @keyup.enter="onCreateFolder"
            autofocus
          />
          <span>将在当前目录中创建</span>
        </div>
      </div>

      <template #footer>

        <el-button @click="showNewFolder = false">取消</el-button>

        <el-button type="primary" @click="onCreateFolder" :loading="creatingFolder" :disabled="!newFolderName.trim()">创建</el-button>

      </template>

    </el-dialog>



    <!-- Batch Rename Dialog -->

    <RenameDialog

      v-if="showBatchRename" v-model="showBatchRename"

      :files="selectedFiles"

      @success="onRefresh"

    />



    <!-- Single Rename Dialog -->

    <RenameDialog

      v-if="showSingleRename" v-model="showSingleRename"

      :files="renameTarget ? [renameTarget] : []"

      @success="onRefresh"

    />



    <!-- Batch Move Dialog -->

    <MoveDialog

      v-if="showBatchMove" v-model="showBatchMove"

      :files="selectedFiles"

      @success="onRefresh"

    />


    <!-- Download Dialog -->

    <DownloadDialog

      v-if="showDownloadDialog" v-model="showDownloadDialog"

      :account="appStore.currentAccount"

      :files="downloadFiles"

      @success="onRefresh"

    />

    <!-- Copy Dialog -->

    <CopyDialog

      v-if="showCopyDialog" v-model="showCopyDialog"

      :account="appStore.currentAccount"

      :files="copyFiles"

      :current-dir-id="appStore.currentPath"

      @success="onRefresh"

    />

    <!-- Archive Dialog -->

    <ArchiveDialog

      v-if="showArchiveDialog" v-model="showArchiveDialog"

      :account="appStore.currentAccount"

      :file-id="archiveTarget?.id || ''"

      :file-name="archiveTarget?.name || ''"

      :initial-password="archiveInitialPassword"

      @success="onRefresh"

    />

    <!-- Compress Dialog -->

    <CompressDialog

      v-if="showCompressDialog" v-model="showCompressDialog"

      :account="appStore.currentAccount"

      :files="compressFiles"

      :current-dir-id="appStore.currentPath"

      @success="onRefresh"

    />

    <!-- Search Filter Dialog -->

    <SearchFilterDialog

      v-if="showSearchFilter" v-model="showSearchFilter"

      :filters="searchFilters"

      @apply="onApplySearchFilters"

    />

    <FilePreviewDialog
      v-if="showPreviewDialog" v-model="showPreviewDialog"
      :account-id="appStore.currentAccount?.id || ''"
      :file-id="previewTarget?.id || ''"
      :file-name="previewTarget?.name || ''"
      :file-size="previewTarget?.size"
      :can-open-archive="capabilities.browseArchive"
      @open-archive="onArchivePreview"
    />

  </div>

</template>



<script setup lang="ts">

import { defineAsyncComponent, ref, watch, computed, onBeforeUnmount } from 'vue'

import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs'

import {

  ArrowLeft, RefreshCw, Search, X, ChevronRight,

  FolderPlus, Download, CheckCircle2, PenSquare, Database,

  FolderInput, Trash2, HardDrive, Share2, Filter, Copy, FolderArchive, Sparkles,

} from 'lucide-vue-next'

import { useRouter } from 'vue-router'

import { useAppStore } from '../stores/app'

import type { FileItem } from '@shared/types'
import { getPlatformCapabilities } from '@shared/capabilities'
import { detectFilePreviewType } from '@shared/file-preview'
import type { PlatformCapabilities } from '@shared/capabilities'

import { electronApi } from '../api/ipc'
import { catalogApi } from '../api/catalog'
import { resolveCatalogLocation, confirmCatalogLocation, type CatalogLocation } from '../catalog-navigation'

import FileTable from '../components/FileTable.vue'

const RenameDialog = defineAsyncComponent(() => import('../components/RenameDialog.vue'))

const MoveDialog = defineAsyncComponent(() => import('../components/MoveDialog.vue'))

const DownloadDialog = defineAsyncComponent(() => import('../components/DownloadDialog.vue'))
const CopyDialog = defineAsyncComponent(() => import('../components/CopyDialog.vue'))
const ArchiveDialog = defineAsyncComponent(() => import('../components/ArchiveDialog.vue'))
const CompressDialog = defineAsyncComponent(() => import('../components/CompressDialog.vue'))
const SearchFilterDialog = defineAsyncComponent(() => import('../components/SearchFilterDialog.vue'))
import type { SearchFilterOptions } from '../components/SearchFilterDialog.vue'
const FilePreviewDialog = defineAsyncComponent(() => import('../components/FilePreviewDialog.vue'))



const appStore = useAppStore()

const capabilities = computed(() => getPlatformCapabilities(appStore.currentAccount?.platform))



const fileList = ref<FileItem[]>([])
const currentFileIndex = computed(() => new Map(fileList.value.map(file => [file.id, file])))

const selectedFiles = ref<FileItem[]>([])

const tableDensity = ref<'comfortable' | 'compact'>(readTableDensity())
function readTableDensity(): 'comfortable' | 'compact' {
  try { return localStorage.getItem('panlite:file-density') === 'compact' ? 'compact' : 'comfortable' }
  catch { return 'comfortable' }
}
watch(tableDensity, (value) => {
  try { localStorage.setItem('panlite:file-density', value) } catch { /* 当前会话仍可使用密度设置 */ }
})


const aiImporting = ref(false)

const selectedCloudFiles = computed(() => selectedFiles.value.filter((item) => !item.isDir))

const router = useRouter()
const catalogLocation = ref<CatalogLocation | null>(null)
const catalogNavigationMessage = ref('')
const catalogNavigating = ref(false)
let catalogNavigationVersion = 0
let fileLoadVersion = 0
let disposed = false

async function importSelectionToAi() {
  const targets = selectedCloudFiles.value.slice(0, 20)
  if (!targets.length) { ElMessage.warning('请选择要导入的文件'); return }
  const operation = captureFileOperation(targets)
  if (!operation) return
  aiImporting.value = true
  try {
    const result = await electronApi.aiImportCloudFiles(targets.map((file) => ({ accountId: operation.accountId, fileId: file.id, fileName: file.name })))
    if (!operation.isCurrent()) return
    if (!result.success) throw new Error(result.error || '导入失败')
    const count = result.documents?.length || 0
    const failed = targets.length - count
    ElMessage.success(`已导入 ${count} 个文件到 AI 工作台${failed ? `，${failed} 个失败` : ''}`)
    void router.push('/ai-workspace')
  } catch (error) {
    if (operation.isCurrent()) ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    aiImporting.value = false
  }
}

const loading = ref(false)

const showNewFolder = ref(false)

const newFolderName = ref('')

const creatingFolder = ref(false)

const showBatchRename = ref(false)

const showBatchMove = ref(false)

const showSingleRename = ref(false)
const exporting = ref(false)
const isCached = ref(false)
const cacheTime = ref<number | null>(null)
const offlineReason = ref('')
const showDownloadDialog = ref(false)
const showCopyDialog = ref(false)
const showArchiveDialog = ref(false)
const archiveInitialPassword = ref('')
watch(showArchiveDialog, open => { if (!open) archiveInitialPassword.value = '' })
const showCompressDialog = ref(false)
const showSearchFilter = ref(false)
const showPreviewDialog = ref(false)
const copyTarget = ref<FileItem | null>(null)
const archiveTarget = ref<FileItem | null>(null)
const compressTarget = ref<FileItem | null>(null)
const searchFilters = ref<SearchFilterOptions>({})
const previewTarget = ref<FileItem | null>(null)

const renameTarget = ref<FileItem | null>(null)

const downloadFiles = computed(() => {
  return selectedFiles.value.map(f => ({
    fileId: f.id,
    fileName: f.name,
    fileSize: f.size,
    isDir: f.isDir,
  }))
})

const copyFiles = computed(() => copyTarget.value ? [copyTarget.value] : selectedFiles.value)
const compressFiles = computed(() => compressTarget.value ? [compressTarget.value] : selectedFiles.value)
const canDownloadSelection = computed(() => {
  if (!capabilities.value.downloadFile) return false
  return capabilities.value.downloadFolder || !selectedFiles.value.some(file => file.isDir)
})
const downloadSelectionTitle = computed(() => {
  if (!capabilities.value.downloadFile) return '当前网盘暂不支持下载'
  if (!capabilities.value.downloadFolder && selectedFiles.value.some(file => file.isDir)) {
    return '当前网盘暂不支持文件夹下载'
  }
  return '下载选中项目'
})
const canCompressSelection = computed(() => {
  if (!capabilities.value.createArchive) return false
  return capabilities.value.createArchiveFromFolder || !selectedFiles.value.some(file => file.isDir)
})
const compressSelectionTitle = computed(() => {
  if (!capabilities.value.createArchive) return '当前网盘暂不支持创建压缩包'
  if (!capabilities.value.createArchiveFromFolder && selectedFiles.value.some(file => file.isDir)) {
    return '暂不支持直接压缩网盘文件夹'
  }
  return '将选中项目创建为压缩包'
})

function capabilityTitle(feature: keyof PlatformCapabilities, action: string): string {
  return capabilities.value[feature] ? action : `当前网盘暂不支持${action}`
}



function clearSelection() {
  selectedFiles.value = []
  appStore.selectedCount = 0
}

function clearFileState() {
  fileList.value = []
  clearSelection()
  isCached.value = false
  cacheTime.value = null
  offlineReason.value = ''
}

// Directory listings and searches share one request generation so either mode
// can invalidate the other, including account switches and leaving the page.
async function loadFiles() {
  if (disposed || catalogNavigating.value) return
  const requestVersion = ++fileLoadVersion
  const queryKey = fileQueryKey.value
  const accountId = appStore.currentAccount?.id
  const parentId = appStore.currentPath
  const searching = appStore.isSearching
  const keyword = appStore.searchKeyword
  const filters: SearchFilterOptions = JSON.parse(JSON.stringify(searchFilters.value))
  const isCurrent = () => !disposed && requestVersion === fileLoadVersion && queryKey === fileQueryKey.value
  clearFileState()
  loading.value = false
  if (!accountId || (searching && !keyword)) return
  loading.value = true
  try {
    if (searching) {
      const result = await electronApi.searchFiles(accountId, keyword, filters)
      if (!isCurrent()) return
      if (!result.success) throw new Error(result.error || '搜索失败')
      fileList.value = result.files
      isCached.value = !!result.fromCache
      ElMessage.success(`找到 ${result.files.length} 个文件${result.fromCache ? '（来自缓存）' : ''}`)
      return
    }
    const result = await electronApi.listFiles(accountId, parentId, false)
    if (!isCurrent()) return
    const location = catalogLocation.value
    if (location && location.account.id === accountId && location.entry.parentId === parentId) {
      fileList.value = confirmCatalogLocation(location.entry, result)
      catalogNavigationMessage.value = `已在线确认：${fileList.value[0].name}（列表首项）`
      isCached.value = false
      cacheTime.value = null
      offlineReason.value = ''
      return
    }
    if (result.success) {
      fileList.value = result.files
      isCached.value = !!result.cached
      cacheTime.value = result.cacheTime ?? null
      offlineReason.value = result.offlineReason || ''
    } else {
      ElMessage.error(result.error || '\u52a0\u8f7d\u6587\u4ef6\u5217\u8868\u5931\u8d25')
      fileList.value = []
      isCached.value = false
      cacheTime.value = null
      offlineReason.value = ''
    }
  } catch (err) {
    if (!isCurrent()) return
    if (!searching && catalogLocation.value && catalogLocation.value.account.id === accountId && catalogLocation.value.entry.parentId === parentId) {
      catalogNavigationMessage.value = err instanceof Error ? err.message : '无法在线确认目标文件'
    }
    ElMessage.error((searching ? '搜索失败: ' : '加载文件列表失败: ') + String(err))
    clearFileState()
  } finally {
    if (isCurrent()) loading.value = false
  }
}



function onBack() { appStore.navigateBack() }

function onRefresh() { return loadFiles() }

function formatCacheTime(timestamp: number | null): string {
  if (!timestamp) return '缓存时间未知'
  return `缓存于 ${new Date(timestamp).toLocaleString()}`
}

function onEnterDir(file: FileItem) {
  if (captureFileOperation([file])) appStore.navigateTo(file.id, file.name)
}



function onBreadcrumbClick(item: { id: string; name: string }, index: number) {

  if (index === appStore.pathStack.length - 1) return

  appStore.pathStack.splice(index + 1)

  appStore.currentPath = item.id

  appStore.currentPathName = item.name

}



function onClearSearch() { appStore.clearSearch() }

function isCurrentFile(file: FileItem): boolean {
  const accountId = appStore.currentAccount?.id
  return !!accountId && file.accountId === accountId
    && currentFileIndex.value.get(file.id)?.accountId === accountId
}

function captureFileOperation(files: FileItem[]) {
  const accountId = appStore.currentAccount?.id
  if (disposed || loading.value || catalogNavigating.value || !accountId || !files.length || !files.every(isCurrentFile)) {
    ElMessage.warning('文件列表或账号已变化，请重新选择文件')
    return null
  }
  const version = fileLoadVersion
  return {
    accountId,
    isCurrent: () => !disposed && version === fileLoadVersion && accountId === appStore.currentAccount?.id,
  }
}

function onRenameFile(file: FileItem) {
  if (!captureFileOperation([file])) return

  if (!capabilities.value.rename) {
    ElMessage.warning('当前网盘暂不支持重命名')
    return
  }

  renameTarget.value = file

  showSingleRename.value = true

}



async function onDeleteFile(file: FileItem) {
  const operation = captureFileOperation([file])
  if (!operation) return
  if (!capabilities.value.delete) {
    ElMessage.warning('当前网盘暂不支持删除')
    return
  }

  try {

    await ElMessageBox.confirm(`确定要删除"${file.name}" 吗？`, '确认删除', {

      type: 'warning',

      confirmButtonText: '删除',

      cancelButtonText: '取消',

    })

  } catch { return }
  if (!operation.isCurrent()) return
  try {
    const result = await electronApi.deleteFiles(operation.accountId, [file.id])
    if (!operation.isCurrent()) return
    if (result.success) {
      fileList.value = fileList.value.filter((f) => f.id !== file.id)
      selectedFiles.value = selectedFiles.value.filter((f) => f.id !== file.id)
      appStore.selectedCount = selectedFiles.value.length
      ElMessage.success('删除成功')

    } else {

      ElMessage.error(result.error || '删除失败')

    }

  } catch (err) {
    if (operation.isCurrent()) ElMessage.error('删除失败: ' + String(err))
  }

}



function onSelectionChange(files: FileItem[]) {
  selectedFiles.value = !disposed && !loading.value ? files.filter(isCurrentFile) : []
  appStore.selectedCount = selectedFiles.value.length
}

function onCopyFile(file: FileItem) {
  if (!captureFileOperation([file])) return
  if (!capabilities.value.copy) {
    ElMessage.warning('当前网盘暂不支持服务端复制')
    return
  }
  copyTarget.value = file
  showCopyDialog.value = true
}

function onBatchCopy() {
  if (!captureFileOperation(selectedFiles.value)) return
  copyTarget.value = null
  showCopyDialog.value = true
}

function onArchiveFile(file: FileItem) {
  if (!captureFileOperation([file])) return
  if (!capabilities.value.browseArchive) {
    ElMessage.warning('当前网盘暂不支持浏览压缩包')
    return
  }
  archiveTarget.value = file
  archiveInitialPassword.value = ''
  showArchiveDialog.value = true
}

function onCompressFile(file: FileItem) {
  if (!captureFileOperation([file])) return
  if (!capabilities.value.createArchive) {
    ElMessage.warning('当前网盘暂不支持创建压缩包')
    return
  }
  if (file.isDir && !capabilities.value.createArchiveFromFolder) {
    ElMessage.warning('暂不支持直接压缩网盘文件夹')
    return
  }
  compressTarget.value = file
  showCompressDialog.value = true
}

function onPreviewFile(file: FileItem) {
  if (file.isDir || !captureFileOperation([file])) return
  if (!capabilities.value.downloadFile || !detectFilePreviewType(file.name).supported) {
    ElMessage.warning('当前文件或网盘暂不支持在线预览')
    return
  }
  previewTarget.value = file
  showPreviewDialog.value = true
}

function onArchivePreview(payload: { fileId: string; fileName: string; password?: string }) {
  if (!capabilities.value.browseArchive || previewTarget.value?.id !== payload.fileId) return
  if (!captureFileOperation([previewTarget.value])) return
  archiveTarget.value = previewTarget.value
  archiveInitialPassword.value = payload.password || ''
  showPreviewDialog.value = false
  showArchiveDialog.value = true
}

function onBatchCompress() {
  if (!captureFileOperation(selectedFiles.value)) return
  if (!canCompressSelection.value) {
    ElMessage.warning(compressSelectionTitle.value)
    return
  }
  compressTarget.value = null
  showCompressDialog.value = true
}

function onApplySearchFilters(filters: SearchFilterOptions) {
  searchFilters.value = filters
}

function onClearSearchFilters() {
  searchFilters.value = {}
}



async function onCreateFolder() {

  if (!newFolderName.value.trim()) {

    ElMessage.warning('请输入文件夹名称')

    return

  }

  if (!appStore.currentAccount) return



  creatingFolder.value = true

  try {

    const result = await electronApi.mkdir(

      appStore.currentAccount.id,

      appStore.currentPath,

      newFolderName.value.trim(),

    )

    if (result.success) {

      ElMessage.success('OK')

      showNewFolder.value = false

      newFolderName.value = ''

      await loadFiles()

    } else {

      ElMessage.error(result.error || '创建失败')

    }

  } catch (err) {

    ElMessage.error('创建失败: ' + String(err))

  } finally {

    creatingFolder.value = false

  }

}



async function onBatchDelete() {
  const targets = [...selectedFiles.value]
  const operation = captureFileOperation(targets)
  if (!operation) return
  const fileIds = targets.map(file => file.id)
  if (!capabilities.value.delete) {
    ElMessage.warning('当前网盘暂不支持删除')
    return
  }

  try {

    await ElMessageBox.confirm(

      `确定要删除选中的${targets.length} 个文件吗？`,

      '批量删除',

      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },

    )

  } catch { return }
  if (!operation.isCurrent()) return
  try {
    const result = await electronApi.deleteFiles(operation.accountId, fileIds)
    if (!operation.isCurrent()) return
    if (result.success) {

      const ids = new Set(fileIds)

      fileList.value = fileList.value.filter((f) => !ids.has(f.id))

      clearSelection()

      ElMessage.success('删除成功')

    } else {

      ElMessage.error(result.error || '删除失败')

    }

  } catch (err) {
    if (operation.isCurrent()) ElMessage.error('删除失败: ' + String(err))
  }

}



async function onExportCsv() {
  if (!appStore.currentAccount) return
  exporting.value = true
  try {
    const result = await electronApi.exportCsv(appStore.currentAccount.id, appStore.currentPath)
    if (result.success && result.csv) {
      const d = new Date()
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const filename = `panlite-files-${dateStr}.csv`
      const blob = new Blob(['\uFEFF' + result.csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      ElMessage.success('导出成功')
    } else {
      ElMessage.error(result.error || '导出失败')
    }
  } catch (err) {
    ElMessage.error('导出失败: ' + String(err))
  } finally {
    exporting.value = false
  }
}



watch(() => router.currentRoute?.value?.query, async query => {
  if (query?.from !== 'catalog') {
    catalogNavigationVersion++
    catalogNavigating.value = false
    catalogLocation.value = null
    catalogNavigationMessage.value = ''
    return
  }
  const version = ++catalogNavigationVersion
  fileLoadVersion++
  catalogNavigating.value = true
  loading.value = true
  fileList.value = []
  selectedFiles.value = []
  appStore.selectedCount = 0
  catalogLocation.value = null
  catalogNavigationMessage.value = '正在在线确认索引文件…'
  try {
    const location = await resolveCatalogLocation(query, catalogApi, () => electronApi.listAccounts())
    if (version !== catalogNavigationVersion) return
    catalogLocation.value = location
    catalogNavigating.value = false
    appStore.setAccount(location.account)
    const parentPath = location.entry.path.replace(/\/[^/]*$/, '') || '/'
    if (location.entry.parentId !== '0') appStore.navigateTo(location.entry.parentId, parentPath)
    // Batch the account/path changes into the same load, even when locating a
    // different indexed file in the already open directory.
    appStore.refreshKey++
  } catch (error) {
    if (version !== catalogNavigationVersion) return
    catalogNavigationMessage.value = error instanceof Error ? error.message : '文件定位失败'
    catalogNavigating.value = false
    loading.value = false
    fileList.value = []
  }
}, { immediate: true })

onBeforeUnmount(() => {
  disposed = true
  catalogNavigationVersion++
  fileLoadVersion++
  clearSelection()
})

const fileQueryKey = computed(() => JSON.stringify([
  appStore.currentAccount?.id, appStore.currentPath,
  appStore.isSearching, appStore.searchKeyword, searchFilters.value, appStore.refreshKey,
]))

// Invalidate immediately, then load once after a batched store update. This
// also reloads the directory on clear-search and resumes searches on remount.
watch(fileQueryKey, () => {
  fileLoadVersion++
  clearFileState()
  loading.value = false
}, { flush: 'sync' })
watch(fileQueryKey, onRefresh, { immediate: true })

watch(() => appStore.currentAccount?.id, () => {
  if (catalogNavigating.value) {
    catalogNavigationVersion++
    catalogNavigating.value = false
    loading.value = false
    catalogNavigationMessage.value = '已取消文件定位'
  }
  showPreviewDialog.value = false
  previewTarget.value = null
  showArchiveDialog.value = false
  archiveTarget.value = null
  showBatchRename.value = false
  showSingleRename.value = false
  renameTarget.value = null
  showBatchMove.value = false
  showDownloadDialog.value = false
  showCopyDialog.value = false
  copyTarget.value = null
  showCompressDialog.value = false
  compressTarget.value = null
  showNewFolder.value = false
}, { flush: 'sync' })

</script>



<style scoped>

.file-manager {

  height: 100%;

  display: flex;

  flex-direction: column;

  gap: 12px;

}



 .page-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  min-height: 42px;
  padding: 0 2px 2px;
}

.page-heading h1 {
  color: var(--pl-text);
  font-size: 20px;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.page-heading p {
  margin-top: 5px;
  color: var(--pl-text-muted);
  font-size: 12px;
}

.page-heading-meta {
  display: flex;
  align-items: center;
  max-width: 220px;
  padding: 6px 10px;
  color: var(--pl-text-secondary);
  background: var(--pl-surface-subtle);
  border: 1px solid var(--pl-border);
  border-radius: 8px;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Path bar ── */

.path-bar {

  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 12px;

  padding: 11px 14px;

  background: var(--pl-surface);

  border-radius: 14px;

  border: 1px solid var(--pl-border);

  box-shadow: 0 2px 8px rgba(31, 41, 55, 0.025);

}



.path-bar-left {

  display: flex;

  align-items: center;

  gap: 6px;

  min-width: 0;

  flex: 1;

}



.path-bar-right {

  display: flex;

  align-items: center;

  gap: 6px;

  flex-shrink: 0;

}



.path-btn {

  width: 32px;

  height: 32px;

  display: flex;

  align-items: center;

  justify-content: center;

  border: none;

  background: #f2f5f9;

  border-radius: 9px;

  color: var(--pl-text-secondary);

  cursor: pointer;

  transition: all 0.15s;

}

.path-btn:hover:not(:disabled) {

  background: #e8eef8;

  color: var(--pl-primary-hover);

}

.path-btn:disabled {

  opacity: 0.4;

  cursor: not-allowed;

}



.path-sep {

  width: 1px;

  height: 20px;

  background: var(--pl-border);

  margin: 0 4px;

}



.spinning {

  animation: spin 0.8s linear infinite;

}

@keyframes spin {

  from { transform: rotate(0deg); }

  to { transform: rotate(360deg); }

}



/* Breadcrumbs */

.breadcrumbs {

  display: flex;

  align-items: center;

  gap: 2px;

  overflow: hidden;

}



.crumb {

  font-size: 13px;

  color: var(--pl-text-secondary);

  cursor: pointer;

  padding: 4px 6px;

  border-radius: 4px;

  white-space: nowrap;

  transition: all 0.15s;

}

.crumb:hover {

  background: var(--pl-hover);

  color: var(--pl-primary);

}

.crumb.active {

  color: var(--pl-text);

  font-weight: 600;

  cursor: default;

}

.crumb.active:hover {

  background: transparent;

  color: var(--pl-text);

}



.crumb-sep {

  color: var(--pl-border);

  flex-shrink: 0;

}



/* Search tag */

.search-tag {

  display: flex;

  align-items: center;

  gap: 6px;

  padding: 4px 10px;

  background: var(--pl-primary-soft);

  border: 1px solid #bfdbfe;

  border-radius: 6px;

  font-size: 13px;

  color: var(--pl-primary);

}



.search-clear {

  display: flex;

  align-items: center;

  border: none;

  background: none;

  color: #93c5fd;

  cursor: pointer;

  padding: 0;

}

.search-clear:hover {

  color: var(--pl-primary);

}



/* ── Batch bar ── */

.batch-bar {

  display: flex;

  align-items: center;

  justify-content: space-between;

  padding: 10px 14px;

  background: var(--pl-primary-soft);

  border: 1px solid var(--pl-border-strong);

  border-radius: 12px;

  box-shadow: 0 3px 10px rgba(52, 120, 246, 0.08);

}



.batch-info {

  display: flex;

  align-items: center;

  gap: 8px;

  font-size: 13px;

  color: var(--pl-primary);

}



.batch-actions {

  display: flex;

  gap: 6px;

}



.slide-fade-enter-active,

.slide-fade-leave-active {

  transition: all 0.2s ease;

}

.slide-fade-enter-from,

.slide-fade-leave-to {

  opacity: 0;

  transform: translateY(-8px);

}



/* ── Empty state ── */

.empty-state {

  flex: 1;

  display: flex;

  flex-direction: column;

  align-items: center;

  justify-content: center;

  gap: 12px;

  min-height: 320px;

  background: rgba(255, 255, 255, 0.72);

  border: 1px dashed var(--pl-border-strong);

  border-radius: 16px;

  color: var(--pl-text-muted);

}



.empty-icon {

  width: 80px;

  height: 80px;

  background: var(--pl-primary-soft);

  border-radius: 22px;

  display: flex;

  align-items: center;

  justify-content: center;

  color: var(--pl-border);

  margin-bottom: 4px;

}



.empty-state h3 {

  font-size: 16px;

  font-weight: 600;

  color: var(--pl-text-secondary);

}



.empty-state p {

  font-size: 13px;

  color: var(--pl-text-muted);

  margin-bottom: 8px;

}



/* ── File card ── */

.file-card {

  flex: 1;

  overflow: hidden;

  background: var(--pl-surface);

  border-radius: 14px;

  border: 1px solid var(--pl-border);

  box-shadow: var(--pl-shadow-card);

  display: flex;

  flex-direction: column;

}



.load-more {

  display: flex;

  justify-content: center;

  padding: 8px 0 12px;

  border-top: 1px solid var(--pl-hover);

}

/* Cache badge */
.cache-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--pl-surface);
  border: 1px solid #f8df9c;
  border-radius: 10px;
  font-size: 12px;
  color: #92400e;
}

.cache-reason {
  max-width: 440px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #b45309;
}

/* Interaction refresh: keep the workbench light while making active states obvious. */
.file-manager { gap: 10px; min-height: 0; }

.page-heading { min-height: 32px; flex: 0 0 auto; align-items: center; padding: 0; }
.page-eyebrow {
  display: block;
  margin-bottom: 3px;
  color: var(--pl-primary);
  font-size: var(--pl-font-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
}
.page-heading-meta {
  padding: 7px 11px;
  color: var(--pl-primary-hover);
  background: var(--pl-primary-soft);
  border-color: var(--pl-border-strong);
  border-radius: 999px;
}

.path-bar {
  padding: 10px 12px;
  border-radius: var(--pl-radius-card);
}
.path-btn {
  color: var(--pl-text-secondary);
  background: var(--pl-surface-subtle);
  border: 1px solid transparent;
}
.path-btn:hover:not(:disabled) {
  color: var(--pl-primary-hover);
  background: var(--pl-primary-soft);
  border-color: var(--pl-border-strong);
  transform: translateY(-1px);
}
.path-btn:active:not(:disabled) { transform: translateY(0) scale(0.95); }
.path-btn:disabled { opacity: 0.42; }
.path-sep { background: var(--pl-border); }
.crumb { color: var(--pl-text-secondary); border-radius: 7px; }
.crumb:hover { color: var(--pl-primary); background: var(--pl-primary-soft); }
.crumb.active,
.crumb.active:hover { color: var(--pl-text); }
.crumb-sep { color: var(--pl-border-strong); }
.search-tag {
  color: var(--pl-primary);
  background: var(--pl-primary-soft);
  border-color: var(--pl-border-strong);
  border-radius: 8px;
}

.batch-bar {
  padding: 9px 11px 9px 14px;
  box-shadow: 0 6px 18px rgba(52, 120, 246, 0.08);
}
.batch-info { color: var(--pl-primary-hover); white-space: nowrap; }
.batch-check {
  width: 27px;
  height: 27px;
  display: grid;
  place-items: center;
  color: #fff;
  background: var(--pl-primary);
  border-radius: 9px;
  box-shadow: 0 3px 8px rgba(52, 120, 246, 0.22);
}
.batch-actions {
  min-width: 0;
  overflow-x: auto;
  padding: 2px;
}
.batch-actions :deep(.el-button) { flex: 0 0 auto; margin-left: 0; }

.empty-state { color: var(--pl-text-muted); background: var(--pl-surface); }
.empty-icon { color: var(--pl-primary); }
.empty-state h3 { color: var(--pl-text); }
.empty-state p { color: var(--pl-text-muted); }
.file-card { background: var(--pl-surface); }
.cache-badge {
  color: var(--pl-warning);
  background: var(--pl-warning-soft);
  border-color: #f4d797;
}
.cache-reason { color: #a86312; }

.folder-create-content {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.dialog-feature-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  color: var(--pl-primary);
  background: var(--pl-primary-soft);
  border: 1px solid #d5e3ff;
  border-radius: 13px;
}
.folder-create-field {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 7px;
}
.folder-create-field label { color: var(--pl-text); font-size: 13px; font-weight: 600; }
.folder-create-field > span { color: var(--pl-text-muted); font-size: var(--pl-font-xs); }

@media (max-width: 1120px) {
  .path-bar { flex-wrap: wrap; }
  .path-bar-right { margin-left: auto; }
  .batch-bar { gap: 10px; }
  .batch-actions { flex: 1; }
}

.heading-title { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.heading-title h1 { margin: 0; font-size: 20px; }
.heading-title > span { color: var(--pl-text-muted); font-size: 12px; }
.density-control { display: flex; gap: 2px; padding: 3px; border: 1px solid var(--pl-border); background: var(--pl-surface); border-radius: 8px; }
.density-control button { padding: 4px 10px; border: 0; border-radius: 5px; background: transparent; color: var(--pl-text-secondary); font-size: 12px; cursor: pointer; }
.density-control button.active { background: var(--pl-primary-soft); color: var(--pl-primary); }
.crumb { border: 0; background: transparent; font-family: inherit; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.path-bar { flex: 0 0 auto; padding: 9px 12px; box-shadow: none; }
.selection-slot { min-height: 46px; flex: 0 0 auto; }
.selection-hint { min-height: 46px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 4px; font-size: 12px; color: var(--pl-text-muted); }
.selection-hint > span:first-child { color: var(--pl-text-secondary); }
.batch-bar { min-height: 46px; gap: 16px; padding: 6px 10px; border-radius: 8px; box-shadow: none; }
.batch-check { width: 22px; height: 22px; border-radius: 6px; box-shadow: none; }
.batch-actions { flex: 1; justify-content: flex-end; }
.file-card { min-height: 160px; border-radius: 12px; box-shadow: none; }
.file-card > :deep(.file-table-wrapper) { flex: 1; min-height: 0; height: auto; }
.file-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; padding: 0 14px; flex: 0 0 auto; color: var(--pl-text-muted); font-size: 12px; border-top: 1px solid var(--pl-border); background: var(--pl-surface-subtle); }
.cache-badge { flex: 0 0 auto; flex-wrap: wrap; }
.path-btn:focus-visible, .crumb:focus-visible, .search-clear:focus-visible, .density-control button:focus-visible { outline: 2px solid var(--pl-primary); outline-offset: 2px; }
@media (max-width: 820px) { .heading-title > span, .selection-hint > span:last-child { display: none; } .batch-info { font-size: 12px; } .batch-actions { justify-content: flex-start; } }
</style>
