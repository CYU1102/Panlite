<template>
  <section class="subscription-panel" aria-label="订阅追更">
    <div class="subscription-heading">
      <div><strong>订阅追更</strong><p>定期检查分享内容，把新增文件保存到所选目录。</p></div>
      <el-button size="small" :loading="loading" @click="load">刷新</el-button>
    </div>
    <div class="subscription-options">
      <label>检查范围
        <el-select v-model="draft.scope" aria-label="检查范围" size="small">
          <el-option label="分享根目录" value="root" />
          <el-option label="包含所有子目录" value="recursive" :disabled="!recursiveSupported" />
        </el-select>
      </label>
      <label>首次检查
        <el-select v-model="draft.initialMode" aria-label="首次检查" size="small">
          <el-option label="只建立基线，从下一次追更" value="baseline" />
          <el-option label="同时转存已有匹配内容" value="save_existing" />
        </el-select>
      </label>
      <label>包含关键词（任一匹配）<el-input v-model="draft.include" aria-label="包含关键词" size="small" placeholder="可选，用逗号分隔" /></label>
      <label>排除关键词<el-input v-model="draft.exclude" aria-label="排除关键词" size="small" placeholder="可选，用逗号分隔" /></label>
      <label>文件扩展名<el-input v-model="draft.extensions" aria-label="文件扩展名" size="small" placeholder="例如 mp4,mkv,srt" /></label>
      <label>订阅名称<el-input v-model="draft.title" aria-label="订阅名称" size="small" placeholder="可选，留空使用分享链接" /></label>
    </div>
    <div class="subscription-switches">
      <el-checkbox v-model="draft.preserveStructure" :disabled="draft.scope !== 'recursive'">保留子目录结构</el-checkbox>
      <el-checkbox v-model="draft.detectChanges">追踪可验证的内容变化</el-checkbox>
    </div>
    <p class="subscription-explanation">
      {{ recursiveSupported ? '递归模式可发现已有文件夹内的新增内容。' : '此平台目前只支持根目录；已有文件夹内的变化无法检测。' }}
      {{ draft.scope === 'root' ? '筛选仅作用于根目录条目；扩展名筛选不会选中文件夹。' : '筛选匹配相对路径；扩展名筛选只选择文件。' }}
      <template v-if="draft.detectChanges">内容变化依据文件大小或平台提供的完整摘要；相同大小且无摘要的变化无法判断。转存保留新副本。</template>
    </p>
    <div v-if="editing" class="subscription-edit">
      <label>分享链接<el-input v-model="draft.url" aria-label="分享链接" size="small" /></label>
      <label>提取码<el-input v-model="draft.password" aria-label="提取码" size="small" /></label>
      <p>正在编辑 {{ editing.title || editing.url }}。保存后按首次检查选项重新建立基线。</p>
      <el-checkbox v-model="useCurrentTarget" :disabled="!accountId">改用当前所选账号与目录</el-checkbox>
    </div>
    <div class="subscription-controls">
      <span>目标：{{ targetLabel }}</span>
      <el-button v-if="editing" size="small" @click="cancelEdit">取消编辑</el-button>
      <el-button size="small" :loading="saving" :disabled="!canSave" @click="save">
        {{ editing ? '保存订阅配置' : '把当前链接加入订阅' }}
      </el-button>
    </div>
    <div v-if="subscriptions.length" class="subscription-list">
      <article v-for="item in subscriptions" :key="item.id" class="subscription-row">
        <div class="subscription-row-info">
          <strong>{{ item.title || item.url }}</strong>
          <small>{{ platformName(item.platform) }} · {{ item.scope === 'recursive' ? '递归检查' : '根目录' }} · 目标 {{ item.targetDirPath || '/' }}</small>
          <small>{{ statusLabel(item) }}<template v-if="item.lastCheckedAt"> · 最近检查 {{ timestamp(item.lastCheckedAt) }}</template><template v-if="item.nextCheckAt && item.nextCheckAt < 8640000000000000 && item.status === 'active'"> · 下次 {{ timestamp(item.nextCheckAt) }}</template></small>
          <p v-if="item.lastError" class="subscription-error" role="status">{{ item.lastError }}</p>
          <router-link v-if="item.taskId" :to="{ path: '/tasks', query: { taskId: item.taskId } }">查看关联任务</router-link>
        </div>
        <div class="subscription-row-actions">
          <el-button size="small" text @click="edit(item)">编辑</el-button>
          <el-button size="small" text @click="toggle(item)">{{ item.status === 'active' ? '暂停' : '恢复' }}</el-button>
          <el-button size="small" text :disabled="item.status !== 'active'" :loading="runningId === item.id" @click="run(item)">立即检查</el-button>
          <el-button size="small" text type="danger" @click="remove(item)">删除</el-button>
        </div>
      </article>
    </div>
    <p v-else class="subscription-explanation">还没有订阅；粘贴分享链接并选择目标目录后即可追更。</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { electronApi } from '../api/ipc'
import { supportsRecursiveSubscriptions, type ShareSubscription, type ShareSubscriptionInput } from '@shared/subscription-types'

const props = defineProps<{ accountId: string; platform: string; links: Array<{ url: string; password?: string }>; targetDirId: string; targetDirPath: string }>()
const subscriptions = ref<ShareSubscription[]>([])
const loading = ref(false)
const saving = ref(false)
const runningId = ref('')
const editing = ref<ShareSubscription | null>(null)
const useCurrentTarget = ref(false)
const draft = reactive({ title: '', url: '', password: '', scope: 'root' as 'root' | 'recursive', initialMode: 'baseline' as 'baseline' | 'save_existing',
  include: '', exclude: '', extensions: '', preserveStructure: true, detectChanges: false })
const selectedPlatform = computed(() => editing.value && !useCurrentTarget.value ? editing.value.platform : props.platform)
const recursiveSupported = computed(() => supportsRecursiveSubscriptions(selectedPlatform.value))
const targetLabel = computed(() => editing.value && !useCurrentTarget.value ? editing.value.targetDirPath || '/' : props.targetDirPath || '/')
const canSave = computed(() => editing.value ? Boolean(draft.url && (!useCurrentTarget.value || props.accountId)) : Boolean(props.accountId && props.links.length))
watch(recursiveSupported, value => { if (!value) draft.scope = 'root' })
const terms = (value: string) => value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean)
const timestamp = (value: number) => new Date(value).toLocaleString()
const platformName = (value: string) => ({ quark: '夸克', uc: 'UC', baidu: '百度', xunlei: '迅雷', aliyun_web: '阿里云盘·网页版' }[value] || value)
const statusLabel = (item: ShareSubscription) => item.status === 'paused' ? '已暂停' : item.activeRunId ? '正在同步或等待任务' : item.lastError ? '检查失败，等待重试或处理' : item.baselineComplete ? '追更中' : '等待首次检查'

async function load() {
  if (loading.value) return
  loading.value = true
  try {
    const result = await electronApi.subscriptionList()
    if (!result.success) throw new Error(result.error || '加载订阅失败')
    subscriptions.value = (result.subscriptions || []) as unknown as ShareSubscription[]
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)) }
  finally { loading.value = false }
}
function edit(item: ShareSubscription) {
  editing.value = item; useCurrentTarget.value = false
  Object.assign(draft, { title: item.title || '', url: item.url, password: item.password || '', scope: item.scope || 'root', initialMode: item.initialMode || 'baseline',
    include: (item.includeKeywords || []).join(','), exclude: (item.excludeKeywords || []).join(','), extensions: (item.extensions || []).join(','),
    preserveStructure: item.preserveStructure !== false, detectChanges: item.detectChanges === true })
}
function cancelEdit() { editing.value = null; useCurrentTarget.value = false; draft.url = ''; draft.password = ''; if (!recursiveSupported.value) draft.scope = 'root' }
async function save() {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    const previous = editing.value
    const usePrevious = previous && !useCurrentTarget.value
    const links = previous ? [{ url: draft.url, password: draft.password }] : props.links
    for (const link of links) {
      const input: ShareSubscriptionInput = {
        id: previous?.id, expectedVersion: previous?.configVersion, accountId: usePrevious ? previous.accountId : props.accountId,
        platform: selectedPlatform.value, url: link.url, password: link.password || undefined, title: draft.title || link.url,
        targetDirId: usePrevious ? previous.targetDirId : props.targetDirId || '0', targetDirPath: targetLabel.value,
        scope: draft.scope, initialMode: draft.initialMode, includeKeywords: terms(draft.include), excludeKeywords: terms(draft.exclude), extensions: terms(draft.extensions),
        preserveStructure: draft.preserveStructure, detectChanges: draft.detectChanges,
      }
      const result = await electronApi.subscriptionAdd(input)
      if (!result.success) throw new Error(result.error || '保存订阅失败')
    }
    ElMessage.success(previous ? '订阅配置已更新' : `已添加 ${links.length} 条订阅`)
    cancelEdit(); await load()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); await load() }
  finally { saving.value = false }
}
async function toggle(item: ShareSubscription) {
  try {
    const result = await electronApi.subscriptionToggle({ id: item.id, active: item.status !== 'active' })
    if (!result.success) throw new Error(result.error || '操作失败')
    await load()
  } catch (error) { ElMessage.error(String(error)) }
}
async function run(item: ShareSubscription) {
  runningId.value = item.id
  try {
    const result = await electronApi.subscriptionRunNow(item.id)
    if (!result.success) throw new Error(result.error || '检查失败')
    await load()
    const updated = subscriptions.value.find(row => row.id === item.id)
    if (updated?.lastError) ElMessage.warning(updated.lastError)
    else ElMessage.success('检查完成；新增内容会进入转存队列')
  } catch (error) { ElMessage.error(String(error)) }
  finally { runningId.value = '' }
}
async function remove(item: ShareSubscription) {
  try {
    const result = await electronApi.subscriptionRemove(item.id)
    if (!result.success) throw new Error(result.error || '删除失败')
    if (editing.value?.id === item.id) cancelEdit()
    await load()
  } catch (error) { ElMessage.error(String(error)) }
}
let refresh: ReturnType<typeof setInterval> | undefined
onMounted(() => { void load(); refresh = setInterval(() => { void load() }, 15000) })
onUnmounted(() => { if (refresh) clearInterval(refresh) })
</script>

<style scoped>
.subscription-panel { margin-top: 20px; padding: 18px; border: 1px solid var(--pl-border); border-radius: 12px; background: var(--pl-surface); }
.subscription-heading, .subscription-controls, .subscription-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.subscription-heading p, .subscription-explanation, .subscription-edit p { margin: 5px 0 12px; color: var(--pl-text-muted); font-size: 12px; line-height: 1.6; }
.subscription-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.subscription-options label, .subscription-edit label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
.subscription-switches { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 8px; }
.subscription-controls { justify-content: flex-end; margin-top: 10px; font-size: 12px; }
.subscription-controls span { flex: 1; overflow-wrap: anywhere; }
.subscription-list { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.subscription-row { align-items: flex-start; padding-top: 12px; border-top: 1px solid var(--pl-border); }
.subscription-row-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
.subscription-row-info small { color: var(--pl-text-muted); }
.subscription-row-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; flex-shrink: 0; gap: 0; }
.subscription-error { color: var(--el-color-danger); margin: 0; }
.subscription-edit { display: grid; grid-template-columns: 2fr 1fr; gap: 10px; margin-top: 12px; }
.subscription-edit p { grid-column: 1 / -1; margin-bottom: 0; }
@media (max-width: 880px) { .subscription-options { grid-template-columns: 1fr; } .subscription-row { flex-direction: column; } .subscription-row-actions { justify-content: flex-start; } }
</style>
