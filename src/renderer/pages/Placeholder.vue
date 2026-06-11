<template>
  <div class="placeholder-page">
    <div class="placeholder-icon">
      <Construction :size="48" :stroke-width="1" />
    </div>
    <h3>{{ title }}</h3>
    <p>此功能正在开发中，敬请期待</p>
  </div>
</template>

<script setup lang="ts">
import { Construction } from 'lucide-vue-next'

defineProps<{
  title?: string
}>()
</script>

<style scoped>
.placeholder-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #9ca3af;
}

.placeholder-icon {
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

.placeholder-page h3 {
  font-size: 16px;
  font-weight: 600;
  color: #6b7280;
}

.placeholder-page p {
  font-size: 13px;
  color: #9ca3af;
}
</style>
