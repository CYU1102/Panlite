<template>
  <el-dialog
    :model-value="modelValue"
    width="min(1100px, 92vw)"
    top="5vh"
    :title="fileName || '文件预览'"
    :close-on-click-modal="false"
    destroy-on-close
    @close="closeDialog"
  >
    <div class="preview-shell">
      <div v-if="loading" class="preview-state">
        <el-icon class="is-loading"><Loader2 /></el-icon>
        <span>正在安全下载并准备预览...</span>
      </div>

      <el-result v-else-if="error" icon="error" title="无法预览" :sub-title="error">
        <template #extra>
          <el-button type="primary" @click="loadPreview">重试</el-button>
        </template>
      </el-result>

      <template v-else-if="preview">
        <div v-if="preview.truncated" class="limit-tip">
          文本较大，仅显示前 {{ formatSize(maxTextBytes) }}。
        </div>

        <div v-if="preview.kind === 'image'" class="media-stage image-stage">
          <img v-if="safeAssetUrl" :src="safeAssetUrl" :alt="preview.fileName">
        </div>

        <div v-else-if="preview.kind === 'video'" class="media-stage">
          <video v-if="safeAssetUrl" :src="safeAssetUrl" controls preload="metadata" />
        </div>

        <div v-else-if="preview.kind === 'audio'" class="audio-stage">
          <Music :size="54" />
          <strong>{{ preview.fileName }}</strong>
          <audio v-if="safeAssetUrl" :src="safeAssetUrl" controls preload="metadata" />
        </div>

        <div v-else-if="preview.kind === 'pdf'" class="pdf-stage">
          <object v-if="safeAssetUrl" :data="safeAssetUrl" type="application/pdf">
            <p>当前环境无法显示 PDF。</p>
          </object>
        </div>

        <pre v-else-if="preview.kind === 'text'" class="text-preview">{{ preview.content }}</pre>

        <article v-else-if="preview.kind === 'markdown'" class="markdown-preview">
          <template v-for="(block, index) in markdownBlocks" :key="index">
            <component :is="`h${block.level}`" v-if="block.type === 'heading'">
              <MarkdownInline :text="block.text" />
            </component>
            <pre v-else-if="block.type === 'code'"><code>{{ block.text }}</code></pre>
            <blockquote v-else-if="block.type === 'quote'"><MarkdownInline :text="block.text" /></blockquote>
            <div v-else-if="block.type === 'list'" class="markdown-list-row">
              <span class="markdown-marker">{{ block.marker }}</span>
              <MarkdownInline :text="block.text" />
            </div>
            <hr v-else-if="block.type === 'rule'">
            <p v-else><MarkdownInline :text="block.text" /></p>
          </template>
        </article>

        <div v-else-if="preview.kind === 'archive' && preview.archive" class="archive-preview">
          <div class="archive-summary">
            <span>{{ preview.archive.format.toUpperCase() }}</span>
            <span>{{ preview.archive.fileCount }} 项</span>
            <span>{{ formatSize(preview.archive.totalSize) }}</span>
            <el-tag v-if="preview.archive.isEncrypted" type="warning" size="small">已加密</el-tag>
          </div>
          <el-table :data="preview.archive.files" max-height="520" stripe>
            <el-table-column label="名称" min-width="360">
              <template #default="{ row }">
                <span>{{ row.isDir ? '📁' : '📄' }} {{ row.path }}</span>
              </template>
            </el-table-column>
            <el-table-column label="大小" width="130" align="right">
              <template #default="{ row }">{{ row.isDir ? '-' : formatSize(row.size) }}</template>
            </el-table-column>
          </el-table>
        </div>
      </template>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <span v-if="preview" class="preview-meta">{{ preview.mimeType }} · {{ formatSize(preview.size) }}</span>
        <el-button
          v-if="preview?.kind === 'archive'"
          type="primary"
          @click="emit('openArchive', { fileId, fileName })"
        >
          打开解压功能
        </el-button>
        <el-button @click="closeDialog">关闭</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onBeforeUnmount, ref, watch } from 'vue'
import { Loader2, Music } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'

type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'markdown' | 'archive'

interface ArchiveFile {
  name: string
  path: string
  size: number
  isDir: boolean
}

interface ArchiveMeta {
  fileCount: number
  totalSize: number
  isEncrypted: boolean
  format: string
  files: ArchiveFile[]
}

interface PreviewDto {
  sessionId: string
  fileName: string
  kind: PreviewKind
  mimeType: string
  size: number
  assetUrl?: string
  content?: string
  truncated?: boolean
  archive?: ArchiveMeta
  expiresAt: number
}

interface PreviewResult {
  success: boolean
  preview?: PreviewDto
  error?: string
}

interface MarkdownBlock {
  type: 'heading' | 'code' | 'quote' | 'list' | 'rule' | 'paragraph'
  text: string
  level: number
  marker?: string
}

interface InlineToken {
  type: 'text' | 'strong' | 'emphasis' | 'code' | 'link'
  text: string
  href?: string
}

const props = withDefaults(defineProps<{
  modelValue: boolean
  accountId: string
  fileId: string
  fileName: string
  fileSize?: number
  password?: string
  maxTextBytes?: number
}>(), {
  fileSize: undefined,
  password: undefined,
  maxTextBytes: 1024 * 1024,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  openArchive: [payload: { fileId: string; fileName: string }]
}>()

const loading = ref(false)
const error = ref('')
const preview = ref<PreviewDto | null>(null)
let loadGeneration = 0

const safeAssetUrl = computed(() => {
  const value = preview.value?.assetUrl
  if (!value) return ''
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'file:' || parsed.protocol === 'panlite-preview:' ? parsed.href : ''
  } catch {
    return ''
  }
})

const markdownBlocks = computed(() => parseMarkdownBlocks(preview.value?.content || ''))

const MarkdownInline = defineComponent({
  name: 'MarkdownInline',
  props: { text: { type: String, required: true } },
  setup(inlineProps) {
    return () => parseInline(inlineProps.text).map((token, index) => {
      if (token.type === 'strong') return h('strong', { key: index }, token.text)
      if (token.type === 'emphasis') return h('em', { key: index }, token.text)
      if (token.type === 'code') return h('code', { key: index }, token.text)
      if (token.type === 'link' && token.href) {
        return h('a', { key: index, href: token.href, target: '_blank', rel: 'noopener noreferrer' }, token.text)
      }
      return token.text
    })
  },
})

watch(() => props.modelValue, (visible) => {
  if (visible) void loadPreview()
  else void cleanupPreview()
})

watch(() => [props.accountId, props.fileId, props.fileName], () => {
  if (props.modelValue) void loadPreview()
})

onBeforeUnmount(() => {
  loadGeneration++
  void cleanupPreview()
})

async function loadPreview(): Promise<void> {
  const generation = ++loadGeneration
  await cleanupPreview()
  if (!props.accountId || !props.fileId || !props.fileName) {
    error.value = '缺少预览文件信息'
    return
  }

  loading.value = true
  error.value = ''
  try {
    const result = await electronApi.prepareFilePreview(
      props.accountId,
      props.fileId,
      props.fileName,
      props.fileSize,
    ) as PreviewResult
    if (generation !== loadGeneration) {
      if (result.preview?.sessionId) await cleanupSession(result.preview.sessionId)
      return
    }
    if (!result.success || !result.preview) throw new Error(result.error || '准备预览失败')
    preview.value = result.preview
    if (requiresAsset(result.preview.kind) && !safeAssetUrl.value) throw new Error('主进程返回了不安全的预览地址')
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : String(loadError)
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
}

async function cleanupPreview(): Promise<void> {
  const sessionId = preview.value?.sessionId
  preview.value = null
  if (sessionId) await cleanupSession(sessionId)
}

async function cleanupSession(sessionId: string): Promise<void> {
  try {
    await electronApi.cleanupFilePreview(sessionId)
  } catch {
    // Main process also expires orphaned sessions.
  }
}

function closeDialog(): void {
  loadGeneration++
  emit('update:modelValue', false)
  void cleanupPreview()
}

function requiresAsset(kind: PreviewKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf'
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
  let inCode = false
  let codeLines: string[] = []

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        blocks.push({ type: 'code', text: codeLines.join('\n'), level: 0 })
        codeLines = []
      }
      inCode = !inCode
      continue
    }
    if (inCode) {
      codeLines.push(line)
      continue
    }
    if (!line.trim()) continue

    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', text: heading[2], level: heading[1].length })
      continue
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ type: 'rule', text: '', level: 0 })
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      blocks.push({ type: 'quote', text: quote[1], level: 0 })
      continue
    }
    const list = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(line)
    if (list) {
      blocks.push({ type: 'list', marker: list[1], text: list[2], level: 0 })
      continue
    }
    blocks.push({ type: 'paragraph', text: line, level: 0 })
  }

  if (inCode || codeLines.length) blocks.push({ type: 'code', text: codeLines.join('\n'), level: 0 })
  return blocks
}

function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^\s)]+\))/g
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index || 0
    if (index > offset) tokens.push({ type: 'text', text: text.slice(offset, index) })
    const value = match[0]
    if (value.startsWith('`')) tokens.push({ type: 'code', text: value.slice(1, -1) })
    else if (value.startsWith('**') || value.startsWith('__')) tokens.push({ type: 'strong', text: value.slice(2, -2) })
    else if (value.startsWith('*') || value.startsWith('_')) tokens.push({ type: 'emphasis', text: value.slice(1, -1) })
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value)
      const href = link ? safeExternalLink(link[2]) : ''
      tokens.push(href ? { type: 'link', text: link![1], href } : { type: 'text', text: value })
    }
    offset = index + value.length
  }
  if (offset < text.length) tokens.push({ type: 'text', text: text.slice(offset) })
  return tokens
}

function safeExternalLink(value: string): string {
  try {
    const url = new URL(value)
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}
</script>

<style scoped>
.preview-shell { min-height: 360px; max-height: 72vh; overflow: auto; }
.preview-state { min-height: 360px; display: flex; align-items: center; justify-content: center; gap: 10px; color: #909399; }
.limit-tip { margin-bottom: 12px; padding: 8px 12px; color: #8a5b00; background: #fff7df; border-radius: 6px; }
.media-stage { min-height: 420px; display: flex; align-items: center; justify-content: center; background: #111827; border-radius: 8px; overflow: hidden; }
.media-stage img, .media-stage video { max-width: 100%; max-height: 68vh; object-fit: contain; }
.image-stage { background-image: linear-gradient(45deg, #e8eaed 25%, transparent 25%), linear-gradient(-45deg, #e8eaed 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e8eaed 75%), linear-gradient(-45deg, transparent 75%, #e8eaed 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0; }
.audio-stage { min-height: 360px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; color: #606266; }
.audio-stage audio { width: min(620px, 90%); }
.pdf-stage object { display: block; width: 100%; height: 68vh; border: 0; }
.text-preview, .markdown-preview pre { margin: 0; padding: 18px; white-space: pre-wrap; overflow-wrap: anywhere; color: #d4d4d4; background: #1e1e1e; border-radius: 8px; font: 13px/1.65 Consolas, Monaco, monospace; }
.markdown-preview { padding: 8px 20px 28px; color: #303133; line-height: 1.7; overflow-wrap: anywhere; }
.markdown-preview :deep(a) { color: #409eff; }
.markdown-preview :deep(code) { padding: 2px 5px; background: #f0f2f5; border-radius: 4px; font-family: Consolas, Monaco, monospace; }
.markdown-preview pre :deep(code) { padding: 0; color: inherit; background: transparent; }
.markdown-preview blockquote { margin: 12px 0; padding: 4px 14px; color: #606266; border-left: 4px solid #dcdfe6; }
.markdown-list-row { display: flex; gap: 9px; margin: 5px 0 5px 16px; }
.markdown-marker { min-width: 22px; color: #606266; }
.archive-summary { display: flex; align-items: center; gap: 18px; margin-bottom: 14px; color: #606266; }
.dialog-footer { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.preview-meta { margin-right: auto; color: #909399; font-size: 12px; }
</style>
