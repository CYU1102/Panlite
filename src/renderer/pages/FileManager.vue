<template>

 <div class="file-manager">

 <div class="page-heading">
   <div>
     <span class="page-eyebrow">云端文件</span>
     <h1>文件管理</h1>
     <p>浏览、整理和传输云端文件</p>
   </div>
   <div class="page-heading-meta">
     <span v-if="appStore.hasAccount">{{ appStore.currentAccount?.nickname || '当前账号' }}</span>
     <span v-else>未连接账号</span>
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

 <button class="search-clear" @click="onClearSearch">

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

              <span

                class="crumb"

                :class="{ active: index === appStore.pathStack.length - 1 }"

                @click="onBreadcrumbClick(item, index)"

              >

                {{ item.name }}

              </span>

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

      v-model="showBatchRename"

      :files="selectedFiles"

      @success="onRefresh"

    />



    <!-- Single Rename Dialog -->

    <RenameDialog

      v-model="showSingleRename"

      :files="renameTarget ? [renameTarget] : []"

      @success="onRefresh"

    />



    <!-- Batch Move Dialog -->

    <MoveDialog

      v-model="showBatchMove"

      :files="selectedFiles"

      @success="onRefresh"

    />


    <!-- Download Dialog -->

    <DownloadDialog

      v-model="showDownloadDialog"

      :account="appStore.currentAccount"

      :files="downloadFiles"

      @success="onRefresh"

    />

    <!-- Copy Dialog -->

    <CopyDialog

      v-model="showCopyDialog"

      :account="appStore.currentAccount"

      :files="copyFiles"

      :current-dir-id="appStore.currentPath"

      @success="onRefresh"

    />

    <!-- Archive Dialog -->

    <ArchiveDialog

      v-model="showArchiveDialog"

      :account="appStore.currentAccount"

      :file-id="archiveTarget?.id || ''"

      :file-name="archiveTarget?.name || ''"

      @success="onRefresh"

    />

    <!-- Compress Dialog -->

    <CompressDialog

      v-model="showCompressDialog"

      :account="appStore.currentAccount"

      :files="compressFiles"

      :current-dir-id="appStore.currentPath"

      @success="onRefresh"

    />

    <!-- Search Filter Dialog -->

    <SearchFilterDialog

      v-model="showSearchFilter"

      :filters="searchFilters"

      @apply="onApplySearchFilters"

    />

    <FilePreviewDialog
      v-model="showPreviewDialog"
      :account-id="appStore.currentAccount?.id || ''"
      :file-id="previewTarget?.id || ''"
      :file-name="previewTarget?.name || ''"
      :file-size="previewTarget?.size"
      @open-archive="onArchivePreview"
    />

  </div>

</template>



<script setup lang="ts">

import { ref, watch, computed } from 'vue'

import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs'

import {

  ArrowLeft, RefreshCw, Search, X, ChevronRight,

  FolderPlus, Download, CheckCircle2, PenSquare, Database,

  FolderInput, Trash2, HardDrive, Share2, Filter, Copy, FolderArchive,

} from 'lucide-vue-next'

import { useAppStore } from '../stores/app'

import type { FileItem } from '@shared/types'
import { getPlatformCapabilities } from '@shared/capabilities'
import type { PlatformCapabilities } from '@shared/capabilities'

import { electronApi } from '../api/ipc'

import FileTable from '../components/FileTable.vue'

import RenameDialog from '../components/RenameDialog.vue'

import MoveDialog from '../components/MoveDialog.vue'

import DownloadDialog from '../components/DownloadDialog.vue'
import CopyDialog from '../components/CopyDialog.vue'
import ArchiveDialog from '../components/ArchiveDialog.vue'
import CompressDialog from '../components/CompressDialog.vue'
import SearchFilterDialog from '../components/SearchFilterDialog.vue'
import type { SearchFilterOptions } from '../components/SearchFilterDialog.vue'
import FilePreviewDialog from '../components/FilePreviewDialog.vue'



const appStore = useAppStore()

const capabilities = computed(() => getPlatformCapabilities(appStore.currentAccount?.platform))



const fileList = ref<FileItem[]>([])

const selectedFiles = ref<FileItem[]>([])

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



async function loadFiles() {
  if (!appStore.currentAccount) {
    fileList.value = []
    appStore.selectedCount = 0
    isCached.value = false
    cacheTime.value = null
    offlineReason.value = ''
    return
  }
  loading.value = true
  try {
    const result = await electronApi.listFiles(appStore.currentAccount.id, appStore.currentPath)
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
    ElMessage.error('\u52a0\u8f7d\u6587\u4ef6\u5217\u8868\u5931\u8d25: ' + String(err))
    fileList.value = []
    isCached.value = false
    cacheTime.value = null
    offlineReason.value = ''
  } finally {
    loading.value = false
  }
}



async function searchFiles() {

  if (!appStore.currentAccount || !appStore.searchKeyword) {

    fileList.value = []

    return

  }

  loading.value = true

  try {

    const result = await electronApi.searchFiles(
      appStore.currentAccount.id,
      appStore.searchKeyword,
      searchFilters.value
    )

    if (result.success) {

      fileList.value = result.files

      // 显示搜索结果摘要
      if (result.fromCache) {
        ElMessage.success(`找到 ${result.files.length} 个文件（来自缓存）`)
      } else {
        ElMessage.success(`找到 ${result.files.length} 个文件`)
      }

    } else {

      ElMessage.error(result.error || '搜索失败')

      fileList.value = []

    }

  } catch (err) {

    ElMessage.error('搜索失败: ' + String(err))

    fileList.value = []

  } finally {

    loading.value = false

  }

}



function onBack() { appStore.navigateBack() }

function onRefresh() {
  if (appStore.isSearching) searchFiles()
  else loadFiles()
}

function formatCacheTime(timestamp: number | null): string {
  if (!timestamp) return '缓存时间未知'
  return `缓存于 ${new Date(timestamp).toLocaleString()}`
}

function onEnterDir(file: FileItem) { appStore.navigateTo(file.id, file.name) }



function onBreadcrumbClick(item: { id: string; name: string }, index: number) {

  if (index === appStore.pathStack.length - 1) return

  appStore.pathStack.splice(index + 1)

  appStore.currentPath = item.id

  appStore.currentPathName = item.name

}



function onClearSearch() { appStore.clearSearch() }

function onRenameFile(file: FileItem) {

  if (!capabilities.value.rename) {
    ElMessage.warning('当前网盘暂不支持重命名')
    return
  }

  renameTarget.value = file

  showSingleRename.value = true

}



async function onDeleteFile(file: FileItem) {

  if (!appStore.currentAccount) return

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



  try {

    const result = await electronApi.deleteFiles(appStore.currentAccount.id, [file.id])

    if (result.success) {

      fileList.value = fileList.value.filter((f) => f.id !== file.id)

      ElMessage.success('删除成功')

    } else {

      ElMessage.error(result.error || '删除失败')

    }

  } catch (err) {

    ElMessage.error('删除失败: ' + String(err))

  }

}



function onSelectionChange(files: FileItem[]) {

  selectedFiles.value = files

  appStore.selectedCount = files.length

}

function onCopyFile(file: FileItem) {
  if (!capabilities.value.copy) {
    ElMessage.warning('当前网盘暂不支持服务端复制')
    return
  }
  copyTarget.value = file
  showCopyDialog.value = true
}

function onBatchCopy() {
  copyTarget.value = null
  showCopyDialog.value = true
}

function onArchiveFile(file: FileItem) {
  if (!capabilities.value.browseArchive) {
    ElMessage.warning('当前网盘暂不支持浏览压缩包')
    return
  }
  archiveTarget.value = file
  showArchiveDialog.value = true
}

function onCompressFile(file: FileItem) {
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
  if (!appStore.currentAccount || file.isDir) return
  previewTarget.value = file
  showPreviewDialog.value = true
}

function onArchivePreview(payload: { fileId: string; fileName: string }) {
  previewTarget.value = { id: payload.fileId, name: payload.fileName } as FileItem
  showPreviewDialog.value = false
  showArchiveDialog.value = true
}

function onBatchCompress() {
  if (!canCompressSelection.value) {
    ElMessage.warning(compressSelectionTitle.value)
    return
  }
  compressTarget.value = null
  showCompressDialog.value = true
}

function onApplySearchFilters(filters: SearchFilterOptions) {
  searchFilters.value = filters
  // 重新搜索
  if (appStore.isSearching) {
    searchFiles()
  }
}

function onClearSearchFilters() {
  searchFilters.value = {}
  // 重新搜索
  if (appStore.isSearching) {
    searchFiles()
  }
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

  if (!appStore.currentAccount) return

  if (!capabilities.value.delete) {
    ElMessage.warning('当前网盘暂不支持删除')
    return
  }

  try {

    await ElMessageBox.confirm(

      `确定要删除选中的${selectedFiles.value.length} 个文件吗？`,

      '批量删除',

      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },

    )

  } catch { return }



  const fileIds = selectedFiles.value.map((f) => f.id)

  try {

    const result = await electronApi.deleteFiles(appStore.currentAccount.id, fileIds)

    if (result.success) {

      const ids = new Set(fileIds)

      fileList.value = fileList.value.filter((f) => !ids.has(f.id))

      selectedFiles.value = []

      ElMessage.success('删除成功')

    } else {

      ElMessage.error(result.error || '删除失败')

    }

  } catch (err) {

    ElMessage.error('删除失败: ' + String(err))

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



watch(

  () => [appStore.currentAccount?.id, appStore.currentPath],

  ([accountId]) => {

    if (accountId && !appStore.isSearching) loadFiles()

  },

  { immediate: true },

)



watch(

  () => [appStore.isSearching, appStore.searchKeyword],

  ([searching, keyword]) => {

    if (searching && keyword) searchFiles()

  },

)



watch(() => appStore.refreshKey, () => onRefresh())

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

  color: #6b7280;

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

  background: #e5e7eb;

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

  color: #6b7280;

  cursor: pointer;

  padding: 4px 6px;

  border-radius: 4px;

  white-space: nowrap;

  transition: all 0.15s;

}

.crumb:hover {

  background: #f3f4f6;

  color: #3b82f6;

}

.crumb.active {

  color: #1f2937;

  font-weight: 600;

  cursor: default;

}

.crumb.active:hover {

  background: transparent;

  color: #1f2937;

}



.crumb-sep {

  color: #d1d5db;

  flex-shrink: 0;

}



/* Search tag */

.search-tag {

  display: flex;

  align-items: center;

  gap: 6px;

  padding: 4px 10px;

  background: #eff6ff;

  border: 1px solid #bfdbfe;

  border-radius: 6px;

  font-size: 13px;

  color: #3b82f6;

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

  color: #3b82f6;

}



/* ── Batch bar ── */

.batch-bar {

  display: flex;

  align-items: center;

  justify-content: space-between;

  padding: 10px 14px;

  background: linear-gradient(90deg, var(--pl-primary-soft) 0%, #f5f8ff 100%);

  border: 1px solid #cfe0ff;

  border-radius: 12px;

  box-shadow: 0 3px 10px rgba(52, 120, 246, 0.08);

}



.batch-info {

  display: flex;

  align-items: center;

  gap: 8px;

  font-size: 13px;

  color: #3b82f6;

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

  color: #9ca3af;

}



.empty-icon {

  width: 80px;

  height: 80px;

  background: var(--pl-primary-soft);

  border-radius: 22px;

  display: flex;

  align-items: center;

  justify-content: center;

  color: #d1d5db;

  margin-bottom: 4px;

}



.empty-state h3 {

  font-size: 16px;

  font-weight: 600;

  color: #6b7280;

}



.empty-state p {

  font-size: 13px;

  color: #9ca3af;

  margin-bottom: 8px;

}



/* ── File card ── */

.file-card {

  flex: 1;

  overflow: hidden;

  background: #ffffff;

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

  border-top: 1px solid #f3f4f6;

}

/* Cache badge */
.cache-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #fffaf0;
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
.file-manager { gap: 14px; }

.page-heading { min-height: 52px; }
.page-eyebrow {
  display: block;
  margin-bottom: 3px;
  color: var(--pl-primary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.page-heading-meta {
  padding: 7px 11px;
  color: var(--pl-primary-hover);
  background: var(--pl-primary-soft);
  border-color: #d5e3ff;
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
  border-color: #d5e3ff;
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
  border-color: #cfe0ff;
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
.folder-create-field > span { color: var(--pl-text-muted); font-size: 11px; }

@media (max-width: 1120px) {
  .path-bar { align-items: flex-start; flex-direction: column; }
  .path-bar-right { width: 100%; justify-content: flex-end; }
  .batch-bar { align-items: flex-start; flex-direction: column; gap: 8px; }
  .batch-actions { width: 100%; }
}
</style>

