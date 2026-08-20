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
          <p class="header-desc">汇总账号容量，快速发现空间不足的网盘</p>
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
      <div class="overview-card accounts-card" tabindex="0" role="group" :aria-label="`账户总数 ${quotas.length}`">
        <div class="overview-icon accounts-icon">
          <Users :size="20" />
        </div>
        <div class="overview-info">
          <span class="overview-value">{{ quotas.length }}</span>
          <span class="overview-label">账户总数</span>
          <span class="overview-note">已纳入本次容量统计</span>
        </div>
      </div>
      <div class="overview-card used-card" tabindex="0" role="group" :aria-label="`已用空间 ${formatFileSize(totalUsed)}`">
        <div class="overview-icon used-icon">
          <Database :size="20" />
        </div>
        <div class="overview-info">
          <span class="overview-value">{{ formatFileSize(totalUsed) }}</span>
          <span class="overview-label">已用空间</span>
          <span class="overview-note">所有可查询账号合计</span>
        </div>
      </div>
      <div class="overview-card total-card" tabindex="0" role="group" :aria-label="`总容量 ${formatFileSize(totalCapacity)}`">
        <div class="overview-icon total-icon">
          <HardDrive :size="20" />
        </div>
        <div class="overview-info">
          <span class="overview-value">{{ formatFileSize(totalCapacity) }}</span>
          <span class="overview-label">总容量</span>
          <span class="overview-note">来自 {{ supportedCount }} 个账号</span>
        </div>
      </div>
      <div
        class="overview-card percent-card"
        :class="`is-${getQuotaState(overallPercent)}`"
        tabindex="0"
        role="group"
        :aria-label="`总体使用率 ${overallPercent}%`"
      >
        <div class="overview-icon percent-icon">
          <Percent :size="20" />
        </div>
        <div class="overview-info">
          <span class="overview-value">{{ overallPercent }}%</span>
          <span class="overview-label">总体使用率</span>
          <span class="overview-note">{{ getQuotaLabel(overallPercent) }}</span>
        </div>
      </div>
    </div>

    <!-- 账户容量卡片列表 -->
    <div v-if="quotas.length" class="quota-grid">
      <div
        v-for="item in quotas"
        :key="item.accountId"
        class="quota-card"
        :class="item.quota ? `is-${getQuotaState(getPercent(item.quota.used, item.quota.total))}` : 'is-unavailable'"
        tabindex="0"
        role="group"
        :aria-label="`${item.nickname} 的容量信息`"
      >
        <div class="quota-header">
          <div class="quota-avatar" :class="item.platform">
            <component :is="platformIcon(item.platform)" :size="18" />
          </div>
          <div class="quota-user">
            <span class="quota-nickname">{{ item.nickname }}</span>
            <span><span class="quota-platform" :class="item.platform">{{ platformLabel(item.platform) }}</span><MembershipBadge :membership="item.membership" /></span>
          </div>
          <span
            v-if="item.quota"
            class="quota-state"
            :class="`is-${getQuotaState(getPercent(item.quota.used, item.quota.total))}`"
          >
            {{ getQuotaLabel(getPercent(item.quota.used, item.quota.total)) }}
          </span>
          <span v-else class="quota-state is-unavailable">查询不可用</span>
        </div>

        <!-- 有容量信息 -->
        <div v-if="item.quota" class="quota-body">
          <div class="quota-meter-heading">
            <span>存储使用情况</span>
            <strong :style="{ color: getProgressColor(getPercent(item.quota.used, item.quota.total)) }">
              {{ getPercent(item.quota.used, item.quota.total) }}%
            </strong>
          </div>
          <div class="quota-progress-wrap">
            <el-progress
              :percentage="getPercent(item.quota.used, item.quota.total)"
              :color="getProgressColor(getPercent(item.quota.used, item.quota.total))"
              :stroke-width="10"
              :show-text="false"
            />
          </div>
          <div class="quota-detail">
            <div class="quota-detail-item quota-used">
              <span class="quota-detail-label">已用</span>
              <span class="quota-detail-value">{{ formatFileSize(item.quota.used) }}</span>
            </div>
            <div class="quota-detail-item quota-remaining">
              <span class="quota-detail-label">剩余</span>
              <span class="quota-detail-value">{{ formatFileSize(Math.max(0, item.quota.total - item.quota.used)) }}</span>
            </div>
            <div class="quota-detail-item quota-total">
              <span class="quota-detail-label">总量</span>
              <span class="quota-detail-value">{{ formatFileSize(item.quota.total) }}</span>
            </div>
          </div>
        </div>

        <!-- 无容量信息 -->
        <div v-else class="quota-body quota-unsupported">
          <div class="quota-unsupported-icon">
            <HelpCircle :size="24" />
          </div>
          <div class="quota-unsupported-copy">
            <strong>{{ item.error ? '容量获取失败' : '暂不支持容量查询' }}</strong>
            <span v-if="item.error" class="quota-error">{{ item.error }}</span>
            <span v-else class="quota-unsupported-text">可前往平台官网查看详细空间信息</span>
          </div>
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
      <div v-if="unsupportedCount > 0" class="stats-item stats-warning">
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
import type { MembershipInfo } from '@shared/membership'
import MembershipBadge from '../components/MembershipBadge.vue'

interface QuotaItem {
  accountId: string
  platform: string
  nickname: string
  quota: { used: number; total: number } | null
  membership?: MembershipInfo | null
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
  if (percent >= 95) return 'var(--pl-danger)'
  if (percent >= 80) return 'var(--pl-warning)'
  if (percent >= 50) return 'var(--pl-primary)'
  return 'var(--pl-success)'
}

function getQuotaState(percent: number): 'healthy' | 'notice' | 'warning' | 'critical' {
  if (percent >= 95) return 'critical'
  if (percent >= 80) return 'warning'
  if (percent >= 50) return 'notice'
  return 'healthy'
}

function getQuotaLabel(percent: number): string {
  if (percent >= 95) return '空间即将用尽'
  if (percent >= 80) return '空间使用偏高'
  if (percent >= 50) return '空间使用适中'
  return '空间充足'
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
/* Interactive light storage workspace */
.dashboard {
  gap: var(--pl-space-4);
  min-width: 0;
}

.page-header,
.overview-card,
.quota-card,
.stats-bar,
.empty-state {
  border: 1px solid var(--pl-border);
  border-radius: var(--pl-radius-card);
  box-shadow: var(--pl-shadow-card);
}

.page-header {
  padding: var(--pl-space-5) var(--pl-space-6);
  background: linear-gradient(135deg, var(--pl-surface) 0%, var(--pl-surface-subtle) 100%);
}

.header-icon,
.accounts-icon {
  background: var(--pl-primary-soft);
  color: var(--pl-primary);
  box-shadow: inset 0 0 0 1px rgba(52, 120, 246, 0.08);
}

.page-header h2,
.overview-value,
.quota-nickname,
.quota-unsupported-copy strong {
  color: var(--pl-text);
}

.header-desc,
.overview-label,
.overview-note,
.quota-detail-label,
.quota-unsupported-text,
.stats-item {
  color: var(--pl-text-secondary);
}

.loading-state {
  color: var(--pl-text-secondary);
}

.empty-state {
  padding: 64px var(--pl-space-6);
  background: var(--pl-surface);
}

.empty-icon {
  background: var(--pl-primary-soft);
  color: #8fb2f4;
  box-shadow: inset 0 0 0 1px rgba(52, 120, 246, 0.08);
}

.overview-cards {
  gap: var(--pl-space-3);
}

.overview-card {
  position: relative;
  min-width: 0;
  padding: var(--pl-space-4) var(--pl-space-5);
  background: var(--pl-surface);
  overflow: hidden;
  outline: none;
  transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
}

.overview-card::after {
  content: '';
  position: absolute;
  inset: auto 0 0;
  height: 3px;
  background: var(--pl-primary);
  opacity: 0;
  transition: opacity 180ms ease;
}

.overview-card:hover,
.overview-card:focus-visible {
  transform: translateY(-2px);
  border-color: rgba(52, 120, 246, 0.34);
  box-shadow: var(--pl-shadow-float);
}

.overview-card:hover::after,
.overview-card:focus-visible::after {
  opacity: 1;
}

.overview-card:active {
  transform: translateY(0);
  box-shadow: var(--pl-shadow-card);
}

.overview-info {
  min-width: 0;
}

.overview-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overview-label {
  margin-top: 3px;
  font-weight: 600;
}

.overview-note {
  margin-top: 5px;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.used-icon { background: var(--pl-success-soft); color: var(--pl-success); }
.total-icon { background: var(--pl-warning-soft); color: var(--pl-warning); }
.percent-icon { background: var(--pl-info-soft); color: var(--pl-primary); }

.percent-card.is-warning::after { background: var(--pl-warning); opacity: 1; }
.percent-card.is-critical::after { background: var(--pl-danger); opacity: 1; }

.quota-grid {
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--pl-space-3);
  align-content: start;
  padding: 2px 4px 12px 2px;
}

.quota-card {
  position: relative;
  padding: var(--pl-space-5);
  background: var(--pl-surface);
  overflow: hidden;
  outline: none;
  transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
}

.quota-card::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--pl-primary);
  opacity: 0;
  transition: opacity 180ms ease;
}

.quota-card.is-warning::before { background: var(--pl-warning); opacity: 1; }
.quota-card.is-critical::before { background: var(--pl-danger); opacity: 1; }
.quota-card.is-unavailable::before { background: var(--pl-text-muted); opacity: 0.7; }

.quota-card:hover,
.quota-card:focus-visible,
.quota-card:focus-within {
  transform: translateY(-2px);
  border-color: rgba(52, 120, 246, 0.34);
  box-shadow: var(--pl-shadow-float);
}

.quota-card:hover::before,
.quota-card:focus-visible::before,
.quota-card:focus-within::before {
  opacity: 1;
}

.quota-card:active {
  transform: translateY(0);
}

.quota-avatar.quark,
.quota-platform.quark { background: var(--pl-primary-soft); color: var(--pl-primary); }
.quota-avatar.baidu,
.quota-platform.baidu { background: var(--pl-success-soft); color: var(--pl-success); }
.quota-avatar.uc,
.quota-platform.uc { background: #f3efff; color: #7658d8; }
.quota-avatar.xunlei,
.quota-platform.xunlei { background: var(--pl-warning-soft); color: var(--pl-warning); }

.quota-platform {
  padding: 2px 7px;
  border-radius: 999px;
  font-weight: 600;
}

.quota-state {
  margin-left: auto;
  flex-shrink: 0;
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--pl-primary-soft);
  color: var(--pl-primary);
  font-size: 11px;
  font-weight: 600;
}

.quota-state.is-healthy { background: var(--pl-success-soft); color: var(--pl-success); }
.quota-state.is-notice { background: var(--pl-primary-soft); color: var(--pl-primary); }
.quota-state.is-warning { background: var(--pl-warning-soft); color: var(--pl-warning); }
.quota-state.is-critical { background: var(--pl-danger-soft); color: var(--pl-danger); }
.quota-state.is-unavailable { background: var(--pl-surface-subtle); color: var(--pl-text-muted); }

.quota-body {
  gap: var(--pl-space-3);
}

.quota-meter-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--pl-space-3);
  color: var(--pl-text-secondary);
  font-size: 12px;
}

.quota-meter-heading strong {
  font-size: 18px;
  line-height: 1;
}

.quota-progress-wrap :deep(.el-progress-bar__outer) {
  background: var(--pl-page-bg);
}

.quota-detail {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--pl-space-2);
}

.quota-detail-item {
  min-width: 0;
  padding: 9px 10px;
  border-radius: var(--pl-radius-sm);
  background: var(--pl-surface-subtle);
}

.quota-detail-label,
.quota-detail-value {
  display: block;
}

.quota-detail-value {
  margin-top: 2px;
  color: var(--pl-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quota-unsupported {
  min-height: 104px;
  padding: var(--pl-space-3);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--pl-space-3);
  border-radius: var(--pl-radius-control);
  background: var(--pl-surface-subtle);
}

.quota-unsupported-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pl-radius-control);
  background: var(--pl-warning-soft);
  color: var(--pl-warning);
}

.quota-unsupported-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.quota-unsupported-copy strong {
  font-size: 12px;
}

.quota-error {
  color: var(--pl-warning);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quota-link {
  margin: 0;
  flex-shrink: 0;
}

.stats-bar {
  background: var(--pl-surface);
}

.stats-warning {
  color: var(--pl-warning);
}

@media (max-width: 1080px) {
  .overview-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .page-header {
    padding: var(--pl-space-4);
  }

  .header-desc {
    display: none;
  }

  .overview-cards {
    grid-template-columns: 1fr;
  }

  .quota-grid {
    grid-template-columns: 1fr;
  }

  .stats-bar {
    flex-wrap: wrap;
    gap: var(--pl-space-3);
  }
}

@media (max-width: 440px) {
  .quota-detail {
    grid-template-columns: 1fr;
  }

  .quota-unsupported {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .quota-link {
    grid-column: 2;
    justify-self: start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .overview-card,
  .quota-card {
    transition: none;
  }
}
</style>
