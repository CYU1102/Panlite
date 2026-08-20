<template>
  <el-dialog
    title="批量分享"
    :model-value="modelValue"
    width="480px"
    @close="emit('update:modelValue', false)"
  >
    <div class="share-content">
      <el-alert
        v-if="needsCookieHint"
        title="百度分享需要 Cookie 认证（BDUSS）"
        description="当前账号使用 OAuth 登录，不支持分享功能。请使用 Cookie 方式重新登录百度账号。"
        type="warning"
        :closable="false"
        show-icon
      />
      <div class="info-bar">
        <span class="info-item">
          <span class="info-label">平台</span>
          <span class="platform-badge" :class="currentPlatform">{{ PLATFORM_LABELS[currentPlatform] || currentPlatform }}</span>
        </span>
        <span class="info-item">
          <span class="info-label">账号</span>
          <span class="info-value">{{ currentNickname }}</span>
        </span>
        <span class="info-item">
          <span class="info-label">文件</span>
          <span class="info-value">{{ files.length }} 个</span>
        </span>
      </div>
      <el-form label-width="80px">
        <el-form-item label="有效期">
          <el-select v-model="expireDays" style="width: 100%">
            <el-option label="1 天" :value="1" />
            <el-option label="7 天" :value="7" />
            <el-option label="30 天" :value="30" />
          </el-select>
        </el-form-item>
        <el-form-item label="提取码">
          <el-input v-model="password" placeholder="留空则无需提取码" maxlength="8" />
        </el-form-item>
      </el-form>
      <div class="file-list">
        <p class="file-list-title">分享文件：</p>
        <div v-for="file in files.slice(0, 5)" :key="file.id" class="file-item">
          <span>{{ file.name }}</span>
        </div>
        <p v-if="files.length > 5" class="more">...还有 {{ files.length - 5 }} 个文件</p>
      </div>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="onConfirm" :loading="loading">创建分享</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { PLATFORM_LABELS } from '@shared/constants'
import { electronApi } from '../api/ipc'
import { useAppStore } from '../stores/app'
import type { FileItem } from '@shared/types'

const props = defineProps<{
  modelValue: boolean
  files: FileItem[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const appStore = useAppStore()
const loading = ref(false)
const expireDays = ref(7)
const password = ref('')

const needsCookieHint = computed(() => {
  const acc = appStore.currentAccount
  return acc?.platform === 'baidu' && acc?.loginType === 'oauth'
})

const currentPlatform = computed(() => appStore.currentAccount?.platform || '')
const currentNickname = computed(() => appStore.currentAccount?.nickname || '未知')

async function onConfirm() {
  if (!appStore.currentAccount) return
  if (props.files.length === 0) return

  loading.value = true
  try {
    const items = JSON.parse(JSON.stringify(props.files.map((f) => ({
      fileId: f.id,
      name: f.name,
      isDir: f.isDir,
      raw: f.raw,
    }))))
    const options: { expireDays?: number; password?: string } = {
      expireDays: expireDays.value,
    }
    if (password.value.trim()) {
      options.password = password.value.trim()
    }

    const result = await electronApi.batchShare(appStore.currentAccount.id, items, options)
    if (result.success) {
      ElMessage.success('分享任务已创建，请在任务日志中查看进度')
      emit('update:modelValue', false)
      emit('success')
    } else {
      ElMessage.error(result.error || '创建分享失败')
    }
  } catch (err) {
    ElMessage.error('创建分享失败: ' + String(err))
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.share-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.info {
  font-size: 13px;
  color: #6b7280;
}

.info-bar {
  display: flex;
  gap: 16px;
  padding: 10px 12px;
  background: #f9fafb;
  border-radius: 8px;
}

.info-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.info-label {
  color: #9ca3af;
}

.info-value {
  color: #374151;
  font-weight: 500;
}

.platform-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.platform-badge.quark {
  background: #eff6ff;
  color: #3b82f6;
}

.platform-badge.baidu {
  background: #fef2f2;
  color: #ef4444;
}

.file-list {
  background: #f9fafb;
  border-radius: 8px;
  padding: 12px;
}

.file-list-title {
  font-size: 12px;
  color: #9ca3af;
  margin-bottom: 8px;
}

.file-item {
  font-size: 13px;
  color: #374151;
  padding: 4px 0;
}

.more {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 4px;
}
</style>
