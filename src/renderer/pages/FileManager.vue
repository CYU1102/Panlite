<template>

 <div class="file-manager">

 <!-- Breadcrumb / navigation bar -->

 <div class="path-bar">

 <div class="path-bar-left">

 <button

 class="path-btn"

 :disabled="appStore.pathStack.length <= 1 || appStore.isSearching"

 @click="onBack"

 >

 <ArrowLeft :size="16" :stroke-width="2" />

 </button>

 <button class="path-btn" @click="onRefresh" :disabled="loading">

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

        <el-button size="small" @click="showNewFolder = true" :disabled="!appStore.hasAccount">
          <FolderPlus :size="14" style="margin-right: 4px" />
          新建文件夹
        </el-button>

        <el-button size="small" @click="onExportCsv" :disabled="!appStore.hasAccount" :loading="exporting">
          <Download :size="14" style="margin-right: 4px" />
          导出 CSV
        </el-button>

      </div>

    </div>
    <!-- Cache status badge -->
    <div v-if="isCached && appStore.hasAccount && !appStore.isSearching" class="cache-badge">
      <Database :size="14" />
      <span>离线缓存数据</span>
      <el-button size="small" text @click="onRefresh">
        <RefreshCw :size="12" />
        刷新
      </el-button>
    </div>





    <!-- Batch action bar -->

    <transition name="slide-fade">

      <div v-if="selectedFiles.length > 0" class="batch-bar">

        <div class="batch-info">

          <CheckCircle2 :size="16" />

          已选择 <strong>{{ selectedFiles.length }}</strong> 个项目
        </div>

        <div class="batch-actions">

          <el-button size="small" @click="showBatchRename = true">

            <PenSquare :size="14" style="margin-right: 4px" />
            批量重命名
          </el-button>

          <el-button size="small" @click="showBatchMove = true">

            <FolderInput :size="14" style="margin-right: 4px" />
            批量移动
          </el-button>

          <el-button size="small" @click="$router.push('/batch-share')">

            <Share2 :size="14" style="margin-right: 4px" />
            批量分享
          </el-button>

          <el-button size="small" type="danger" plain @click="onBatchDelete">

            <Trash2 :size="14" style="margin-right: 4px" />
            批量删除
          </el-button>

          <el-button size="small" @click="showDownloadDialog = true">

            <Download :size="14" style="margin-right: 4px" />
            下载
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

        @enter="onEnterDir"

        @rename="onRenameFile"

        @delete="onDeleteFile"

        @copy="onCopyFile"

        @archive="onArchiveFile"

        @compress="onCompressFile"

        @selection-change="onSelectionChange"

      />

    </div>



    <!-- New Folder Dialog -->

    <el-dialog v-model="showNewFolder" title="新建文件夹" width="400px">

      <el-input

        v-model="newFolderName"

        placeholder="请输入文件夹名称"
        @keyup.enter="onCreateFolder"

        autofocus

      />

      <template #footer>

        <el-button @click="showNewFolder = false">取消</el-button>

        <el-button type="primary" @click="onCreateFolder" :loading="creatingFolder">创建</el-button>

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

      :files="copyTarget ? [copyTarget] : []"

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

      :files="compressTarget ? [compressTarget] : []"

      :current-dir-id="appStore.currentPath"

      @success="onRefresh"

    />

    <!-- Search Filter Dialog -->

    <SearchFilterDialog

      v-model="showSearchFilter"

      :filters="searchFilters"

      @apply="onApplySearchFilters"

    />

  </div>

</template>



<script setup lang="ts">

import { ref, watch, computed } from 'vue'

import { ElMessage, ElMessageBox } from 'element-plus'

import {

  ArrowLeft, RefreshCw, Search, X, ChevronRight,

  FolderPlus, Download, CheckCircle2, PenSquare, Database,

  FolderInput, Trash2, HardDrive, Share2, Filter,

} from 'lucide-vue-next'

import { useAppStore } from '../stores/app'

import type { FileItem } from '@shared/types'

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



const appStore = useAppStore()



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
const showDownloadDialog = ref(false)
const showCopyDialog = ref(false)
const showArchiveDialog = ref(false)
const showCompressDialog = ref(false)
const showSearchFilter = ref(false)
const copyTarget = ref<FileItem | null>(null)
const archiveTarget = ref<FileItem | null>(null)
const compressTarget = ref<FileItem | null>(null)
const searchFilters = ref<SearchFilterOptions>({})

const renameTarget = ref<FileItem | null>(null)

const currentDirName = computed(() => {
  const stack = appStore.pathStack
  return stack.length > 0 ? stack[stack.length - 1].name : '根目录'
})

const downloadFiles = computed(() => {
  return selectedFiles.value.map(f => ({
    fileId: f.id,
    fileName: f.name,
    fileSize: f.size,
    isDir: f.isDir,
  }))
})



async function loadFiles() {
  if (!appStore.currentAccount) {
    fileList.value = []
    appStore.selectedCount = 0
    isCached.value = false
    cacheTime.value = null
    return
  }
  loading.value = true
  try {
    const result = await electronApi.listFiles(appStore.currentAccount.id, appStore.currentPath)
    if (result.success) {
      fileList.value = result.files
      isCached.value = !!result.cached
      cacheTime.value = result.cacheTime ?? null
    } else {
      ElMessage.error(result.error || '\u52a0\u8f7d\u6587\u4ef6\u5217\u8868\u5931\u8d25')
      fileList.value = []
      isCached.value = false
      cacheTime.value = null
    }
  } catch (err) {
    ElMessage.error('\u52a0\u8f7d\u6587\u4ef6\u5217\u8868\u5931\u8d25: ' + String(err))
    fileList.value = []
    isCached.value = false
    cacheTime.value = null
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

function onRefresh() { appStore.isSearching ? searchFiles() : loadFiles() }

function onEnterDir(file: FileItem) { appStore.navigateTo(file.id, file.name) }



function onBreadcrumbClick(item: { id: string; name: string }, index: number) {

  if (index === appStore.pathStack.length - 1) return

  appStore.pathStack.splice(index + 1)

  appStore.currentPath = item.id

  appStore.currentPathName = item.name

}



function onClearSearch() { appStore.clearSearch() }

function onRenameFile(file: FileItem) {

  renameTarget.value = file

  showSingleRename.value = true

}



async function onDeleteFile(file: FileItem) {

  if (!appStore.currentAccount) return

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
  copyTarget.value = file
  showCopyDialog.value = true
}

function onArchiveFile(file: FileItem) {
  archiveTarget.value = file
  showArchiveDialog.value = true
}

function onCompressFile(file: FileItem) {
  if (appStore.currentAccount?.platform === 'baidu') {
    ElMessage.warning('百度网盘暂不支持在线压缩，请使用其他工具压缩后上传')
    return
  }
  compressTarget.value = file
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



/* ── Path bar ── */

.path-bar {

  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 12px;

  padding: 10px 16px;

  background: #ffffff;

  border-radius: 12px;

  border: 1px solid #e5e7eb;

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

  background: #f3f4f6;

  border-radius: 8px;

  color: #6b7280;

  cursor: pointer;

  transition: all 0.15s;

}

.path-btn:hover:not(:disabled) {

  background: #e5e7eb;

  color: #374151;

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

  padding: 10px 16px;

  background: #eff6ff;

  border: 1px solid #bfdbfe;

  border-radius: 12px;

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

  color: #9ca3af;

}



.empty-icon {

  width: 80px;

  height: 80px;

  background: #f3f4f6;

  border-radius: 20px;

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

  border-radius: 12px;

  border: 1px solid #e5e7eb;

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
  padding: 8px 16px;
  background: #fefce8;
  border: 1px solid #fde68a;
  border-radius: 10px;
  font-size: 12px;
  color: #92400e;
}

</style>

