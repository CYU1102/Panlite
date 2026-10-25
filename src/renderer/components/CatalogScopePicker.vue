<template>
  <section class="scope-picker" :aria-label="mode === 'transfer' ? '选择网盘目录' : '选择索引目录'">
    <label class="field">选择账号
      <select v-model="accountId" :aria-label="mode === 'transfer' ? '目录账号' : '扫描账号'" :disabled="saving">
        <option value="">请选择账号</option>
        <option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.nickname }} · {{ PLATFORM_LABELS[account.platform] }}</option>
      </select>
    </label>
    <template v-if="accountId">
      <nav class="breadcrumbs" aria-label="目录层级">
        <template v-for="(item, index) in trail" :key="`${index}:${item.id}`">
          <span v-if="index" aria-hidden="true">/</span>
          <button type="button" :disabled="saving" @click="goBack(index)">{{ item.name }}</button>
        </template>
      </nav>
      <div v-if="loading" class="picker-state" role="status">正在读取目录…</div>
      <div v-else-if="error" class="picker-state error" role="alert">{{ error }} <button type="button" @click="loadDirectory()">重试</button></div>
      <template v-else>
        <p v-if="cached" class="picker-note">当前显示缓存目录，{{ offlineReason || '远端连接不可用' }}。{{ mode === 'transfer' ? '预演时需要重新连接网盘。' : '启动扫描时会重新连接网盘。' }}</p>
        <p v-if="hasMore" class="picker-note">网盘返回的目录结果不完整，{{ mode === 'transfer' ? '预演' : '扫描' }}可能失败。请稍后重试，或先进入一个已列出的子目录选择范围。</p>
        <div class="directory-list">
          <button v-for="folder in visibleFolders" :key="folder.id" type="button" class="folder" :disabled="saving" @click="enterFolder(folder)">
            <Folder :size="17" /><span>{{ folder.name }}</span><ChevronRight :size="15" />
          </button>
          <div v-if="!folders.length" class="picker-state">当前目录没有子文件夹，可以选择此目录。</div>
        </div>
        <div v-if="folders.length > PAGE_SIZE" class="picker-pagination">
          <button type="button" :disabled="page === 1 || saving" @click="page--">上一页目录</button>
          <span>{{ page }} / {{ Math.ceil(folders.length / PAGE_SIZE) }}</span>
          <button type="button" :disabled="page * PAGE_SIZE >= folders.length || saving" @click="page++">下一页目录</button>
        </div>
      </template>
    </template>
    <div class="picker-footer">
      <span>所选范围：{{ accountId ? current.path : '尚未选择账号' }}</span>
      <button type="button" :disabled="saving" @click="$emit('cancel')">取消</button>
      <button type="button" class="primary" :disabled="!accountId || loading || !!error || saving || !loaded" @click="confirm">{{ saving ? '正在保存…' : mode === 'transfer' ? '选择当前目录' : '添加当前目录' }}</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronRight, Folder } from 'lucide-vue-next'
import type { DriveAccount, FileItem } from '@shared/types'
import { PLATFORM_LABELS } from '@shared/constants'
import { electronApi } from '../api/ipc'

withDefaults(defineProps<{ accounts: Omit<DriveAccount, 'credential'>[]; saving: boolean; mode?: 'catalog' | 'transfer' }>(), { mode: 'catalog' })
const emit = defineEmits<{
  cancel: []
  select: [selection: { accountId: string; rootId: string; rootPath: string; rootName: string }]
}>()
const accountId = ref('')
const trail = ref([{ id: '0', name: '根目录', path: '/' }])
const current = computed(() => trail.value[trail.value.length - 1])
const folders = ref<FileItem[]>([])
const loading = ref(false)
const loaded = ref(false)
const cached = ref(false)
const hasMore = ref(false)
const offlineReason = ref('')
const error = ref('')
const PAGE_SIZE = 40
const page = ref(1)
const visibleFolders = computed(() => folders.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
let requestVersion = 0

async function loadDirectory() {
  const version = ++requestVersion
  const account = accountId.value
  const directory = current.value.id
  folders.value = []
  loaded.value = false
  error.value = ''
  page.value = 1
  loading.value = !!account
  if (!account) return
  try {
    const result = await electronApi.listFiles(account, directory, false)
    if (version !== requestVersion) return
    if (!result.success) throw new Error(result.error || '读取目录失败')
    folders.value = (result.files as FileItem[]).filter(file => file.isDir)
    cached.value = !!result.cached
    hasMore.value = !!result.hasMore
    offlineReason.value = result.offlineReason || ''
    loaded.value = true
  } catch (cause) {
    if (version === requestVersion) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

function enterFolder(folder: FileItem) {
  trail.value.push({ id: folder.id, name: folder.name, path: folder.path || `${current.value.path.replace(/\/$/, '')}/${folder.name}` })
  void loadDirectory()
}

function goBack(index: number) {
  trail.value = trail.value.slice(0, index + 1)
  void loadDirectory()
}

function confirm() {
  if (!loaded.value || loading.value || error.value || !accountId.value) return
  emit('select', { accountId: accountId.value, rootId: current.value.id, rootPath: current.value.path, rootName: current.value.name })
}

watch(accountId, () => {
  trail.value = [{ id: '0', name: '根目录', path: '/' }]
  void loadDirectory()
})
onBeforeUnmount(() => { requestVersion++ })
</script>

<style scoped>
.scope-picker { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--pl-border-strong); border-radius: var(--pl-radius-control); background: var(--pl-surface-subtle); }
.field { display: grid; gap: 6px; font-size: 12px; color: var(--pl-text-secondary); }
select, button { font: inherit; color: var(--pl-text); background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: 7px; }
select { width: 100%; min-height: 34px; padding: 5px 8px; }
button { padding: 6px 10px; cursor: pointer; }
button:hover:enabled { background: var(--pl-hover); }
button:disabled { opacity: .5; cursor: default; }
.breadcrumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.breadcrumbs button { border: 0; background: transparent; color: var(--pl-primary); overflow-wrap: anywhere; }
.directory-list { display: grid; max-height: 240px; overflow-y: auto; gap: 3px; }
.folder { display: flex; align-items: center; gap: 8px; text-align: left; border: 0; padding: 9px; }
.folder > span { flex: 1; overflow-wrap: anywhere; }
.folder > svg:first-child { color: var(--pl-warning); flex-shrink: 0; }
.picker-state { color: var(--pl-text-secondary); text-align: center; padding: 22px 6px; font-size: 12px; }
.picker-note { margin: 0; color: var(--pl-warning); font-size: 12px; }
.error { color: var(--pl-danger); }
.picker-pagination, .picker-footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; }
.picker-footer > span { flex: 1 1 200px; color: var(--pl-text-secondary); overflow-wrap: anywhere; }
.primary { color: white; border-color: var(--pl-primary); background: var(--pl-primary); }
.primary:hover:enabled { background: var(--pl-primary-hover); }
</style>
