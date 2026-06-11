<template>
  <div class="dashboard">
    <!-- 页面头部 -->
    <div class="page-header">
      <div class="header-left">
        <div class="header-icon">
          <BarChart3 :size="20" />
        </div>
        <div>
          <h2>存储空间</h2>
          <p class="header-desc">查看所有网盘账户的存储容量使用情况</p>
        </div>
      </div>
      <el-button type="primary" @click="loadQuota" :loading="loading">
        <RefreshCw :size="14" style="margin-right: 4px" />
        刷新
      </el-button>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading && !quotas.length" class="loading-state">
      <Loader2 :size="32" class="spinning" />
      <span>正在获取存储信息...</span>
    </div>

    <!-- 空状态 -->
    <div v-else-if="!loading && !quotas.length" class="empty-state">
      <div class="empty-icon">
        <HardDrive :size="48" />
      </div>
      <h3>暂无账户</h3>
      <p>请先在账号管理中添加网盘账户</p>
      <el-button type="primary" @click="$router.push('/accounts')">
        <Users :size="14" style="margin-right: 4px" />
        前往账号管理
      </el-button>
    </div>

    <!-- 总览卡片 -->
    <div v-else class="overview-cards">
      <div class="overview-card">
        <div class="overview-icon accounts-icon">
          <Users :size="20" />
        </div>
        <div class="overview-info">
          <span class="overview-value">{{ quotas.length }}</span>
          <span class="overview-label">账户总数</span>
        </div>
      </div>
      <div class="overview-card">
        <div class="overview-icon used-icon">
          <Database :size="20" />
        </div>
        <div class="overview-info">
          <span class="overview-value">{{ formatFileSize(totalUsed) }}</span>
          <span class="overview-label">已用空间</span>
        </div>
      </div>
      <div class="overview-card">
        <div class="overview-icon total-icon">
          <HardDrive :size="20" />
        </div>
        <div class="overview-info">
          <span class="overview-value">{{ formatFileSize(totalCapacity) }}</span>
          <span class="overview-label">总容量</span>
        </div>
      </div>
      <div class="overview-card">
        <div class="overview-icon percent-icon">
          <Percent :size="20" />
        </div>
        <div class="overview-info">
          <span class="overview-value">{{ overallPercent }}%</span>
          <span class="overview-label">总体使用率</span>
        </div>
      </div>
    </div>

    <!-- 账户容量卡片列表 -->
    <div v-if="quotas.length" class="quota-grid">
      <div
        v-for="item in quotas"
        :key="item.accountId"
        class="quota-card"
      >
        <div class="quota-header">
          <div class="quota-avatar" :class="item.platform">
            <component :is="platformIcon(item.platform)" :size="18" />
          </div>
          <div class="quota-user">
            <span class="quota-nickname">{{ item.nickname }}</span>
            <span class="quota-platform" :class="item.platform">{{ platformLabel(item.platform) }}</span>
          </div>
        </div>

        <!-- 有容量信息 -->
        <div v-if="item.quota" class="quota-body">
          <div class="quota-progress-wrap">
            <el-progress
              :percentage="getPercent(item.quota.used, item.quota.total)"
              :color="getProgressColor(getPercent(item.quota.used, item.quota.total))"
              :stroke-width="10"
              :show-text="false"
            />
          </div>
          <div class="quota-detail">
            <div class="quota-used">
              <span class="quota-detail-label">已用</span>
              <span class="quota-detail-value">{{ formatFileSize(item.quota.used) }}</span>
            </div>
            <div class="quota-separator">/</div>
            <div class="quota-total">
              <span class="quota-detail-label">总量</span>
              <span class="quota-detail-value">{{ formatFileSize(item.quota.total) }}</span>
            </div>
          </div>
          <div class="quota-percent" :style="{ color: getProgressColor(getPercent(item.quota.used, item.quota.total)) }">
            {{ getPercent(item.quota.used, item.quota.total) }}%
          </div>
        </div>

        <!-- 无容量信息 -->
        <div v-else class="quota-body quota-unsupported">
          <div class="quota-unsupported-icon">
            <HelpCircle :size="24" />
          </div>
          <span v-if="item.error" class="quota-error">{{ item.error }}</span>
          <span v-else class="quota-unsupported-text">暂不支持容量查询</span>
          <el-button size="small" link type="primary" @click="openPlatformSite(item.platform)" class="quota-link">
            去官网查看
          </el-button>
        </div>
      </div>
    </div>

    <!-- 底部统计栏 -->
    <div v-if="quotas.length" class="stats-bar">
      <div class="stats-item">
        <Database :size="14" />
        <span>共 {{ quotas.length }} 个账户</span>
      </div>
      <div class="stats-item">
        <CheckCircle2 :size="14" />
        <span>{{ supportedCount }} 个支持容量查询</span>
      </div>
      <div v-if="unsupportedCount > 0" class="stats-item">
        <AlertCircle :size="14" />
        <span>{{ unsupportedCount }} 个暂不支持</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, markRaw } from 'vue'
import {
  BarChart3, RefreshCw, Loader2, HardDrive, Users, Database,
  Percent, CheckCircle2, AlertCircle, HelpCircle,
  Cloud, HardDrive as HardDriveIcon
} from 'lucide-vue-next'
import { electronApi } from '../api/ipc'
import { PLATFORM_LABELS } from '@shared/constants'
import { formatFileSize } from '@shared/utils'

interface QuotaItem {
  accountId: string
  platform: string
  nickname: string
  quota: { used: number; total: number } | null
  error?: string
}

const loading = ref(false)
const quotas = ref<QuotaItem[]>([])

const totalUsed = computed(() =>
  quotas.value.reduce((sum, q) => sum + (q.quota?.used || 0), 0)
)
const totalCapacity = computed(() =>
  quotas.value.reduce((sum, q) => sum + (q.quota?.total || 0), 0)
)
const overallPercent = computed(() => {
  if (totalCapacity.value === 0) return 0
  return Math.round((totalUsed.value / totalCapacity.value) * 100)
})
const supportedCount = computed(() =>
  quotas.value.filter(q => q.quota !== null).length
)
const unsupportedCount = computed(() =>
  quotas.value.filter(q => q.quota === null).length
)

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] || platform
}

function platformIcon(platform: string) {
  return platform === 'quark' ? markRaw(Cloud) : markRaw(HardDriveIcon)
}


function getPercent(used: number, total: number): number {
  if (total === 0) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

function getProgressColor(percent: number): string {
  if (percent >= 95) return '#ef4444'
  if (percent >= 80) return '#f59e0b'
  if (percent >= 50) return '#3b82f6'
  return '#22c55e'
}

const PLATFORM_SITES: Record<string, string> = {
  quark: 'https://pan.quark.cn',
  baidu: 'https://pan.baidu.com',
  uc: 'https://drive.uc.cn',
  xunlei: 'https://pan.xunlei.com',
}

function openPlatformSite(platform: string) {
  const url = PLATFORM_SITES[platform]
  if (url) {
    electronApi.openExternal(url)
  }
}

async function loadQuota() {
  loading.value = true
  try {
    const result = await electronApi.getAccountQuota()
    if (result.success && result.quotas) {
      quotas.value = result.quotas
    }
  } catch (err) {
    console.error('Failed to load quota:', err)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadQuota()
})
</script>

<style scoped>
.dashboard {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── 页面头部 ── */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #ffffff;
  padding: 16px 20px;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: #eff6ff;
  color: #3b82f6;
  display: flex;
  align-items: center;
  justify-content: center;
}

.page-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}

.header-desc {
  margin: 2px 0 0;
  font-size: 12px;
  color: #9ca3af;
}

/* ── 加载/空状态 ── */
.loading-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #9ca3af;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.empty-icon {
  width: 80px;
  height: 80px;
  border-radius: 20px;
  background: #f3f4f6;
  color: #d1d5db;
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-state h3 {
  margin: 0;
  font-size: 16px;
  color: #374151;
}

.empty-state p {
  margin: 0;
  font-size: 13px;
  color: #9ca3af;
}

/* ── 总览卡片 ── */
.overview-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.overview-card {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #ffffff;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
}

.overview-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.accounts-icon {
  background: #eff6ff;
  color: #3b82f6;
}

.used-icon {
  background: #f0fdf4;
  color: #22c55e;
}

.total-icon {
  background: #fef3c7;
  color: #f59e0b;
}

.percent-icon {
  background: #fce7f3;
  color: #ec4899;
}

.overview-info {
  display: flex;
  flex-direction: column;
}

.overview-value {
  font-size: 20px;
  font-weight: 700;
  color: #1f2937;
  line-height: 1.2;
}

.overview-label {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 2px;
}

/* ── 容量卡片网格 ── */
.quota-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  flex: 1;
  overflow-y: auto;
}

.quota-card {
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  transition: box-shadow 0.2s;
}

.quota-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
}

.quota-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.quota-avatar {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.quota-avatar.quark {
  background: #eff6ff;
  color: #3b82f6;
}

.quota-avatar.baidu {
  background: #f0fdf4;
  color: #22c55e;
}

.quota-avatar.uc {
  background: #fce7f3;
  color: #ec4899;
}

.quota-avatar.xunlei {
  background: #ede9fe;
  color: #8b5cf6;
}

/* 其他平台默认配色 */
.quota-avatar:not(.quark):not(.baidu):not(.uc):not(.xunlei) {
  background: #f3f4f6;
  color: #6b7280;
}

.quota-user {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.quota-nickname {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quota-platform {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  width: fit-content;
  margin-top: 2px;
}

.quota-platform.quark {
  background: #eff6ff;
  color: #3b82f6;
}

.quota-platform.baidu {
  background: #f0fdf4;
  color: #22c55e;
}

.quota-platform.uc {
  background: #fce7f3;
  color: #ec4899;
}

.quota-platform.xunlei {
  background: #ede9fe;
  color: #8b5cf6;
}

.quota-platform:not(.quark):not(.baidu):not(.uc):not(.xunlei) {
  background: #f3f4f6;
  color: #6b7280;
}

.quota-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.quota-progress-wrap {
  width: 100%;
}

.quota-detail {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.quota-used,
.quota-total {
  display: flex;
  flex-direction: column;
}

.quota-detail-label {
  color: #9ca3af;
  font-size: 11px;
}

.quota-detail-value {
  color: #374151;
  font-weight: 500;
}

.quota-separator {
  color: #d1d5db;
  margin: 0 4px;
  align-self: flex-end;
  margin-bottom: 1px;
}

.quota-percent {
  font-size: 20px;
  font-weight: 700;
  text-align: right;
  line-height: 1;
}

/* 不支持状态 */
.quota-unsupported {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 12px 0;
  gap: 6px;
}

.quota-unsupported-icon {
  color: #d1d5db;
}

.quota-unsupported-text {
  font-size: 12px;
  color: #9ca3af;
}

.quota-error {
  font-size: 12px;
  color: #f59e0b;
  text-align: center;
}

.quota-link {
  margin-top: 4px;
}

/* ── 底部统计栏 ── */
.stats-bar {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 10px 16px;
  background: #ffffff;
  border-radius: 10px;
  border: 1px solid #e5e7eb;
  flex-shrink: 0;
}

.stats-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #6b7280;
}
</style>
