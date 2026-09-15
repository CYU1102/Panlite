<template>
  <section class="plan-locations" aria-label="迁移来源和目标">
    <div class="location-grid">
      <article v-for="side in sides" :key="side.key" class="location-card">
        <div class="location-heading"><FolderInput v-if="side.key === 'source'" :size="18" /><FolderOutput v-else :size="18" /><strong>{{ side.label }}</strong></div>
        <template v-if="side.selection"><p class="location-account">{{ accountLabel(side.selection.accountId) }}</p><p class="location-path">{{ side.selection.rootPath }}</p></template>
        <p v-else class="location-empty">尚未选择目录</p>
        <button type="button" :disabled="disabled" @click="activeSide = activeSide === side.key ? null : side.key">{{ side.selection ? '更改' : '选择' }}{{ side.label }}</button>
      </article>
    </div>
    <div v-if="activeSide && !disabled" class="picker-container"><strong>{{ activeSide === 'source' ? '选择源目录' : '选择目标目录' }}</strong><CatalogScopePicker :key="activeSide" :accounts="accounts" :saving="disabled" mode="transfer" @cancel="activeSide = null" @select="selectDirectory" /></div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FolderInput, FolderOutput } from 'lucide-vue-next'
import type { DriveAccount } from '@shared/types'
import { PLATFORM_LABELS } from '@shared/constants'
import CatalogScopePicker from './CatalogScopePicker.vue'

interface Selection { accountId: string; rootId: string; rootPath: string }
const props = defineProps<{ accounts: Omit<DriveAccount, 'credential'>[]; source: Selection | null; target: Selection | null; disabled: boolean }>()
const emit = defineEmits<{ select: [side: 'source' | 'target', selection: Selection] }>()
const activeSide = ref<'source' | 'target' | null>(null)
const sides = computed(() => [{ key: 'source' as const, label: '源目录', selection: props.source }, { key: 'target' as const, label: '目标目录', selection: props.target }])
function accountLabel(id: string): string { const account = props.accounts.find(item => item.id === id); return account ? `${account.nickname} · ${PLATFORM_LABELS[account.platform]}` : '来源账号不可用，请重新选择' }
function selectDirectory(selection: Selection) { if (!activeSide.value || props.disabled) return; emit('select', activeSide.value, selection); activeSide.value = null }
watch(() => props.disabled, value => { if (value) activeSide.value = null })
</script>

<style scoped>
.plan-locations { display: grid; gap: 14px; }.location-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }.location-card { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; padding: 14px; border: 1px solid var(--pl-border); border-radius: 10px; background: var(--pl-surface-subtle); }.location-heading { display: flex; align-items: center; gap: 7px; color: var(--pl-text); font-size: 13px; }.location-heading svg { color: var(--pl-primary); }.location-account { margin: 12px 0 3px; color: var(--pl-text-secondary); font-size: 12px; }.location-path { margin: 0 0 12px; overflow-wrap: anywhere; color: var(--pl-text); font-size: 13px; }.location-empty { color: var(--pl-text-muted); font-size: 12px; }.location-card button { margin-top: auto; padding: 6px 10px; color: var(--pl-primary); background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: 7px; cursor: pointer; font: inherit; font-size: 12px; }.location-card button:disabled { opacity: .5; cursor: default; }.picker-container { display: grid; gap: 9px; font-size: 13px; color: var(--pl-text); }
@media (max-width: 700px) { .location-grid { grid-template-columns: 1fr; } }
</style>
