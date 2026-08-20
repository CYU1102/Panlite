<template>
  <el-dialog
    title="批量转存"
    :model-value="modelValue"
    width="560px"
    class="transfer-dialog"
    @close="emit('update:modelValue', false)"
  >
    <div class="transfer-content">
      <div class="workflow-strip" aria-label="转存步骤">
        <div v-for="(step, index) in ['选择账号', '添加链接', '确认目录']" :key="step" class="workflow-step" :class="{ active: transferStep === index + 1, done: transferStep > index + 1 }" :aria-current="transferStep === index + 1 ? 'step' : undefined">
          <span>{{ transferStep > index + 1 ? '✓' : index + 1 }}</span>
          <strong>{{ step }}</strong>
        </div>
      </div>
      <el-alert
        v-if="needsCookieHint"
        title="百度转存需要 Cookie 认证（BDUSS）"
        description="当前账号使用 OAuth 登录，不支持转存功能。请使用 Cookie 方式重新登录百度账号。"
        type="warning"
        :closable="false"
        show-icon
      />

      <el-form label-position="top" class="transfer-form">
        <el-form-item label="目标账号">
          <el-select
            v-model="selectedAccountId"
            placeholder="请选择要转存到的账号"
            filterable
            style="width: 100%"
            @change="onTargetAccountChange"
          >
            <el-option
              v-for="account in accountStore.accounts"
              :key="account.id"
              :label="`${account.nickname}（${platformNames[account.platform] || account.platform}）`"
              :value="account.id"
            />
          </el-select>
          <p v-if="accountStore.accounts.length === 0" class="hint warning-hint">
            暂无可用账号，请先在顶部添加账号
          </p>
        </el-form-item>

        <el-form-item label="分享链接">
          <div class="links-area">
            <el-input
              v-model="bulkText"
              type="textarea"
              :rows="5"
              placeholder="每行一个分享链接，支持格式：&#10;https://pan.quark.cn/s/xxxxx&#10;https://pan.baidu.com/s/xxxxx?pwd=abcd&#10;https://drive.uc.cn/s/xxxxx&#10;https://pan.xunlei.com/s/xxxxx"
              @input="onBulkInput"
            />
            <div class="link-stats" v-if="parsedLinks.length > 0">
              <span class="stat-valid">
                <CheckCircle2 :size="12" />
                {{ validLinks.length }} 个有效链接
              </span>
              <span v-if="duplicateCount > 0" class="stat-dup">
                <AlertTriangle :size="12" />
                {{ duplicateCount }} 个重复
              </span>
              <span v-if="invalidCount > 0" class="stat-invalid">
                <XCircle :size="12" />
                {{ invalidCount }} 个无效
              </span>
            </div>
          </div>
        </el-form-item>

        <el-form-item label="统一提取码">
          <el-input
            v-model="unifiedPassword"
            placeholder="留空则使用链接中自带的提取码"
            maxlength="8"
            clearable
          />
          <p class="hint">填写后将覆盖所有链接的提取码</p>
        </el-form-item>

        <el-form-item label="目标目录">
          <div class="directory-picker">
            <el-input :model-value="targetDirName" readonly />
            <el-button @click="showDirectoryTree = !showDirectoryTree">
              {{ showDirectoryTree ? '收起' : '选择目录' }}
            </el-button>
          </div>
          <div v-if="showDirectoryTree" class="directory-tree">
            <el-tree
              :key="selectedAccountId"
              :data="directoryTreeData"
              :props="{ label: 'name', children: 'children', isLeaf: 'isLeaf' }"
              node-key="id"
              lazy
              highlight-current
              :load="loadDirectoryNode"
              :expand-on-click-node="false"
              @current-change="onDirectorySelect"
            />
          </div>
          <p class="hint selected-target"><FolderCheck :size="12" />转存文件将保存到“{{ targetDirName }}”</p>
        </el-form-item>

        <el-form-item label="高级选项">
          <el-checkbox v-model="autoShare">转存后自动分享</el-checkbox>
          <el-checkbox v-model="verifyFirst">转存前检测链接</el-checkbox>
        </el-form-item>
      </el-form>

      <!-- Parsed link preview -->
      <div v-if="parsedLinks.length > 0" class="preview-list">
        <div
          v-for="(link, i) in parsedLinks.slice(0, 8)"
          :key="i"
          class="preview-item"
          :class="{ invalid: !link.valid, dup: link.isDuplicate }"
        >
          <span class="preview-platform">{{ link.platform }}</span>
          <span class="preview-url">{{ link.url }}</span>
          <span v-if="link.password" class="preview-pwd">提取码: {{ link.password }}</span>
          <span v-if="link.isDuplicate" class="preview-tag dup">重复</span>
          <span v-if="!link.valid" class="preview-tag invalid">无效</span>
        </div>
        <p v-if="parsedLinks.length > 8" class="preview-more">...还有 {{ parsedLinks.length - 8 }} 个链接</p>
      </div>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button
        type="primary"
        @click="onConfirm"
        :loading="loading"
        :disabled="validLinks.length === 0 || !selectedAccountId"
      >
        开始转存 ({{ validLinks.length }})
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { CheckCircle2, AlertTriangle, XCircle, FolderCheck } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'
import { useAppStore } from '../stores/app'
import { useAccountStore } from '../stores/account'
import type { FileItem, TransferLinkInput } from '@shared/types'

const props = defineProps<{
  modelValue: boolean
  initialLinks?: TransferLinkInput[]
  initialTargetDirId?: string
  initialTargetPath?: string
  initialTargetName?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const appStore = useAppStore()
const accountStore = useAccountStore()
const loading = ref(false)
const bulkText = ref('')
const selectedAccountId = ref('')
const unifiedPassword = ref('')
const targetPath = ref('')
const targetDirId = ref('0')
const targetDirName = ref('根目录')
const showDirectoryTree = ref(false)
const autoShare = ref(false)
const verifyFirst = ref(false)

const transferStep = computed(() => {
  if (!selectedAccountId.value) return 1
  if (validLinks.value.length === 0) return 2
  return 3
})

const needsCookieHint = computed(() => {
  const acc = accountStore.accounts.find((account) => account.id === selectedAccountId.value)
  return acc?.platform === 'baidu' && acc?.loginType === 'oauth'
})

const platformNames: Record<string, string> = {
  quark: '夸克',
  baidu: '百度',
  uc: 'UC',
  xunlei: '迅雷',
}

interface DirectoryNode {
  id: string
  name: string
  path?: string
  children?: DirectoryNode[]
  isLeaf?: boolean
}

const directoryTreeData: DirectoryNode[] = [{
  id: '0',
  name: '根目录',
  children: [],
  isLeaf: false,
}]

watch(() => props.modelValue, async (visible) => {
  if (!visible) return

  if (accountStore.accounts.length === 0) {
    await accountStore.fetchAccounts()
  }

  selectedAccountId.value = appStore.currentAccount?.id
    || accountStore.accounts[0]?.id
    || ''
  targetDirId.value = props.initialTargetDirId || '0'
  targetPath.value = props.initialTargetPath || ''
  targetDirName.value = props.initialTargetName || '根目录'
  showDirectoryTree.value = false

  if (props.initialLinks?.length) {
    bulkText.value = props.initialLinks
      .map((link) => `${link.url}${link.password ? ` 提取码: ${link.password}` : ''}`)
      .join('\n')
  }
}, { immediate: true })

function onTargetAccountChange(accountId: string) {
  const isCurrentAccount = accountId === appStore.currentAccount?.id
  targetDirId.value = isCurrentAccount ? (props.initialTargetDirId || '0') : '0'
  targetPath.value = isCurrentAccount ? (props.initialTargetPath || '') : ''
  targetDirName.value = isCurrentAccount ? (props.initialTargetName || '根目录') : '根目录'
}

async function loadDirectoryNode(
  node: { data: DirectoryNode },
  resolve: (data: DirectoryNode[]) => void,
) {
  if (!selectedAccountId.value) {
    resolve([])
    return
  }

  try {
    const result = await electronApi.listFiles(selectedAccountId.value, node.data.id)
    if (!result.success) {
      resolve([])
      return
    }

    resolve(result.files
      .filter((file: FileItem) => file.isDir)
      .map((file: FileItem) => ({
        id: file.id,
        name: file.name,
        path: file.path,
        children: [],
        isLeaf: false,
      })))
  } catch {
    resolve([])
  }
}

function onDirectorySelect(node: DirectoryNode) {
  targetDirId.value = node.id
  targetDirName.value = node.name
  targetPath.value = node.path || ''
}

interface ParsedLink {
  url: string
  password: string | null
  platform: string
  valid: boolean
  isDuplicate: boolean
}

function parseLink(line: string): ParsedLink | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // Try to extract URL and password from the line
  let url = ''
  let pwd: string | null = null

  // Match URL — 支持所有5个平台
  const urlMatch = trimmed.match(/(https?:\/\/pan\.quark\.cn\/\S+)/)
    || trimmed.match(/(https?:\/\/pan\.baidu\.com\/\S+)/)
    || trimmed.match(/(https?:\/\/drive\.uc\.cn\/\S+)/)
    || trimmed.match(/(https?:\/\/pan\.xunlei\.com\/\S+)/)
  if (!urlMatch) return { url: trimmed, password: null, platform: 'unknown', valid: false, isDuplicate: false }
  url = urlMatch[1]

  // 升级百度旧链接格式 share/init?surl= → s/1
  url = url.replace(/share\/init\?surl=/, 's/1')

  // Extract pwd from URL query param
  const pwdParamMatch = url.match(/[?&]pwd=([a-zA-Z0-9]{4})/)
  if (pwdParamMatch) pwd = pwdParamMatch[1]

  // Extract pwd from text after URL (e.g., "提取码: abcd" or "密码: abcd")
  if (!pwd) {
    const afterUrl = trimmed.substring(trimmed.indexOf(url) + url.length).trim()
    const pwdTextMatch = afterUrl.match(/(?:提取码|密码|pwd)[:\s：]*([a-zA-Z0-9]{4})/i)
    if (pwdTextMatch) pwd = pwdTextMatch[1]
  }
  // 处理空格分隔的提取码（如 "https://... uftv"）
  if (!pwd) {
    const afterUrl = trimmed.substring(trimmed.indexOf(url) + url.length).trim()
    const spacePwdMatch = afterUrl.match(/^([a-zA-Z0-9]{4})$/)
    if (spacePwdMatch) pwd = spacePwdMatch[1]
  }

  // Detect platform
  let platform = 'unknown'
  if (url.includes('pan.quark.cn')) platform = 'quark'
  else if (url.includes('pan.baidu.com')) platform = 'baidu'
  else if (url.includes('drive.uc.cn')) platform = 'uc'
  else if (url.includes('pan.xunlei.com')) platform = 'xunlei'

  const valid = platform !== 'unknown'
  return { url, password: pwd, platform, valid, isDuplicate: false }
}

const parsedLinks = computed<ParsedLink[]>(() => {
  const lines = bulkText.value.split('\n')
  const seen = new Set<string>()
  const result: ParsedLink[] = []

  for (const line of lines) {
    const parsed = parseLink(line)
    if (!parsed) continue
    const key = parsed.url.toLowerCase()
    if (seen.has(key)) {
      parsed.isDuplicate = true
    } else {
      seen.add(key)
    }
    result.push(parsed)
  }
  return result
})

const validLinks = computed(() =>
  parsedLinks.value.filter((l) => l.valid && !l.isDuplicate),
)

const duplicateCount = computed(() =>
  parsedLinks.value.filter((l) => l.isDuplicate).length,
)

const invalidCount = computed(() =>
  parsedLinks.value.filter((l) => !l.valid).length,
)

function onBulkInput() {
  // Auto-triggered by textarea
}

async function onConfirm() {
  if (!selectedAccountId.value) {
    ElMessage.warning('请先选择目标账号')
    return
  }

  const links = validLinks.value.map((l) => ({
    url: l.url,
    password: unifiedPassword.value.trim() || l.password || undefined,
  }))

  if (links.length === 0) {
    ElMessage.warning('请至少输入一个有效的分享链接')
    return
  }

  loading.value = true
  try {
    const result = await electronApi.batchTransfer(
      selectedAccountId.value,
      links,
      targetDirId.value,
      targetPath.value.trim() || undefined,
      { autoShare: autoShare.value },
    )
    if (result.success) {
      ElMessage.success(`已创建转存任务（${links.length} 个链接），请在任务日志中查看进度`)
      emit('update:modelValue', false)
      emit('success')
      bulkText.value = ''
      unifiedPassword.value = ''
      targetPath.value = ''
      targetDirId.value = '0'
      targetDirName.value = '根目录'
    } else {
      ElMessage.error(result.error || '创建转存任务失败')
    }
  } catch (err) {
    ElMessage.error('创建转存任务失败: ' + String(err))
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.transfer-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.links-area {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.link-stats {
  display: flex;
  gap: 12px;
  font-size: 12px;
}

.stat-valid {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #22c55e;
}

.stat-dup {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #f59e0b;
}

.stat-invalid {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #ef4444;
}

.hint {
  font-size: 11px;
  color: #9ca3af;
  margin-top: 4px;
}

.warning-hint {
  color: #e6a23c;
}

.directory-picker {
  display: flex;
  gap: 8px;
  width: 100%;
}

.directory-tree {
  width: 100%;
  max-height: 220px;
  overflow-y: auto;
  margin-top: 8px;
  padding: 8px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}

.preview-list {
  background: #f9fafb;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preview-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #374151;
  padding: 4px 8px;
  border-radius: 4px;
  background: #ffffff;
}

.preview-item.invalid {
  background: #fef2f2;
  color: #ef4444;
}

.preview-item.dup {
  background: #fffbeb;
  color: #92400e;
}

.preview-platform {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  background: #eff6ff;
  color: #3b82f6;
  flex-shrink: 0;
}

.preview-url {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-pwd {
  font-size: 11px;
  color: #6b7280;
  flex-shrink: 0;
}

.preview-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
}

.preview-tag.dup {
  background: #fef3c7;
  color: #92400e;
}

.preview-tag.invalid {
  background: #fecaca;
  color: #991b1b;
}

.preview-more {
  font-size: 12px;
  color: #9ca3af;
  text-align: center;
}
.workflow-strip {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 10px;
  background: var(--pl-surface-subtle);
  border: 1px solid var(--pl-border);
  border-radius: 12px;
}
.workflow-step { display: flex; align-items: center; gap: 7px; color: var(--pl-text-muted); font-size: 11px; }
.workflow-step > span { width: 23px; height: 23px; display: grid; place-items: center; flex: 0 0 auto; background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: 8px; font-size: 10px; }
.workflow-step strong { font-weight: 600; }
.workflow-step.active { color: var(--pl-primary-hover); }
.workflow-step.active > span { color: #fff; background: var(--pl-primary); border-color: var(--pl-primary); box-shadow: 0 3px 8px rgba(52, 120, 246, .2); }
.workflow-step.done { color: var(--pl-success); }
.workflow-step.done > span { color: var(--pl-success); background: var(--pl-success-soft); border-color: #ccebe2; }
.transfer-form { padding: 14px 14px 1px; background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); border-radius: 12px; }
.transfer-form :deep(.el-form-item) { margin-bottom: 15px; }
.transfer-form :deep(.el-form-item__label) { height: auto; margin-bottom: 6px; color: var(--pl-text-secondary); font-size: 12px; font-weight: 650; line-height: 1.35; }
.link-stats { gap: 7px; flex-wrap: wrap; }
.stat-valid, .stat-dup, .stat-invalid { padding: 4px 7px; border-radius: 7px; }
.stat-valid { color: var(--pl-success); background: var(--pl-success-soft); }
.stat-dup { color: var(--pl-warning); background: var(--pl-warning-soft); }
.stat-invalid { color: var(--pl-danger); background: var(--pl-danger-soft); }
.hint { color: var(--pl-text-muted); }
.warning-hint { color: var(--pl-warning); }
.directory-picker { gap: 7px; }
.directory-tree { padding: 8px; background: var(--pl-surface); border-color: var(--pl-border); border-radius: 11px; }
.directory-tree :deep(.el-tree-node__content) { height: 32px; border-radius: 7px; }
.directory-tree :deep(.el-tree-node__content:hover),
.directory-tree :deep(.is-current > .el-tree-node__content) { color: var(--pl-primary-hover); background: var(--pl-primary-soft); }
.selected-target { display: flex; align-items: center; gap: 4px; color: var(--pl-success); }
.preview-list { padding: 11px; background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); border-radius: 12px; }
.preview-item { min-height: 34px; padding: 6px 8px; color: var(--pl-text-secondary); border: 1px solid var(--pl-border); border-radius: 8px; transition: transform .15s ease, border-color .15s ease; }
.preview-item:hover { border-color: #c8d9f6; transform: translateX(2px); }
.preview-item.invalid { color: var(--pl-danger); background: var(--pl-danger-soft); border-color: #f4cbd2; }
.preview-item.dup { color: #9a6518; background: var(--pl-warning-soft); border-color: #f1d79e; }
.preview-platform { color: var(--pl-primary); background: var(--pl-primary-soft); border-radius: 5px; }
.preview-pwd { color: var(--pl-text-secondary); }
.preview-more { color: var(--pl-text-muted); }
</style>
