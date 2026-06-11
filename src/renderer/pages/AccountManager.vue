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
          <p>管理已接入的网盘账号</p>
        </div>
      </div>
      <el-button type="primary" @click="showAddAccount = true">
        <UserPlus :size="14" style="margin-right: 4px" />
        添加账号
      </el-button>
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
      <p>点击右上角添加网盘账号</p>
      <el-button type="primary" @click="showAddAccount = true">
        添加账号
      </el-button>
    </div>

    <div v-else class="account-list">
      <div
        v-for="account in accountStore.accounts"
        :key="account.id"
        class="account-card"
      >
        <div class="account-main">
          <div class="account-avatar" :class="account.platform">
            <component :is="platformIcon(account.platform)" :size="20" />
          </div>
          <div class="account-info">
            <div class="account-name">
              {{ account.nickname }}
              <span class="platform-tag" :class="account.platform">
                {{ PLATFORM_LABELS[account.platform] || account.platform }}
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
            </div>
          </div>
        </div>

        <div class="account-right">
          <div class="status-badge" :class="account.status">
            <component :is="statusIcon(account.status)" :size="12" />
            {{ STATUS_LABELS[account.status] || account.status }}
          </div>
          <div class="account-actions">
            <button
              class="action-btn"
              title="检测状态"
              @click="onCheck(account)"
              :disabled="checkingId === account.id"
            >
              <RefreshCw :size="14" :class="{ spinning: checkingId === account.id }" />
            </button>
            <button
              class="action-btn danger"
              title="删除账号"
              @click="onDelete(account)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Stats bar -->
    <div v-if="accountStore.accounts.length > 0" class="stats-bar">
      <div class="stat-chip">
        <Database :size="12" />
        共 {{ accountStore.accounts.length }} 个账号
      </div>
      <div class="stat-chip">
        <CheckCircle2 :size="12" />
        {{ accountStore.accounts.filter(a => a.status === 'active').length }} 个正常
      </div>
      <div class="stat-chip warn" v-if="accountStore.accounts.filter(a => a.status !== 'active').length > 0">
        <AlertCircle :size="12" />
        {{ accountStore.accounts.filter(a => a.status !== 'active').length }} 个异常
      </div>
    </div>

    <AddAccountDialog v-model="showAddAccount" @success="onAccountAdded" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, markRaw } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Users, UserPlus, UserX, Key, Clock, RefreshCw, Trash2,
  Database, CheckCircle2, AlertCircle, Loader2,
  Cloud, HardDrive, XCircle, CircleDot,
} from 'lucide-vue-next'
import { useAccountStore } from '../stores/account'
import { PLATFORM_LABELS } from '@shared/constants'
import { formatTimestamp } from '@shared/utils'
import type { DriveAccount } from '@shared/types'
import AddAccountDialog from '../components/AddAccountDialog.vue'

const accountStore = useAccountStore()
const showAddAccount = ref(false)
const checkingId = ref('')

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

function onAccountAdded() {
  accountStore.fetchAccounts()
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

onMounted(() => {
  accountStore.fetchAccounts()
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
</style>
