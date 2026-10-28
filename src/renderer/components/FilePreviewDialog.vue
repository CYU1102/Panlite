<template>
  <el-dialog
    :model-value="modelValue"
    width="min(1100px, 92vw)"
    top="5vh"
    :title="fileName || '文件预览'"
    :fullscreen="expanded"
    class="file-preview-dialog"
    :close-on-click-modal="false"
    destroy-on-close
    @close="closeDialog"
  >
    <template #header="{ titleId }">
      <div class="preview-heading">
        <div class="preview-heading-title"><span>文件预览</span><h2 :id="titleId" :title="fileName">{{ fileName || '文件预览' }}</h2></div>
        <button class="preview-expand" :aria-label="expanded ? '恢复预览窗口' : '展开预览窗口'" :title="expanded ? '恢复预览窗口' : '展开预览窗口'" :aria-pressed="expanded" @click="expanded = !expanded"><Minimize2 v-if="expanded" :size="17" /><Maximize2 v-else :size="17" /></button>
      </div>
    </template>
    <div class="preview-shell" :class="{ 'is-expanded': expanded }">
      <div v-if="preview && !error && !loading" class="preview-toolbar">
        <span class="preview-format">{{ preview.mimeType }} · {{ formatSize(preview.size) }}</span>
        <div v-if="preview.kind === 'image'" class="image-controls" role="group" aria-label="图片缩放">
          <button :aria-pressed="imageFit" @click="imageFit = true">适应窗口</button>
          <button :aria-pressed="!imageFit && imageScale === 1" @click="setImageScale(1)">原始尺寸</button>
          <button title="缩小图片" aria-label="缩小图片" :disabled="!imageFit && imageScale <= 0.1" @click="zoomImage(-0.25)"><ZoomOut :size="16" /></button>
          <span class="image-scale">{{ imageFit ? '自适应' : `${Math.round(imageScale * 100)}%` }}</span>
          <button title="放大图片" aria-label="放大图片" :disabled="!imageFit && imageScale >= 4" @click="zoomImage(0.25)"><ZoomIn :size="16" /></button>
        </div>
      </div>
      <div v-if="loading" class="preview-state">
        <el-icon class="is-loading"><Loader2 /></el-icon>
        <span>正在连接网盘并准备预览...</span>
      </div>

      <el-result v-else-if="error" icon="error" title="无法预览" :sub-title="error">
        <template #extra>
          <el-button type="primary" @click="loadPreview">重试</el-button>
        </template>
      </el-result>

      <template v-else-if="preview">
        <div v-if="preview.kind === 'office'" class="limit-tip">
          Office 文本预览：显示提取的内容，不保留原文档排版、图表和动画。
          <span v-if="preview.notice">{{ preview.notice }}</span>
        </div>
        <div v-if="preview.truncated" class="limit-tip">
          文本较大，仅显示前 {{ formatSize(maxTextBytes) }}。
        </div>

        <div v-if="preview.kind === 'image'" ref="imageStage" class="media-stage image-stage" :class="{ 'image-fit': imageFit }">
          <div class="image-canvas"><img v-if="safeAssetUrl" :key="preview.sessionId" :src="safeAssetUrl" :alt="preview.fileName" :style="imageStyle" @load="onImageLoad" @error="onAssetError(preview.sessionId)"></div>
        </div>

        <div v-else-if="preview.kind === 'video'" class="media-stage">
          <video v-if="safeAssetUrl" :key="preview.sessionId" ref="mediaElement" :src="safeAssetUrl" controls preload="metadata" playsinline @error="onMediaError" @loadedmetadata="applyPlaybackRate" />
        </div>

        <div v-else-if="preview.kind === 'audio'" class="audio-stage">
          <Music :size="54" />
          <strong>{{ preview.fileName }}</strong>
          <audio v-if="safeAssetUrl" :key="preview.sessionId" ref="mediaElement" :src="safeAssetUrl" controls preload="metadata" @error="onMediaError" @loadedmetadata="applyPlaybackRate" />
        </div>

        <div v-if="preview.kind === 'video' || preview.kind === 'audio'" class="playback-toolbar">
          <label>播放速度
            <select v-model.number="playbackRate" aria-label="播放速度" @change="applyPlaybackRate">
              <option v-for="rate in [0.5, 0.75, 1, 1.25, 1.5, 2]" :key="rate" :value="rate">{{ rate }}×</option>
            </select>
          </label>
          <span>{{ preview.delivery === 'stream' ? '在线按需加载' : '已下载到临时缓存' }} · 播放与拖动进度取决于网盘和浏览器对编码的支持</span>
        </div>

        <div v-if="preview.kind === 'pdf'" class="pdf-stage">
          <object v-if="safeAssetUrl" :data="safeAssetUrl" type="application/pdf">
            <p>当前环境无法显示 PDF。</p>
          </object>
        </div>

        <pre v-else-if="preview.kind === 'text' || preview.kind === 'office'" class="text-preview">{{ preview.content }}</pre>

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
        <span class="preview-meta">{{ preview ? '预览缓存将在关闭后清理' : '在线预览' }}</span>
        <el-button
          v-if="preview?.kind === 'archive' && canOpenArchive"
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
import { Loader2, Music, Maximize2, Minimize2, ZoomIn, ZoomOut } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'
import type { FilePreviewSessionDto, FilePreviewKind, FilePreviewIpcResult } from '@shared/file-preview'

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
  canOpenArchive?: boolean
}>(), {
  fileSize: undefined,
  password: undefined,
  maxTextBytes: 1024 * 1024,
  canOpenArchive: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  openArchive: [payload: { fileId: string; fileName: string }]
}>()

const loading = ref(false)
const error = ref('')
const preview = ref<FilePreviewSessionDto | null>(null)
const mediaElement = ref<HTMLMediaElement | null>(null)
const playbackRate = ref(1)
const expanded = ref(false)
const imageFit = ref(true)
const imageScale = ref(1)
const imageNaturalSize = ref({ width: 0, height: 0 })
const imageStage = ref<HTMLElement | null>(null)
const imageStyle = computed(() => imageFit.value || !imageNaturalSize.value.width
  ? {}
  : { width: `${imageNaturalSize.value.width * imageScale.value}px`, maxWidth: 'none', maxHeight: 'none' })
function onImageLoad(event: Event): void {
  const image = event.currentTarget as HTMLImageElement
  imageNaturalSize.value = { width: image.naturalWidth, height: image.naturalHeight }
}
function setImageScale(value: number): void {
  imageFit.value = false
  imageScale.value = Math.max(0.1, Math.min(4, value))
}
function zoomImage(delta: number): void {
  let current = imageScale.value
  if (imageFit.value && imageStage.value && imageNaturalSize.value.width && imageNaturalSize.value.height) {
    current = Math.min(1, imageStage.value.clientWidth / imageNaturalSize.value.width, imageStage.value.clientHeight / imageNaturalSize.value.height)
  }
  setImageScale(current + delta)
}
let loadGeneration = 0
let pendingPreparationId: string | undefined

const safeAssetUrl = computed(() => {
  const value = preview.value?.assetUrl
  if (!value) return ''
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'panlite-preview:' && parsed.hostname === 'session' && !parsed.username && !parsed.password ? parsed.href : ''
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

watch(() => [props.modelValue, props.accountId, props.fileId, props.fileName, props.fileSize], () => {
  if (props.modelValue) void loadPreview()
  else {
    loadGeneration++
    cancelPendingPreparation()
    loading.value = false
    expanded.value = false
    void cleanupPreview()
  }
}, { immediate: true })

onBeforeUnmount(() => {
  loadGeneration++
  cancelPendingPreparation()
  void cleanupPreview()
})

async function loadPreview(): Promise<void> {
  const generation = ++loadGeneration
  cancelPendingPreparation()
  void cleanupPreview()
  loading.value = false
  error.value = ''
  playbackRate.value = 1
  imageFit.value = true
  imageScale.value = 1
  imageNaturalSize.value = { width: 0, height: 0 }
  if (!props.modelValue) return
  if (!props.accountId || !props.fileId || !props.fileName) {
    error.value = '缺少预览文件信息'
    return
  }

  loading.value = true
  error.value = ''
  const preparationId = crypto.randomUUID()
  pendingPreparationId = preparationId
  try {
    const result = await electronApi.prepareFilePreview(
      props.accountId,
      props.fileId,
      props.fileName,
      props.fileSize,
      preparationId,
    ) as FilePreviewIpcResult
    if (generation !== loadGeneration) {
      if (result.preview?.sessionId) await cleanupSession(result.preview.sessionId)
      return
    }
    if (!result.success || !result.preview) throw new Error(result.error || '准备预览失败')
    preview.value = result.preview
    if (requiresAsset(result.preview.kind) && !safeAssetUrl.value) throw new Error('主进程返回了不安全的预览地址')
  } catch (loadError) {
    if (generation !== loadGeneration) return
    void cleanupPreview()
    error.value = loadError instanceof Error ? loadError.message : String(loadError)
  } finally {
    if (pendingPreparationId === preparationId) pendingPreparationId = undefined
    if (generation === loadGeneration) loading.value = false
  }
}

function cancelPendingPreparation(): void {
  const preparationId = pendingPreparationId
  pendingPreparationId = undefined
  if (preparationId) void electronApi.cancelFilePreview(preparationId).catch(() => undefined)
}

async function cleanupPreview(): Promise<void> {
  stopPlayback()
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
  cancelPendingPreparation()
  loading.value = false
  expanded.value = false
  emit('update:modelValue', false)
  void cleanupPreview()
}

function stopPlayback(): void {
  const media = mediaElement.value
  if (!media) return
  media.pause()
  media.removeAttribute('src')
  media.load()
}

function applyPlaybackRate(): void {
  if (mediaElement.value) mediaElement.value.playbackRate = playbackRate.value
}

function onAssetError(sessionId: string): void {
  if (preview.value?.sessionId !== sessionId) return
  error.value = '图片加载失败，可能是网盘连接中断或图片格式不受支持，请重试。'
  void cleanupPreview()
}

function onMediaError(event: Event): void {
  const media = event.currentTarget as HTMLMediaElement | null
  if (!media || media !== mediaElement.value || !preview.value) return
  const code = media.error?.code
  error.value = code === 3 || code === 4
    ? '当前浏览器无法解码此音视频。文件扩展名不代表编码受支持，可下载后使用本地播放器打开，或转换为受支持的编码。'
    : '音视频加载失败，可能是网盘连接中断、播放链接过期或编码不受支持，请重试。'
  void cleanupPreview()
}

function requiresAsset(kind: FilePreviewKind): boolean {
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
.preview-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-right: 30px; }
.preview-heading-title { min-width: 0; }
.preview-heading-title > span { color: var(--pl-text-muted); font-size: 12px; }
.preview-heading h2 { margin: 3px 0 0; color: var(--pl-text); font-size: 16px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.preview-expand, .image-controls button { display: inline-flex; align-items: center; justify-content: center; min-height: 30px; border: 1px solid var(--pl-border); border-radius: 6px; background: var(--pl-surface); color: var(--pl-text-secondary); cursor: pointer; }
.preview-expand { width: 32px; flex-shrink: 0; }
.preview-expand:hover, .image-controls button:hover { background: var(--pl-hover); color: var(--pl-primary); }
.preview-expand:focus-visible, .image-controls button:focus-visible { outline: 2px solid var(--pl-primary); outline-offset: 2px; }
.preview-shell { min-height: min(360px, max(120px, calc(100vh - 260px))); max-height: max(120px, min(72vh, calc(100vh - 260px))); overflow: auto; }
.preview-shell.is-expanded { min-height: min(360px, max(120px, calc(100vh - 230px))); max-height: max(120px, calc(100vh - 230px)); }
.preview-toolbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
.preview-format { color: var(--pl-text-muted); font-size: 12px; overflow-wrap: anywhere; }
.image-controls { display: flex; align-items: center; gap: 6px; }
.image-controls button { padding: 4px 8px; font-size: 12px; }
.image-controls button[aria-pressed="true"] { background: var(--pl-primary-soft); color: var(--pl-primary); border-color: var(--pl-border-strong); }
.image-controls button:disabled { opacity: .4; cursor: not-allowed; }
.image-scale { min-width: 48px; color: var(--pl-text-muted); font-size: 12px; text-align: center; }
.preview-state { min-height: 360px; display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--pl-text-muted); }
.limit-tip { margin-bottom: 12px; padding: 10px 12px; color: var(--pl-warning); background: var(--pl-warning-soft); border: 1px solid var(--pl-border); border-radius: 8px; font-size: 13px; line-height: 1.6; }
.media-stage { min-height: min(360px, max(120px, calc(100vh - 310px))); display: flex; align-items: center; justify-content: center; background: #111827; border-radius: 10px; overflow: hidden; }
.media-stage video { width: 100%; max-height: max(120px, min(60vh, calc(100vh - 350px))); object-fit: contain; }
.image-stage { min-height: 0; height: max(120px, min(56vh, calc(100vh - 310px))); overflow: auto; display: block; background-color: var(--pl-surface-subtle); background-image: linear-gradient(45deg, var(--pl-hover) 25%, transparent 25%), linear-gradient(-45deg, var(--pl-hover) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--pl-hover) 75%), linear-gradient(-45deg, transparent 75%, var(--pl-hover) 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0; }
.image-canvas { display: flex; align-items: center; justify-content: center; width: max-content; min-width: 100%; min-height: 100%; }
.image-canvas img { display: block; flex-shrink: 0; }
.image-fit .image-canvas { width: 100%; height: 100%; }
.image-fit img { max-width: 100%; max-height: 100%; object-fit: contain; }
.is-expanded .image-stage { height: max(120px, calc(100vh - 275px)); }
.audio-stage { min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; color: var(--pl-text-secondary); background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); border-radius: 10px; padding: 20px; }
.audio-stage > svg { color: var(--pl-primary); }
.audio-stage strong { overflow-wrap: anywhere; text-align: center; }
.audio-stage audio { width: min(620px, 90%); }
.playback-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 0; color: var(--pl-text-secondary); font-size: 12px; }
.playback-toolbar label { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.playback-toolbar select { padding: 5px 8px; border: 1px solid var(--pl-border); border-radius: 6px; background: var(--pl-surface); color: var(--pl-text); }
.pdf-stage object { display: block; width: 100%; height: max(120px, min(60vh, calc(100vh - 310px))); border: 1px solid var(--pl-border); border-radius: 8px; }
.is-expanded .pdf-stage object { height: max(120px, calc(100vh - 275px)); }
.text-preview, .markdown-preview pre { margin: 0; padding: 20px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--pl-text); background: var(--pl-surface-subtle); border: 1px solid var(--pl-border); border-radius: 8px; font: 13px/1.75 Consolas, Monaco, monospace; }
.markdown-preview { padding: 8px 20px 28px; max-width: 860px; margin: 0 auto; color: var(--pl-text); line-height: 1.8; overflow-wrap: anywhere; }
.markdown-preview :deep(a) { color: var(--pl-primary); }
.markdown-preview :deep(code) { padding: 2px 5px; background: var(--pl-hover); border-radius: 4px; font-family: Consolas, Monaco, monospace; }
.markdown-preview pre :deep(code) { padding: 0; color: inherit; background: transparent; }
.markdown-preview blockquote { margin: 12px 0; padding: 4px 14px; color: var(--pl-text-secondary); border-left: 3px solid var(--pl-border-strong); }
.markdown-list-row { display: flex; gap: 9px; margin: 5px 0 5px 16px; }
.markdown-marker { min-width: 22px; color: var(--pl-text-secondary); }
.archive-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 18px; margin-bottom: 14px; color: var(--pl-text-secondary); }
.dialog-footer { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.preview-meta { margin-right: auto; color: var(--pl-text-muted); font-size: 12px; }
@media (max-width: 640px) { .preview-meta { display: none; } .image-controls { flex-wrap: wrap; } .preview-heading { padding-right: 22px; } }
</style>
