<template>
  <div class="backup-table-scroll"><table class="backup-table"><thead><tr><th v-if="selectable" class="backup-check-cell">选择</th><th>文件 / 目录</th><th>大小</th><th>{{ preview ? '处理方式与依据' : '内容校验' }}</th></tr></thead><tbody><tr v-for="item in items" :key="item.relativePath"><td v-if="selectable"><input type="checkbox" :aria-label="`选择恢复条目${item.relativePath || '/'}`" :checked="selectedPaths.includes(item.relativePath)" :disabled="disabled" @change="$emit('select', item.relativePath, ($event.target as HTMLInputElement).checked)" /></td><td><strong class="backup-path">{{ item.relativePath || '/' }}</strong><span v-if="item.isDir" class="backup-muted">文件夹</span></td><td>{{ item.isDir ? '—' : formatSize(item.size) }}</td><td><template v-if="preview"><span class="backup-badge" :class="{ warning: item.action === 'blocked' || item.action === 'overwrite' }">{{ labels[item.action || ''] || item.action }}</span><p v-if="item.reason" class="backup-muted">{{ item.reason }}</p></template><details v-if="item.sha256" class="backup-hash"><summary>SHA-256</summary>{{ item.sha256 }}</details><span v-else-if="!preview" class="backup-muted">{{ item.isDir ? '目录记录' : '没有可用校验值' }}</span></td></tr></tbody></table></div>
</template>
<script setup lang="ts">
import { formatFileSize } from '@shared/utils'
withDefaults(defineProps<{ items: Array<{ relativePath: string; isDir: boolean; size: number; sha256?: string; action?: string; reason?: string }>; preview?: boolean; selectable?: boolean; selectedPaths?: string[]; disabled?: boolean }>(), { preview: false, selectable: false, selectedPaths: () => [], disabled: false })
defineEmits<{ select: [path: string, selected: boolean] }>()
const formatSize = formatFileSize
const labels: Record<string, string> = { upload: '上传新版本', reuse: '复用已校验内容', directory: '记录目录', excluded: '规则排除', blocked: '无法处理', create: '恢复到新文件', overwrite: '覆盖现有文件' }
</script>
