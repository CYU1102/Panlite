<template>
  <el-dialog
    :model-value="modelValue"
    width="800px"
    title="一键搜索资源"
    :close-on-click-modal="false"
    @close="onClose"
  >
    <!-- 搜索输入 -->
    <div class="search-input">
      <el-input
        v-model="keyword"
        placeholder="输入关键词搜索网盘资源..."
        size="large"
        clearable
        @keyup.enter="onSearch"
      >
        <template #prefix>
          <Search :size="20" />
        </template>
        <template #append>
          <el-button type="primary" @click="onSearch" :loading="searching">
            搜索
          </el-button>
        </template>
      </el-input>
    </div>

    <!-- 搜索提示 -->
    <div class="search-tips" v-if="!searching && results.length === 0">
      <p>💡 支持搜索夸克、百度、UC、迅雷等平台的资源</p>
      <div class="tip-tags">
        <el-tag v-for="tag in hotTags" :key="tag" @click="searchTag(tag)" class="tip-tag">
          {{ tag }}
        </el-tag>
      </div>
    </div>

    <!-- 搜索结果 -->
    <div class="search-results" v-if="results.length > 0">
      <div class="results-header">
        <span>找到 {{ results.length }} 个资源</span>
        <el-button text size="small" @click="clearResults">清空</el-button>
      </div>

      <el-scrollbar max-height="400px">
        <div v-for="(item, index) in results" :key="index" class="result-item">
          <div class="result-header">
            <el-tag :type="getPlatformTagType(item.platform)" size="small">
              {{ getPlatformName(item.platform) }}
            </el-tag>
            <span class="result-source">{{ item.source }}</span>
            <el-tag v-if="item.password" type="success" size="small">
              提取码: {{ item.password }}
            </el-tag>
          </div>

          <div class="result-title">{{ item.title }}</div>

          <div class="result-url">
            <el-input
              :model-value="item.url"
              readonly
              size="small"
            >
              <template #append>
                <el-button @click="copyUrl(item.url)">
                  <Copy :size="14" />
                </el-button>
              </template>
            </el-input>
          </div>

          <div class="result-actions">
            <el-button size="small" @click="openUrl(item.url)">
              <ExternalLink :size="14" style="margin-right: 4px" />
              打开
            </el-button>
            <el-button size="small" @click="transferItem(item)">
              <Download :size="14" style="margin-right: 4px" />
              转存
            </el-button>
          </div>
        </div>
      </el-scrollbar>
    </div>

    <!-- 加载状态 -->
    <div class="search-loading" v-if="searching">
      <el-icon class="is-loading"><Loader2 /></el-icon>
      <span>正在搜索资源...</span>
    </div>

    <template #footer>
      <el-button @click="onClose">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { Search, Copy, ExternalLink, Download, Loader2 } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'

interface SearchResult {
  title: string
  url: string
  password?: string
  platform: string
  source: string
}

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  transfer: [item: SearchResult]
}>()

const keyword = ref('')
const searching = ref(false)
const results = ref<SearchResult[]>([])

const hotTags = ['电影', '电视剧', '动漫', '综艺', '纪录片', '音乐', '电子书', '软件']

async function onSearch() {
  if (!keyword.value.trim()) {
    ElMessage.warning('请输入搜索关键词')
    return
  }

  searching.value = true
  results.value = []

  try {
    const result = await electronApi.aggregateSearch(keyword.value.trim())
    if (result.success && result.results) {
      results.value = result.results
      if (results.value.length === 0) {
        ElMessage.info('未找到相关资源，换个关键词试试')
      }
    } else {
      ElMessage.error(result.error || '搜索失败')
    }
  } catch (err) {
    ElMessage.error('搜索失败: ' + String(err))
  } finally {
    searching.value = false
  }
}

function searchTag(tag: string) {
  keyword.value = tag
  onSearch()
}

function clearResults() {
  results.value = []
}

function getPlatformName(platform: string): string {
  const names: Record<string, string> = {
    quark: '夸克',
    baidu: '百度',
    uc: 'UC',
    xunlei: '迅雷',
  }
  return names[platform] || platform
}

function getPlatformTagType(platform: string): string {
  const types: Record<string, string> = {
    quark: 'primary',
    baidu: 'warning',
    uc: 'info',
  }
  return types[platform] || ''
}

async function copyUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    ElMessage.success('链接已复制')
  } catch {
    ElMessage.error('复制失败')
  }
}

function openUrl(url: string) {
  window.open(url, '_blank')
}

function transferItem(item: SearchResult) {
  emit('transfer', item)
  onClose()
}

function onClose() {
  emit('update:modelValue', false)
}
</script>

<style scoped>
.search-input {
  margin-bottom: 16px;
}

.search-tips {
  text-align: center;
  padding: 40px 0;
  color: #909399;
}

.search-tips p {
  margin-bottom: 16px;
}

.tip-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

.tip-tag {
  cursor: pointer;
  transition: all 0.2s;
}

.tip-tag:hover {
  transform: scale(1.05);
}

.search-results {
  margin-top: 16px;
}

.results-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-size: 13px;
  color: #606266;
}

.result-item {
  padding: 12px;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  margin-bottom: 12px;
}

.result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.result-source {
  font-size: 12px;
  color: #909399;
}

.result-title {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
  margin-bottom: 8px;
}

.result-url {
  margin-bottom: 8px;
}

.result-actions {
  display: flex;
  gap: 8px;
}

.search-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px;
  color: #909399;
}

.is-loading {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
