<template>
  <el-dialog
    title="批量转存"
    :model-value="modelValue"
    width="560px"
    @close="emit('update:modelValue', false)"
  >
    <div class="transfer-content">
      <el-alert
        v-if="needsCookieHint"
        title="百度转存需要 Cookie 认证（BDUSS）"
        description="当前账号使用 OAuth 登录，不支持转存功能。请使用 Cookie 方式重新登录百度账号。"
        type="warning"
        :closable="false"
        show-icon
      />

      <el-form label-width="80px">
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
          <el-input v-model="targetPath" placeholder="留空则保存到根目录" clearable />
          <p class="hint">填写网盘内的目标路径，如 /我的资源</p>
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
        :disabled="validLinks.length === 0"
      >
        开始转存 ({{ validLinks.length }})
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'
import { useAppStore } from '../stores/app'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const appStore = useAppStore()
const loading = ref(false)
const bulkText = ref('')
const unifiedPassword = ref('')
const targetPath = ref('')
const autoShare = ref(false)
const verifyFirst = ref(false)

const needsCookieHint = computed(() => {
  const acc = appStore.currentAccount
  return acc?.platform === 'baidu' && acc?.loginType === 'oauth'
})

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
  if (!appStore.currentAccount) return

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
      appStore.currentAccount.id,
      links,
      undefined,
      targetPath.value.trim() || undefined,
    )
    if (result.success) {
      ElMessage.success(`已创建转存任务（${links.length} 个链接），请在任务日志中查看进度`)
      emit('update:modelValue', false)
      emit('success')
      bulkText.value = ''
      unifiedPassword.value = ''
      targetPath.value = ''
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
</style>
