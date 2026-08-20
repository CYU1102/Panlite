<template>
  <span v-if="membership" class="membership-badge" :class="`is-${membership.status}`" :title="title">
    <Crown :size="11" />{{ membership.label }}
    <small v-if="showExpiry && membership.expiresAt">至 {{ formatDate(membership.expiresAt) }}</small>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Crown } from 'lucide-vue-next'
import type { MembershipInfo } from '@shared/membership'

const props = withDefaults(defineProps<{ membership?: MembershipInfo | null; showExpiry?: boolean }>(), { showExpiry: true })
function formatDate(value: number) { return new Date(value).toLocaleDateString('zh-CN') }
const title = computed(() => props.membership?.expiresAt
  ? `${props.membership.label}，有效至 ${new Date(props.membership.expiresAt).toLocaleString('zh-CN')}`
  : props.membership?.label || '')
</script>

<style scoped>
.membership-badge{display:inline-flex;align-items:center;gap:4px;max-width:190px;padding:3px 7px;border-radius:999px;color:#7a642f;background:#fff5d9;font-size:9px;font-weight:700;white-space:nowrap}.membership-badge.is-active{color:#956400;background:#fff0bf}.membership-badge.is-none,.membership-badge.is-unknown{color:#768296;background:#eef2f6}.membership-badge.is-expired{color:#a6535f;background:#fff0f2}.membership-badge small{padding-left:4px;border-left:1px solid currentColor;font-size:8px;font-weight:500;opacity:.8}
</style>
