<template>
  <div class="account-manager">
    <!-- Page header -->
    <div class="page-header">
      <div class="header-info">
        <div class="header-icon">
          <Users :size="20" :stroke-width="1.5" />
        </div>
        <div>
          <h2>账号管理</h2>
          <p>集中查看授权状态，及时处理失效账号</p>
        </div>
      </div>
      <el-button type="primary" @click="showAddAccount = true">
        <UserPlus :size="14" style="margin-right: 4px" />
        添加账号
      </el-button>
    </div>

    <!-- Account health summary -->
    <div v-if="accountStore.accounts.length > 0" class="stats-bar" aria-label="账号状态概览">
      <div class="stat-chip stat-total">
        <Database :size="14" />
        <span><strong>{{ accountStore.accounts.length }}</strong> 个账号</span>
      </div>
      <div class="stat-chip stat-success">
        <CheckCircle2 :size="14" />
        <span><strong>{{ accountStore.accounts.filter(a => a.status === 'active').length }}</strong> 个状态正常</span>
      </div>
      <div
        v-if="accountStore.accounts.filter(a => a.status !== 'active').length > 0"
        class="stat-chip stat-warning"
      >
        <AlertCircle :size="14" />
        <span><strong>{{ accountStore.accounts.filter(a => a.status !== 'active').length }}</strong> 个需要处理</span>
      </div>
    </div>

    <!-- Account cards -->
    <div v-if="accountStore.loading" class="loading-state">
      <div class="loading-spinner">
        <Loader2 :size="24" class="spinning" />
      </div>
      <p>加载中...</p>
    </div>

    <div v-else-if="accountStore.accounts.length === 0" class="empty-state">
      <div class="empty-icon">
        <UserX :size="48" :stroke-width="1" />
      </div>
      <h3>暂无账号</h3>
      <p>添加常用网盘账号后，即可统一管理文件与传输任务</p>
      <el-button type="primary" @click="showAddAccount = true">
        <UserPlus :size="14" style="margin-right: 4px" />
        添加账号
      </el-button>
    </div>

    <div v-else class="account-list">
      <div
        v-for="account in accountStore.accounts"
        :key="account.id"
        class="account-card"
        :class="{ 'is-unhealthy': account.status !== 'active' }"
        tabindex="0"
        role="group"
        :aria-label="`${account.nickname}，${STATUS_LABELS[account.status] || account.status}`"
      >
        <div class="account-main">
          <div class="account-avatar" :class="account.platform" aria-hidden="true">
            <component :is="platformIcon(account.platform)" :size="20" />
            <span class="avatar-status" :class="account.status"></span>
          </div>
          <div class="account-info">
            <div class="account-name">
              {{ account.nickname }}
              <span class="platform-tag" :class="account.platform">
                {{ PLATFORM_LABELS[account.platform] || account.platform }}
              </span>
              <MembershipBadge v-if="memberships[account.id]" :membership="memberships[account.id]" :show-expiry="false" />
              <span v-else-if="membershipLoading[account.id]" class="membership-tag is-loading">
                <Loader2 :size="11" class="spinning" />
                查询会员
              </span>
            </div>
            <div class="account-meta">
              <span class="meta-item">
                <Key :size="12" />
                {{ LOGIN_TYPE_LABELS[account.loginType] || account.loginType }}
              </span>
              <span class="meta-item">
                <Clock :size="12" />
                {{ account.lastCheckAt ? formatTimestamp(account.lastCheckAt) : '未检测' }}
              </span>
              <span v-if="memberships[account.id]?.expiresAt" class="meta-item membership-expiry">
                <CalendarClock :size="12" />
                会员有效至 {{ formatTimestamp(memberships[account.id].expiresAt!) }}
              </span>
            </div>
          </div>
        </div>

        <div class="account-right">
          <div class="status-block">
            <div class="status-badge" :class="account.status">
              <component :is="statusIcon(account.status)" :size="13" />
              {{ STATUS_LABELS[account.status] || account.status }}
            </div>
            <span class="status-hint">{{ statusHint(account.status) }}</span>
          </div>
          <div class="account-actions">
            <button
              class="action-btn action-check"
              title="检测状态"
              :aria-label="`检测 ${account.nickname} 的账号状态`"
              @click="onCheck(account)"
              :disabled="checkingId === account.id"
            >
              <RefreshCw :size="14" :class="{ spinning: checkingId === account.id }" />
              <span>{{ checkingId === account.id ? '检测中' : '检测' }}</span>
            </button>
            <span class="action-divider" aria-hidden="true"></span>
            <button
              class="action-btn danger"
              title="删除账号"
              :aria-label="`删除账号 ${account.nickname}`"
              @click="onDelete(account)"
            >
              <Trash2 :size="14" />
              <span>删除</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <AddAccountDialog v-model="showAddAccount" @success="onAccountAdded" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, markRaw } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs'
import {
  Users, UserPlus, UserX, Key, Clock, RefreshCw, Trash2,
  Database, CheckCircle2, AlertCircle, Loader2,
  Cloud, HardDrive, XCircle, CircleDot, CalendarClock,
} from 'lucide-vue-next'
import { useAccountStore } from '../stores/account'
import { PLATFORM_LABELS } from '@shared/constants'
import { formatTimestamp } from '@shared/utils'
import type { DriveAccount } from '@shared/types'
import type { MembershipInfo } from '@shared/membership'
import MembershipBadge from '../components/MembershipBadge.vue'
import { electronApi } from '../api/ipc'
import AddAccountDialog from '../components/AddAccountDialog.vue'

const accountStore = useAccountStore()
const showAddAccount = ref(false)
const checkingId = ref('')
const memberships = ref<Record<string, MembershipInfo>>({})
const membershipLoading = ref<Record<string, boolean>>({})

const LOGIN_TYPE_LABELS: Record<string, string> = {
  cookie: 'Cookie',
  oauth: 'OAuth',
  token: 'Token',
}

const STATUS_LABELS: Record<string, string> = {
  active: '正常',
  expired: '已过期',
  error: '异常',
}

function platformIcon(platform: string) {
  return platform === 'quark' ? markRaw(Cloud) : markRaw(HardDrive)
}

function statusIcon(status: string) {
  switch (status) {
    case 'active': return markRaw(CheckCircle2)
    case 'expired': return markRaw(AlertCircle)
    case 'error': return markRaw(XCircle)
    default: return markRaw(CircleDot)
  }
}

function statusHint(status: string): string {
  switch (status) {
    case 'active': return '授权可正常使用'
    case 'expired': return '请重新添加或更新授权'
    case 'error': return '检测失败，请稍后重试'
    default: return '等待检测账号状态'
  }
}

async function loadMembership(accountId: string): Promise<void> {
  membershipLoading.value[accountId] = true
  try {
    const result = await electronApi.getAccountMembership(accountId)
    if (result.success && result.membership) memberships.value[accountId] = result.membership
  } finally {
    membershipLoading.value[accountId] = false
  }
}

async function loadMemberships(): Promise<void> {
  await Promise.all(accountStore.accounts
    .filter((account) => account.status === 'active')
    .map((account) => loadMembership(account.id)))
}

async function onAccountAdded() {
  await accountStore.fetchAccounts()
  await loadMemberships()
}

async function onCheck(account: Omit<DriveAccount, 'credential'>) {
  checkingId.value = account.id
  try {
    const result = await accountStore.checkAccount(account.id)
    if (result.success) {
      if (result.status === 'active') {
        ElMessage.success(`账号 "${account.nickname}" 状态正常`)
      } else {
        ElMessage.warning(`账号 "${account.nickname}" 状态: ${STATUS_LABELS[result.status || ''] || result.status}`)
      }
      accountStore.fetchAccounts()
      void loadMembership(account.id)
    } else {
      ElMessage.error(`检测失败：${result.error}`)
    }
  } finally {
    checkingId.value = ''
  }
}

function onDelete(account: Omit<DriveAccount, 'credential'>) {
  ElMessageBox.confirm(
    `确定要删除账号 "${account.nickname}" 吗？此操作将清除本地数据库记录和登录会话。`,
    '删除账号',
    { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
  )
    .then(async () => {
      const result = await accountStore.deleteAccount(account.id)
      if (result.success) {
        ElMessage.success('账号已删除')
      } else {
        ElMessage.error(result.error || '删除失败')
      }
    })
    .catch(() => {})
}

onMounted(async () => {
  await accountStore.fetchAccounts()
  await loadMemberships()
})
</script>

<style scoped>
.account-manager {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── Page header ── */
.page-header {
  display: flex;
  justify-content: space-between;
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
  background: #eff6ff;
  color: #3b82f6;
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

/* ── Account list ── */
.account-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.account-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  transition: all 0.15s;
}

.account-card:hover {
  border-color: #d1d5db;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.account-main {
  display: flex;
  align-items: center;
  gap: 14px;
}

.account-avatar {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.account-avatar.quark {
  background: #eff6ff;
  color: #3b82f6;
}

.account-avatar.baidu {
  background: #f0fdf4;
  color: #22c55e;
}

.account-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.account-name {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.platform-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.platform-tag.quark {
  background: #eff6ff;
  color: #3b82f6;
}

.platform-tag.baidu {
  background: #f0fdf4;
  color: #22c55e;
}

.account-meta {
  display: flex;
  align-items: center;
  gap: 16px;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #9ca3af;
}

.account-right {
  display: flex;
  align-items: center;
  gap: 16px;
}

/* ── Status badge ── */
.status-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
}

.status-badge.active {
  background: #f0fdf4;
  color: #22c55e;
}

.status-badge.expired {
  background: #fffbeb;
  color: #f59e0b;
}

.status-badge.error {
  background: #fef2f2;
  color: #ef4444;
}

/* ── Action buttons ── */
.account-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.action-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e5e7eb;
  background: #ffffff;
  border-radius: 8px;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn:hover:not(:disabled) {
  background: #f9fafb;
  border-color: #d1d5db;
  color: #374151;
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn.danger:hover {
  background: #fef2f2;
  border-color: #fca5a5;
  color: #ef4444;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ── Empty state ── */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 0;
}

.empty-icon {
  width: 80px;
  height: 80px;
  background: #f3f4f6;
  border-radius: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #d1d5db;
  margin-bottom: 4px;
}

.empty-state h3 {
  font-size: 16px;
  font-weight: 600;
  color: #6b7280;
}

.empty-state p {
  font-size: 13px;
  color: #9ca3af;
  margin-bottom: 8px;
}

/* ── Loading state ── */
.loading-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #9ca3af;
}

.loading-spinner {
  color: #3b82f6;
}

/* ── Stats bar ── */
.stats-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: #f9fafb;
  border-radius: 8px;
  border: 1px solid #f3f4f6;
}

.stat-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #6b7280;
}

.stat-chip.warn {
  color: #f59e0b;
}
/* Interactive light workspace */
.account-manager {
  gap: var(--pl-space-4);
  min-width: 0;
}

.page-header,
.account-card,
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

.header-icon {
  background: var(--pl-primary-soft);
  color: var(--pl-primary);
  border-radius: var(--pl-radius-control);
  box-shadow: inset 0 0 0 1px rgba(52, 120, 246, 0.08);
}

.header-info h2,
.account-name {
  color: var(--pl-text);
}

.header-info p,
.meta-item,
.empty-state p,
.loading-state {
  color: var(--pl-text-secondary);
}

.stats-bar {
  padding: var(--pl-space-3);
  background: var(--pl-surface);
  gap: var(--pl-space-2);
}

.stat-chip {
  min-height: 36px;
  padding: 0 var(--pl-space-3);
  border-radius: var(--pl-radius-control);
  background: var(--pl-surface-subtle);
  color: var(--pl-text-secondary);
}

.stat-chip strong {
  color: var(--pl-text);
  font-size: 14px;
}

.stat-success {
  background: var(--pl-success-soft);
  color: var(--pl-success);
}

.stat-success strong {
  color: var(--pl-success);
}

.stat-warning {
  background: var(--pl-warning-soft);
  color: var(--pl-warning);
}

.stat-warning strong {
  color: var(--pl-warning);
}

.account-list {
  gap: var(--pl-space-3);
  overflow-y: auto;
  padding: 2px 4px 12px 2px;
}

.account-card {
  position: relative;
  padding: var(--pl-space-4) var(--pl-space-5);
  background: var(--pl-surface);
  overflow: hidden;
  outline: none;
  transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
}

.account-card::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--pl-primary);
  opacity: 0;
  transition: opacity 180ms ease;
}

.account-card.is-unhealthy::before {
  background: var(--pl-warning);
  opacity: 1;
}

.account-card:hover,
.account-card:focus-visible,
.account-card:focus-within {
  border-color: rgba(52, 120, 246, 0.38);
  box-shadow: var(--pl-shadow-float);
  transform: translateY(-2px);
}

.account-card:hover::before,
.account-card:focus-visible::before,
.account-card:focus-within::before {
  opacity: 1;
}

.account-card:active {
  transform: translateY(0);
  box-shadow: var(--pl-shadow-card);
}

.account-avatar {
  position: relative;
  width: 44px;
  height: 44px;
  border-radius: 12px;
}

.account-avatar.quark,
.platform-tag.quark {
  background: var(--pl-primary-soft);
  color: var(--pl-primary);
}

.account-avatar.baidu,
.platform-tag.baidu {
  background: var(--pl-success-soft);
  color: var(--pl-success);
}

.avatar-status {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 11px;
  height: 11px;
  border: 2px solid var(--pl-surface);
  border-radius: 50%;
  background: var(--pl-text-muted);
}

.avatar-status.active { background: var(--pl-success); }
.avatar-status.expired { background: var(--pl-warning); }
.avatar-status.error { background: var(--pl-danger); }

.platform-tag {
  padding: 2px 7px;
  border-radius: 999px;
  font-weight: 600;
}

.membership-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.membership-tag.is-active {
  color: #9a6700;
  background: #fff7d6;
  border: 1px solid #f6dc83;
}

.membership-tag.is-none,
.membership-tag.is-unknown,
.membership-tag.is-loading {
  color: var(--pl-text-muted);
  background: var(--pl-surface-subtle);
  border: 1px solid var(--pl-border);
}

.membership-tag.is-expired {
  color: var(--pl-warning);
  background: var(--pl-warning-soft);
  border: 1px solid color-mix(in srgb, var(--pl-warning) 25%, transparent);
}

.membership-expiry {
  color: #9a6700;
}

.status-block {
  min-width: 132px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.status-badge {
  padding: 4px 9px;
  border-radius: 999px;
  font-weight: 600;
}

.status-badge.active { background: var(--pl-success-soft); color: var(--pl-success); }
.status-badge.expired { background: var(--pl-warning-soft); color: var(--pl-warning); }
.status-badge.error { background: var(--pl-danger-soft); color: var(--pl-danger); }

.status-hint {
  font-size: 11px;
  color: var(--pl-text-muted);
  white-space: nowrap;
}

.account-actions {
  gap: var(--pl-space-2);
  padding-left: var(--pl-space-4);
  border-left: 1px solid var(--pl-border);
}

.action-btn {
  width: auto;
  min-width: 66px;
  padding: 0 10px;
  gap: 6px;
  border-color: var(--pl-border);
  background: var(--pl-surface-subtle);
  color: var(--pl-text-secondary);
  border-radius: var(--pl-radius-control);
  font-size: 12px;
  font-weight: 600;
}

.action-btn:hover:not(:disabled),
.action-btn:focus-visible {
  background: var(--pl-primary-soft);
  border-color: rgba(52, 120, 246, 0.34);
  color: var(--pl-primary);
  transform: translateY(-1px);
}

.action-btn:active:not(:disabled) {
  transform: translateY(0) scale(0.97);
}

.action-btn.danger {
  min-width: 58px;
  border-color: transparent;
  background: transparent;
}

.action-btn.danger:hover,
.action-btn.danger:focus-visible {
  background: var(--pl-danger-soft);
  border-color: rgba(217, 83, 104, 0.28);
  color: var(--pl-danger);
}

.action-divider {
  width: 1px;
  height: 20px;
  background: var(--pl-border);
}

.empty-state {
  background: var(--pl-surface);
  padding: 64px var(--pl-space-6);
}

.empty-icon {
  background: var(--pl-primary-soft);
  color: #8fb2f4;
  box-shadow: inset 0 0 0 1px rgba(52, 120, 246, 0.08);
}

.empty-state h3 {
  color: var(--pl-text);
}

.loading-spinner {
  color: var(--pl-primary);
}

@media (max-width: 840px) {
  .account-card {
    align-items: flex-start;
    gap: var(--pl-space-4);
  }

  .account-right {
    flex-direction: column;
    align-items: flex-end;
    gap: var(--pl-space-3);
  }

  .account-actions {
    padding-left: 0;
    border-left: 0;
  }

  .account-meta {
    flex-wrap: wrap;
    gap: var(--pl-space-2);
  }
}

@media (max-width: 640px) {
  .page-header {
    padding: var(--pl-space-4);
  }

  .header-info p {
    display: none;
  }

  .stats-bar {
    flex-wrap: wrap;
  }

  .account-card {
    flex-direction: column;
  }

  .account-right {
    width: 100%;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding-top: var(--pl-space-3);
    border-top: 1px solid var(--pl-border);
  }

  .status-block {
    align-items: flex-start;
  }

  .status-hint {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .account-card,
  .action-btn {
    transition: none;
  }
}
</style>
