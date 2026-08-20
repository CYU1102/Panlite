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

 <div class="workflow-steps" aria-label="批量分享流程">

 <div class="workflow-step" :class="{ complete: !!selectedAccountId, active: !!selectedAccountId && selectedFiles.length === 0 }">

 <span class="step-index">1</span>

 <span class="step-copy"><strong>选择账号</strong><small>{{ selectedAccountId ? '账号已就绪' : '选择分享来源' }}</small></span>

 </div>

 <span class="step-line" :class="{ complete: !!selectedAccountId }" />

 <div class="workflow-step" :class="{ complete: selectedFiles.length > 0, active: !!selectedAccountId && selectedFiles.length === 0 }">

 <span class="step-index">2</span>

 <span class="step-copy"><strong>挑选内容</strong><small>{{ selectedFiles.length ? `已选 ${selectedFiles.length} 项` : '选择文件或文件夹' }}</small></span>

 </div>

 <span class="step-line" :class="{ complete: selectedFiles.length > 0 }" />

 <div class="workflow-step" :class="{ active: selectedFiles.length > 0 }">

 <span class="step-index">3</span>

 <span class="step-copy"><strong>确认分享</strong><small>设置有效期并创建</small></span>

 </div>

 </div>

 <div class="share-body">

 <!-- Left: file picker -->

 <div class="panel file-panel">

 <div class="panel-heading">

 <div class="panel-step">01</div>

 <div><div class="panel-title">选择来源与文件</div><p class="panel-hint">切换账号后，在目录中勾选需要分享的内容</p></div>

 <span v-if="selectedFiles.length" class="selection-count">{{ selectedFiles.length }} 项已选</span>

 </div>

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

 <span class="empty-icon"><FolderOpen :size="28" :stroke-width="1.4" /></span>

 <strong>先选择一个网盘账号</strong>

 <p>选择后即可浏览并勾选需要分享的文件</p>

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

 <div class="panel-heading">

 <div class="panel-step">02</div>

 <div><div class="panel-title">分享设置</div><p class="panel-hint">配置链接形式、有效期与提取码</p></div>

 </div>



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

             <span>待分享内容</span><span class="selected-count"><strong>{{ selectedFiles.length }}</strong> 项</span><button v-if="selectedFiles.length > 0" class="clear-btn" @click="clearSelection">清空</button>

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

            <span class="empty-icon compact"><File :size="20" :stroke-width="1.4" /></span>

            <strong>还没有选择内容</strong>

            <p>点击左侧文件行即可添加到这里</p>

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

        <template v-else>

          <span class="submit-state-dot" />

          {{ !selectedAccountId ? '请选择网盘账号以开始' : '请至少选择一个文件或文件夹' }}

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

import { ElMessage } from 'element-plus/es/components/message/index.mjs'

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

/* Shared light workflow surfaces */
.batch-share { gap: var(--pl-space-4); }
.page-header, .panel, .submit-bar { border-color: var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }
.page-header { padding: var(--pl-space-5) var(--pl-space-6); }
.header-icon { background: var(--pl-primary-soft); color: var(--pl-primary); border-radius: var(--pl-radius-control); }
.header-info h2, .panel-title, .file-item, .selected-name { color: var(--pl-text); }
.header-info p, .selected-title, .submit-info { color: var(--pl-text-secondary); }
.share-body { gap: var(--pl-space-4); }
.panel { padding: var(--pl-space-5); gap: var(--pl-space-3); }
.folder-nav { background: var(--pl-surface-subtle); border-color: var(--pl-border); border-radius: var(--pl-radius-control); }
.crumb { color: var(--pl-text-secondary); }
.crumb:hover { background: var(--pl-primary-soft); color: var(--pl-primary); }
.crumb.active { color: var(--pl-text); }
.nav-btn { background: var(--pl-primary-soft); color: var(--pl-primary); border-radius: var(--pl-radius-sm); }
.nav-btn:hover:not(:disabled) { background: #d8e7ff; color: var(--pl-primary-hover); }
.file-list, .selected-list { border-color: var(--pl-border); border-radius: var(--pl-radius-control); }
.file-item { border-bottom-color: var(--pl-surface-subtle); }
.file-item:hover, .selected-item:hover { background: var(--pl-surface-subtle); }
.file-item.selected { background: var(--pl-primary-soft); }
.file-icon.dir, .selected-icon.dir { background: var(--pl-primary-soft); color: var(--pl-primary); }
.file-icon.file, .selected-icon.file { background: var(--pl-surface-subtle); color: var(--pl-text-secondary); }
.file-enter:hover { background: var(--pl-primary-soft); color: var(--pl-primary); }
.options-panel { max-width: 380px; }
.selected-list { background: var(--pl-surface-subtle); }
.selected-empty { border-color: var(--pl-border-strong); }
.clear-btn, .selected-remove:hover { color: var(--pl-danger); }
.clear-btn:hover, .selected-remove:hover { background: var(--pl-danger-soft); }
.submit-bar { padding: var(--pl-space-3) var(--pl-space-5); }
@media (max-width: 900px) { .share-body { flex-direction: column; overflow-y: auto; } .options-panel { max-width: none; min-height: 280px; } .file-panel { min-height: 380px; } }
@media (max-width: 560px) {
  .page-header, .panel { padding: var(--pl-space-4); }
  .account-bar { flex-wrap: wrap; }
  .account-bar .el-select:last-child { min-width: 180px; }
  .submit-bar { align-items: stretch; flex-direction: column; gap: var(--pl-space-3); }
  .submit-bar .el-button { width: 100%; }
}

/* Workflow hierarchy and interaction */
.workflow-steps {
  display: grid;
  grid-template-columns: max-content minmax(32px, 1fr) max-content minmax(32px, 1fr) max-content;
  align-items: center;
  gap: var(--pl-space-3);
  padding: var(--pl-space-3) var(--pl-space-5);
  background: var(--pl-surface);
  border: 1px solid var(--pl-border);
  border-radius: var(--pl-radius-card);
  box-shadow: var(--pl-shadow-card);
}

.workflow-step {
  display: flex;
  align-items: center;
  gap: var(--pl-space-2);
  min-width: 0;
  color: var(--pl-text-muted);
  transition: color 180ms ease, transform 180ms ease;
}

.workflow-step.active { color: var(--pl-primary); transform: translateY(-1px); }
.workflow-step.complete { color: var(--pl-success); }

.step-index {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border: 1px solid var(--pl-border-strong);
  border-radius: 50%;
  background: var(--pl-surface-subtle);
  font-size: 12px;
  font-weight: 700;
  transition: all 180ms ease;
}

.workflow-step.active .step-index { color: var(--pl-primary); background: var(--pl-primary-soft); border-color: var(--pl-primary); box-shadow: 0 0 0 4px var(--pl-primary-soft); }
.workflow-step.complete .step-index { color: var(--pl-success); background: var(--pl-success-soft); border-color: var(--pl-success); }

.step-copy { display: flex; flex-direction: column; line-height: 1.25; }
.step-copy strong { color: var(--pl-text); font-size: 12px; font-weight: 650; white-space: nowrap; }
.step-copy small { margin-top: 2px; font-size: 10px; color: currentColor; white-space: nowrap; }

.step-line { height: 1px; min-width: 24px; background: var(--pl-border); transition: background 180ms ease; }
.step-line.complete { background: var(--pl-success); }

.panel { overflow: hidden; transition: border-color 180ms ease, box-shadow 180ms ease; }
.panel:hover { border-color: var(--pl-border-strong); box-shadow: var(--pl-shadow-float); }

.panel-heading { display: flex; align-items: center; gap: var(--pl-space-3); min-height: 36px; }
.panel-heading > div:nth-child(2) { min-width: 0; }
.panel-step { width: 34px; height: 34px; display: grid; place-items: center; flex: 0 0 auto; border-radius: var(--pl-radius-sm); color: var(--pl-primary); background: var(--pl-primary-soft); font-size: 11px; font-weight: 750; letter-spacing: .04em; }
.panel-title { font-size: 14px; font-weight: 700; }
.panel-hint { margin-top: 2px; color: var(--pl-text-muted); font-size: 11px; line-height: 1.35; }
.selection-count { margin-left: auto; padding: 4px 9px; border-radius: 999px; background: var(--pl-success-soft); color: var(--pl-success); font-size: 11px; font-weight: 650; white-space: nowrap; }

.account-bar { padding: var(--pl-space-2); border-radius: var(--pl-radius-control); background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); }
.file-list { background: var(--pl-surface); }
.file-item { position: relative; min-height: 46px; transition: background 150ms ease, padding 150ms ease, box-shadow 150ms ease; }
.file-item:hover { padding-left: 15px; background: var(--pl-primary-soft); }
.file-item.selected { background: var(--pl-primary-soft); box-shadow: inset 3px 0 0 var(--pl-primary); }
.file-item.selected .file-name { color: var(--pl-primary-hover); font-weight: 600; }
.file-enter, .selected-remove { opacity: .55; transition: opacity 150ms ease, background 150ms ease, color 150ms ease, transform 150ms ease; }
.file-item:hover .file-enter, .selected-item:hover .selected-remove { opacity: 1; }
.file-enter:hover, .selected-remove:hover { transform: scale(1.08); }

.file-empty, .selected-empty { flex-direction: column; gap: var(--pl-space-2); text-align: center; color: var(--pl-text-muted); }
.file-empty strong, .selected-empty strong { color: var(--pl-text-secondary); font-size: 13px; }
.empty-icon { width: 52px; height: 52px; display: grid; place-items: center; border-radius: 16px; color: var(--pl-primary); background: var(--pl-primary-soft); }
.empty-icon.compact { width: 40px; height: 40px; border-radius: var(--pl-radius-control); }

.options-panel :deep(.el-form) { padding: var(--pl-space-3); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-control); background: var(--pl-surface-subtle); }
.options-panel :deep(.el-form-item:last-child) { margin-bottom: 0; }
.selected-title { min-height: 28px; }
.selected-count { padding: 2px 8px; border-radius: 999px; background: var(--pl-primary-soft); color: var(--pl-primary); font-size: 11px; }
.selected-item { min-height: 36px; transition: background 150ms ease, transform 150ms ease; }
.selected-item:hover { background: var(--pl-surface); transform: translateX(2px); }

.submit-bar { min-height: 64px; border-color: var(--pl-border-strong); box-shadow: var(--pl-shadow-float); }
.submit-info { display: flex; align-items: center; gap: var(--pl-space-2); min-width: 0; }
.submit-info strong { color: var(--pl-primary); }
.submit-state-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--pl-warning); box-shadow: 0 0 0 4px var(--pl-warning-soft); }
.submit-bar :deep(.el-button) { min-width: 132px; box-shadow: 0 6px 16px rgba(52, 120, 246, .18); transition: transform 150ms ease, box-shadow 150ms ease; }
.submit-bar :deep(.el-button:not(.is-disabled):hover) { transform: translateY(-1px); box-shadow: 0 8px 20px rgba(52, 120, 246, .24); }
.submit-bar :deep(.el-button.is-disabled) { box-shadow: none; }

@media (max-width: 760px) {
  .workflow-steps { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--pl-space-2); }
  .step-line { display: none; }
  .step-copy small { display: none; }
  .workflow-step { justify-content: center; }
}

@media (max-width: 560px) {
  .workflow-steps { padding: var(--pl-space-3); }
  .step-copy strong { font-size: 11px; }
  .panel-heading { align-items: flex-start; }
  .panel-hint { display: none; }
  .selection-count { align-self: center; }
}
</style>

