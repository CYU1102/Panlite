<template>
  <footer class="backup-pagination"><span>{{ total }} 项 · 第 {{ page }} / {{ pages }} 页</span><button class="backup-button" type="button" :disabled="busy || page <= 1" @click="$emit('change', page - 1)">上一页{{ label }}</button><button class="backup-button" type="button" :disabled="busy || page >= pages" @click="$emit('change', page + 1)">下一页{{ label }}</button></footer>
</template>
<script setup lang="ts">
import { computed } from 'vue'
const props = withDefaults(defineProps<{ page: number; total: number; pageSize?: number; busy: boolean; label: string }>(), { pageSize: 50 })
defineEmits<{ change: [page: number] }>()
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
</script>
