<template>
  <el-dialog
    title="移动到"
    :model-value="modelValue"
    width="560px"
    class="move-dialog"
    @close="onClose"
  >
    <div class="move-content">
      <div class="info"><FolderInput :size="16" /><span>正在移动 <strong>{{ files.length }}</strong> 个项目</span></div>

      <!-- Breadcrumb navigation -->
      <div class="folder-nav">
        <div class="folder-breadcrumb">
          <template v-for="(item, index) in navStack" :key="item.id">
            <ChevronRight v-if="index > 0" class="crumb-sep" :size="12" />
            <span
              class="crumb"
              :class="{ active: index === navStack.length - 1 }"
              @click="onBreadcrumbClick(index)"
            >
              {{ item.name }}
            </span>
          </template>
        </div>
        <button
          class="nav-btn"
          :disabled="navStack.length <= 1"
          @click="onGoBack"
          title="返回上级"
        >
          <ArrowLeft :size="14" />
        </button>
      </div>

      <!-- Folder list -->
      <div class="folder-list" v-loading="loading">
        <div v-if="folders.length === 0 && !loading" class="folder-empty">
          <FolderOpen :size="24" :stroke-width="1" />
          <span>此文件夹为空</span>
        </div>
        <div
          v-for="folder in folders"
          :key="folder.id"
          class="folder-item"
          :class="{ disabled: isDisabled(folder) }"
          :tabindex="isDisabled(folder) ? -1 : 0"
          :aria-disabled="isDisabled(folder)"
          @click="onFolderClick(folder)"
          @keydown.enter="onFolderClick(folder)"
        >
          <span class="folder-icon"><FolderOpen :size="16" :stroke-width="1.5" /></span>
          <span class="folder-name">{{ folder.name }}</span>
          <ChevronRight :size="14" class="folder-arrow" />
        </div>
      </div>

      <p class="target-info" v-if="navStack.length > 0">
        <FolderCheck :size="15" />
        <span>将移动到</span><strong>{{ currentFolder.name }}</strong>
      </p>
    </div>

    <template #footer>
      <el-button @click="onClose">取消</el-button>
      <el-button type="primary" @click="onConfirm" :loading="moving">移动到此处</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { FolderOpen, ChevronRight, ArrowLeft, FolderInput, FolderCheck } from 'lucide-vue-next'
import type { FileItem } from '@shared/types'
import { electronApi } from '../api/ipc'

interface NavItem { id: string; name: string }

const props = defineProps<{
  modelValue: boolean
  files: FileItem[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const navStack = ref<NavItem[]>([{ id: '0', name: '根目录' }])
const folders = ref<FileItem[]>([])
const loading = ref(false)
const moving = ref(false)

// Set of file IDs being moved (to disable them in the folder list)
const movingIds = new Set<string>()

// Also track all descendant paths for Baidu (path-based IDs)
const movingPaths = new Set<string>()

const currentFolder = ref<NavItem>({ id: '0', name: '根目录' })

function isDisabled(folder: FileItem): boolean {
  // Can't move to self
  if (movingIds.has(folder.id)) return true
  // For Baidu path-based IDs, check if this folder is a descendant
  if (folder.path && movingPaths.has(folder.path)) return true
  return false
}

async function loadFolders(parentId: string) {
  const account = props.files[0]?.accountId
  if (!account) return

  loading.value = true
  try {
    const result = await electronApi.listFiles(account, parentId)
    if (result.success) {
      folders.value = result.files.filter((f: FileItem) => f.isDir)
    } else {
      ElMessage.error(result.error || '加载文件夹失败')
      folders.value = []
    }
  } catch (err) {
    ElMessage.error('加载文件夹失败: ' + String(err))
    folders.value = []
  } finally {
    loading.value = false
  }
}

function onFolderClick(folder: FileItem) {
  if (isDisabled(folder)) return
  navStack.value.push({ id: folder.id, name: folder.name })
  currentFolder.value = { id: folder.id, name: folder.name }
  loadFolders(folder.id)
}

function onBreadcrumbClick(index: number) {
  if (index === navStack.value.length - 1) return
  navStack.value.splice(index + 1)
  currentFolder.value = navStack.value[navStack.value.length - 1]
  loadFolders(currentFolder.value.id)
}

function onGoBack() {
  if (navStack.value.length > 1) {
    navStack.value.pop()
    currentFolder.value = navStack.value[navStack.value.length - 1]
    loadFolders(currentFolder.value.id)
  }
}

function onClose() {
  emit('update:modelValue', false)
}

async function onConfirm() {
  if (!currentFolder.value) return

  const account = props.files[0]?.accountId
  if (!account) return

  moving.value = true
  try {
    const fileIds = props.files.map((f) => f.id)
    const result = await electronApi.moveFiles(account, fileIds, currentFolder.value.id)
    if (result.success) {
      ElMessage.success('移动完成')
      emit('update:modelValue', false)
      emit('success')
    } else {
      ElMessage.error(result.error || '移动失败')
    }
  } catch (err) {
    ElMessage.error('移动失败: ' + String(err))
  } finally {
    moving.value = false
  }
}

// Reset state when dialog opens
watch(() => props.modelValue, (open) => {
  if (open) {
    navStack.value = [{ id: '0', name: '根目录' }]
    currentFolder.value = { id: '0', name: '根目录' }
    movingIds.clear()
    movingPaths.clear()
    for (const f of props.files) {
      movingIds.add(f.id)
      if (f.path) movingPaths.add(f.path)
    }
    loadFolders('0')
  }
})
</script>

<style scoped>
.move-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info {
  color: #606266;
  font-size: 14px;
}

.folder-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: #f9fafb;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
}

.folder-breadcrumb {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.crumb {
  font-size: 13px;
  color: #6b7280;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
}
.crumb:hover { background: #e5e7eb; color: #3b82f6; }
.crumb.active { color: #1f2937; font-weight: 600; cursor: default; }
.crumb.active:hover { background: transparent; }
.crumb-sep { color: #d1d5db; flex-shrink: 0; }

.nav-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: #e5e7eb;
  border-radius: 6px;
  color: #6b7280;
  cursor: pointer;
  flex-shrink: 0;
}
.nav-btn:hover:not(:disabled) { background: #d1d5db; color: #374151; }
.nav-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.folder-list {
  min-height: 200px;
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}

.folder-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 40px 0;
  color: #d1d5db;
}
.folder-empty span { font-size: 13px; color: #9ca3af; }

.folder-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  cursor: pointer;
  color: #374151;
  border-bottom: 1px solid #f3f4f6;
  transition: background 0.1s;
}
.folder-item:last-child { border-bottom: none; }
.folder-item:hover { background: #f9fafb; }
.folder-item.disabled { opacity: 0.4; cursor: not-allowed; }
.folder-item.disabled:hover { background: transparent; }

.folder-name { flex: 1; font-size: 13px; }
.folder-arrow { color: #d1d5db; flex-shrink: 0; }

.target-info {
  font-size: 13px;
  color: #6b7280;
  padding: 4px 0;
}
.move-content { gap: 11px; }
.info {
  display: flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  padding: 6px 10px;
  color: var(--pl-primary-hover);
  background: var(--pl-primary-soft);
  border-radius: 8px;
  font-size: 12px;
}
.folder-nav { padding: 8px 10px; background: var(--pl-surface-subtle); border-color: var(--pl-border); border-radius: 11px; }
.crumb { color: var(--pl-text-secondary); border-radius: 7px; }
.crumb:hover { color: var(--pl-primary); background: var(--pl-primary-soft); }
.crumb.active { color: var(--pl-text); }
.crumb-sep { color: var(--pl-border-strong); }
.nav-btn { color: var(--pl-text-secondary); background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: 8px; transition: all .16s ease; }
.nav-btn:hover:not(:disabled) { color: var(--pl-primary); background: var(--pl-primary-soft); border-color: #cfe0ff; transform: translateX(-1px); }
.folder-list { min-height: 230px; background: var(--pl-surface-subtle); border-color: var(--pl-border); border-radius: 12px; }
.folder-item { gap: 10px; min-height: 46px; padding: 6px 10px; color: var(--pl-text); border-bottom-color: var(--pl-border); transition: background-color .16s ease, color .16s ease, padding-left .16s ease; }
.folder-item:hover,
.folder-item:focus-visible { color: var(--pl-primary-hover); background: var(--pl-primary-soft); outline: none; padding-left: 13px; }
.folder-item.disabled { opacity: .38; }
.folder-item.disabled:hover { padding-left: 10px; background: transparent; }
.folder-icon { width: 31px; height: 31px; display: grid; place-items: center; color: var(--pl-primary); background: var(--pl-primary-soft); border-radius: 9px; }
.folder-arrow { color: var(--pl-border-strong); transition: transform .16s ease, color .16s ease; }
.folder-item:hover .folder-arrow { color: var(--pl-primary); transform: translateX(2px); }
.folder-empty { min-height: 220px; justify-content: center; color: var(--pl-border-strong); }
.folder-empty span { color: var(--pl-text-muted); }
.target-info { display: flex; align-items: center; gap: 6px; margin: 0; padding: 9px 11px; color: var(--pl-text-secondary); background: var(--pl-success-soft); border: 1px solid #ccebe2; border-radius: 10px; }
.target-info svg { color: var(--pl-success); }
.target-info strong { color: #117b69; }
</style>
