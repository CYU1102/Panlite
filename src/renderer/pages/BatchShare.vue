<template>

 <div class="batch-share">

 <!-- Page header -->

 <div class="page-header">

 <div class="header-info">

 <div class="header-icon">

 <Share2 :size="20" :stroke-width="1.5" />

 </div>

 <div>

 <h2>批量分享</h2>

 <p>选择文件或文件夹，批量创建分享链接</p>

 </div>

 </div>

 </div>

 <div class="share-body">

 <!-- Left: file picker -->

 <div class="panel file-panel">

 <div class="panel-title">选择文件</div>

 <!-- Account selector -->

 <div class="account-bar">

 <el-select v-model="platform" style="width: 120px">

 <el-option label="夸克网盘" value="quark" />

 <el-option label="百度网盘" value="baidu" />

 <el-option label="UC网盘" value="uc" />

 <el-option label="迅雷网盘" value="xunlei" />

 </el-select>

 <el-select

 v-model="selectedAccountId"

 placeholder="选择账号"

 style="flex: 1"

 filterable

 size="default"

 >

 <el-option

 v-for="acc in filteredAccounts"

 :key="acc.id"

 :label="acc.nickname || acc.id"

 :value="acc.id"

 />

 </el-select>

 </div>

 <el-alert

 v-if="needsCookieHint"

 title="Cookie 登录"
 description="建议使用 Cookie 方式登录百度网盘以获得分享权限"

 type="warning"

 :closable="false"

 show-icon

 style="margin-bottom: 8px"

 />

 <div v-if="!selectedAccountId" class="file-empty">

 <FolderOpen :size="32" :stroke-width="1" />

 <p>分享设置</p>

 </div>

 <template v-else>

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



          <!-- File list with checkboxes -->

          <div class="file-list" v-loading="loadingFiles">

            <div v-if="files.length === 0 && !loadingFiles" class="file-empty-list">

              <FolderOpen :size="24" :stroke-width="1" />

              <span>此文件夹为空</span>

            </div>

            <div

              v-for="file in files"

              :key="file.id"

              class="file-item"

              :class="{ selected: isSelected(file.id) }"

              @click="onToggle(file)"

            >

              <div class="file-check">

                <el-checkbox

                  :model-value="isSelected(file.id)"

                  @click.stop

                  @change="onToggle(file)"

                />

              </div>

              <div class="file-icon" :class="file.isDir ? 'dir' : 'file'">

                <FolderOpen v-if="file.isDir" :size="16" :stroke-width="1.5" />

                <File v-else :size="16" :stroke-width="1.5" />

              </div>

              <span class="file-name">{{ file.name }}</span>

              <span class="file-size">{{ file.isDir ? '-' : formatFileSize(file.size) }}</span>

              <button

                v-if="file.isDir"

                class="file-enter"

                @click.stop="onEnterDir(file)"

                title="进入文件夹"
              >

                <ChevronRight :size="14" />

              </button>

            </div>

          </div>

        </template>

      </div>



      <!-- Right: share options + selected files -->

      <div class="panel options-panel">

        <div class="panel-title">分享设置</div>



        <el-form label-position="top">

          <el-form-item label="分享模式">

            <el-select v-model="shareMode" style="width: 100%">

              <el-option label="合并分享（一个链接）" value="combined" />

              <el-option label="单独分享（每文件一个链接）" value="separate" />

            </el-select>

          </el-form-item>

          <el-form-item label="过期时间">
            <el-select v-model="expireDays" style="width: 100%">
              <el-option label="永久有效" :value="0" />
              <el-option label="1天" :value="1" />
              <el-option label="7天" :value="7" />
              <el-option label="30天" :value="30" />
            </el-select>
          </el-form-item>

          <el-form-item label="提取码">
            <el-input v-model="password" placeholder="留空则自动生成" />
          </el-form-item>
        </el-form>



        <div class="selected-section">

          <div class="selected-title">

             已选 <strong>{{ selectedFiles.length }}</strong> 个文件          <button v-if="selectedFiles.length > 0" class="clear-btn" @click="clearSelection">清空</button>

          </div>

          <div class="selected-list" v-if="selectedFiles.length > 0">

            <div

              v-for="file in selectedFiles.slice(0, 30)"

              :key="file.id"

              class="selected-item"

            >

              <div class="selected-icon" :class="file.isDir ? 'dir' : 'file'">

                <FolderOpen v-if="file.isDir" :size="14" :stroke-width="1.5" />

                <File v-else :size="14" :stroke-width="1.5" />

              </div>

              <span class="selected-name">{{ file.name }}</span>

              <button class="selected-remove" @click="removeFile(file.id)">

                <X :size="12" />

              </button>

            </div>

            <p v-if="selectedFiles.length > 30" class="selected-more">

              还有 {{ selectedFiles.length - 30 }} 个文件...</p>

          </div>

          <div v-else class="selected-empty">

            <p>请从左侧选择文件</p>

          </div>

        </div>

      </div>

    </div>



    <!-- Submit bar -->

    <div class="submit-bar">

      <div class="submit-info">

        <template v-if="selectedFiles.length > 0 && selectedAccountId">

          <template v-if="shareMode === 'combined'">

            将 <strong>{{ selectedFiles.length }}</strong> 个文件合并为 <strong>1 个</strong>分享链接          </template>

          <template v-else>

            将为 <strong>{{ selectedFiles.length }}</strong> 个文件创建 <strong>{{ selectedFiles.length }} 个</strong>分享链接          </template>

          有效期 <strong>{{ expireDays }} 天</strong>

        </template>

      </div>

      <el-button

        type="primary"

        size="large"

        @click="onSubmit"

        :loading="submitting"

        :disabled="selectedFiles.length === 0 || !selectedAccountId"

      >

        <Share2 :size="16" style="margin-right: 6px" />
        创建分享
      </el-button>

    </div>

  </div>

</template>



<script setup lang="ts">

import { ref, computed, watch, onMounted } from 'vue'

import { ElMessage } from 'element-plus'

import {

  Share2, FolderOpen, File, ChevronRight, ArrowLeft, X,

} from 'lucide-vue-next'

import { electronApi } from '../api/ipc'

import { useAccountStore } from '../stores/account'

import type { FileItem } from '@shared/types'
import { formatFileSize } from '@shared/utils'



const accountStore = useAccountStore()



const platform = ref<'quark' | 'baidu' | 'uc' | 'xunlei'>('quark')

const selectedAccountId = ref('')

const submitting = ref(false)

const shareMode = ref<'combined' | 'separate'>('combined')

const expireDays = ref(0)

const password = ref('')



const filteredAccounts = computed(() =>

  accountStore.getAccountsByPlatform(platform.value),

)



const needsCookieHint = computed(() => {

  const acc = filteredAccounts.value.find((a) => a.id === selectedAccountId.value)

  if (!acc) return false

  // 百度 OAuth 登录不支持分享，需要 Cookie
  if (platform.value === 'baidu' && acc.loginType === 'oauth') return true

  return false

})



watch(platform, () => {

  selectedAccountId.value = ''

  files.value = []

  navStack.value = [{ id: '0', name: 'root' }]

  selectedFiles.value = []

})



watch(filteredAccounts, (accs) => {

  if (accs.length > 0 && !accs.find((a) => a.id === selectedAccountId.value)) {

    selectedAccountId.value = accs[0].id

  }

}, { immediate: true })



// ---- File browser ----



interface NavItem { id: string; name: string }



const navStack = ref<NavItem[]>([{ id: '0', name: 'root' }])

const files = ref<FileItem[]>([])

const loadingFiles = ref(false)



async function loadFiles(parentId: string) {

  const accId = selectedAccountId.value

  if (!accId) return



  loadingFiles.value = true

  try {

    const result = await electronApi.listFiles(accId, parentId)

    if (result.success) {

      // Sort: folders first, then files

      files.value = (result.files || []).sort((a: FileItem, b: FileItem) => {

        if (a.isDir && !b.isDir) return -1

        if (!a.isDir && b.isDir) return 1

        return a.name.localeCompare(b.name)

      })

    } else {

      ElMessage.error(result.error || '加载文件失败')

      files.value = []

    }

  } catch (err) {

    ElMessage.error('加载文件失败: ' + String(err))

    files.value = []

  } finally {

    loadingFiles.value = false

  }

}



function onEnterDir(file: FileItem) {

  navStack.value.push({ id: file.id, name: file.name })

  loadFiles(file.id)

}



function onBreadcrumbClick(index: number) {

  if (index === navStack.value.length - 1) return

  navStack.value.splice(index + 1)

  loadFiles(navStack.value[navStack.value.length - 1].id)

}



function onGoBack() {

  if (navStack.value.length > 1) {

    navStack.value.pop()

    loadFiles(navStack.value[navStack.value.length - 1].id)

  }

}



watch(selectedAccountId, (id) => {

  if (id) {

    navStack.value = [{ id: '0', name: 'root' }]

    loadFiles('0')

  } else {

    files.value = []

  }

})



// ---- File selection ----



const selectedFiles = ref<FileItem[]>([])



function isSelected(id: string): boolean {

  return selectedFiles.value.some((f) => f.id === id)

}



function onToggle(file: FileItem) {

  if (isSelected(file.id)) {

    selectedFiles.value = selectedFiles.value.filter((f) => f.id !== file.id)

  } else {

    selectedFiles.value.push(file)

  }

}



function removeFile(id: string) {

  selectedFiles.value = selectedFiles.value.filter((f) => f.id !== id)

}



function clearSelection() {

  selectedFiles.value = []

}





// ---- Submit ----



async function onSubmit() {

  if (!selectedAccountId.value) return

  if (selectedFiles.value.length === 0) return



  submitting.value = true

  try {

    const options: { expireDays?: number; password?: string } = {

      expireDays: expireDays.value,

    }

    if (password.value.trim()) {

      options.password = password.value.trim()

    }



    if (shareMode.value === 'combined') {

      // One share link for all files
      // 使用 JSON 序列化去除 Vue 响应式包装，避免 IPC 克隆失败
      const items = JSON.parse(JSON.stringify(selectedFiles.value.map((f) => ({

        fileId: f.id,

        name: f.name,

        isDir: f.isDir,

        raw: f.raw,

      }))))

      const result = await electronApi.batchShare(selectedAccountId.value, items, options)

      if (result.success) {

        ElMessage.success('分享任务已创建，请在任务日志中查看进度')

        selectedFiles.value = []

      } else {

        ElMessage.error(result.error || '创建分享失败')

      }

    } else {

      // One share link per file

      let successCount = 0

      let failCount = 0

      for (const file of selectedFiles.value) {

        const items = JSON.parse(JSON.stringify([{ fileId: file.id, name: file.name, isDir: file.isDir, raw: file.raw }]))

        const result = await electronApi.batchShare(selectedAccountId.value, items, options)

        if (result.success) {

          successCount++

        } else {

          failCount++

        }

      }

      if (failCount === 0) {

        ElMessage.success(`已创建 ${successCount} 个分享任务，请在任务日志中查看进度`)

      } else {

        ElMessage.warning(`创建完成：${successCount} 成功，${failCount} 失败`)

      }

      selectedFiles.value = []

    }

  } catch (err) {

    ElMessage.error('创建分享失败: ' + String(err))

  } finally {

    submitting.value = false

  }

}



onMounted(async () => {

  await accountStore.fetchAccounts()

  // Auto-select first account if none selected

  const accs = accountStore.getAccountsByPlatform(platform.value)

  if (accs.length > 0 && !selectedAccountId.value) {

    selectedAccountId.value = accs[0].id

    // Directly load files after setting account

    await loadFiles('0')

  }

})

</script>



<style scoped>

.batch-share {

  height: 100%;

  display: flex;

  flex-direction: column;

  gap: 16px;

}



/* ── Page header ── */

.page-header {

  display: flex;

  align-items: center;

  padding: 20px 24px;

  background: #ffffff;

  border-radius: 12px;

  border: 1px solid #e5e7eb;

}



.header-info {

  display: flex;

  align-items: center;

  gap: 12px;

}



.header-icon {

  width: 40px;

  height: 40px;

  border-radius: 10px;

  background: #f0fdf4;

  color: #22c55e;

  display: flex;

  align-items: center;

  justify-content: center;

}



.header-info h2 {

  font-size: 16px;

  font-weight: 700;

  color: #1f2937;

  margin-bottom: 2px;

}



.header-info p {

  font-size: 12px;

  color: #9ca3af;

}



/* ── Body ── */

.share-body {

  flex: 1;

  display: flex;

  gap: 16px;

  min-height: 0;

}



.panel {

  flex: 1;

  background: #ffffff;

  border-radius: 12px;

  border: 1px solid #e5e7eb;

  padding: 16px;

  display: flex;

  flex-direction: column;

  gap: 12px;

}



.panel-title {

  font-size: 13px;

  font-weight: 600;

  color: #374151;

}



/* ── Account bar ── */

.account-bar {

  display: flex;

  align-items: center;

  gap: 8px;

}



/* ── File browser ── */

.file-empty {

  flex: 1;

  display: flex;

  flex-direction: column;

  align-items: center;

  justify-content: center;

  gap: 8px;

  color: #d1d5db;

}

.file-empty p { font-size: 13px; color: #9ca3af; }



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



.file-list {

  flex: 1;

  min-height: 0;

  overflow-y: auto;

  border: 1px solid #e5e7eb;

  border-radius: 8px;

}



.file-empty-list {

  display: flex;

  flex-direction: column;

  align-items: center;

  gap: 6px;

  padding: 40px 0;

  color: #d1d5db;

}

.file-empty-list span { font-size: 13px; color: #9ca3af; }



.file-item {

  display: flex;

  align-items: center;

  gap: 8px;

  padding: 8px 12px;

  cursor: pointer;

  color: #374151;

  border-bottom: 1px solid #f3f4f6;

  transition: background 0.1s;

}

.file-item:last-child { border-bottom: none; }

.file-item:hover { background: #f9fafb; }

.file-item.selected { background: #eff6ff; }



.file-check { flex-shrink: 0; }



.file-icon {

  width: 28px;

  height: 28px;

  border-radius: 6px;

  display: flex;

  align-items: center;

  justify-content: center;

  flex-shrink: 0;

}

.file-icon.dir { background: #eff6ff; color: #3b82f6; }

.file-icon.file { background: #f3f4f6; color: #6b7280; }



.file-name {

  flex: 1;

  font-size: 13px;

  overflow: hidden;

  text-overflow: ellipsis;

  white-space: nowrap;

}



.file-size {

  font-size: 12px;

  color: #9ca3af;

  flex-shrink: 0;

  min-width: 48px;

  text-align: right;

}



.file-enter {

  width: 24px;

  height: 24px;

  display: flex;

  align-items: center;

  justify-content: center;

  border: none;

  background: transparent;

  border-radius: 4px;

  color: #9ca3af;

  cursor: pointer;

  flex-shrink: 0;

}

.file-enter:hover { background: #e5e7eb; color: #374151; }



/* ── Options panel ── */

.options-panel {

  max-width: 360px;

}



.selected-section {

  flex: 1;

  display: flex;

  flex-direction: column;

  gap: 8px;

  min-height: 0;

}



.selected-title {

  display: flex;

  align-items: center;

  gap: 8px;

  font-size: 13px;

  color: #6b7280;

}



.clear-btn {

  margin-left: auto;

  font-size: 12px;

  color: #ef4444;

  background: none;

  border: none;

  cursor: pointer;

  padding: 2px 6px;

  border-radius: 4px;

}

.clear-btn:hover { background: #fef2f2; }



.selected-list {

  flex: 1;

  min-height: 0;

  overflow-y: auto;

  border: 1px solid #e5e7eb;

  border-radius: 8px;

  padding: 4px;

}



.selected-item {

  display: flex;

  align-items: center;

  gap: 8px;

  padding: 6px 8px;

  border-radius: 4px;

  transition: background 0.1s;

}

.selected-item:hover { background: #f9fafb; }



.selected-icon {

  width: 22px;

  height: 22px;

  border-radius: 4px;

  display: flex;

  align-items: center;

  justify-content: center;

  flex-shrink: 0;

}

.selected-icon.dir { background: #eff6ff; color: #3b82f6; }

.selected-icon.file { background: #f3f4f6; color: #6b7280; }



.selected-name {

  flex: 1;

  font-size: 12px;

  overflow: hidden;

  text-overflow: ellipsis;

  white-space: nowrap;

}



.selected-remove {

  width: 20px;

  height: 20px;

  display: flex;

  align-items: center;

  justify-content: center;

  border: none;

  background: transparent;

  border-radius: 4px;

  color: #9ca3af;

  cursor: pointer;

  flex-shrink: 0;

}

.selected-remove:hover { background: #fef2f2; color: #ef4444; }



.selected-more {

  font-size: 12px;

  color: #9ca3af;

  text-align: center;

  padding: 4px;

}



.selected-empty {

  flex: 1;

  display: flex;

  align-items: center;

  justify-content: center;

  border: 1px dashed #e5e7eb;

  border-radius: 8px;

}

.selected-empty p {

  font-size: 13px;

  color: #9ca3af;

  text-align: center;

}



/* ── Submit bar ── */

.submit-bar {

  display: flex;

  align-items: center;

  justify-content: space-between;

  padding: 12px 20px;

  background: #ffffff;

  border-radius: 12px;

  border: 1px solid #e5e7eb;

}



.submit-info {

  font-size: 13px;

  color: #6b7280;

}

</style>

