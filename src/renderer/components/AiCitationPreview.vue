<template>
  <el-dialog :model-value="modelValue" :title="resolvedCitation?.documentName || citation?.documentName || '引用原件'" width="min(1100px, 94vw)" top="4vh" destroy-on-close @close="close">
    <div class="citation-preview">
      <p v-if="loading" role="status">正在核验原件版本并准备引用位置…</p>
      <div v-if="error" role="alert" class="error">{{ error }} <el-button size="small" @click="load">重试</el-button></div>
      <template v-if="preview && resolvedCitation">
        <div class="source-note">原件版本已核验 · {{ resolvedCitation.pageNumber ? `第 ${resolvedCitation.pageNumber} 页` : resolvedCitation.section || '引用片段' }}</div>
        <blockquote>{{ resolvedCitation.quote }}</blockquote>
        <template v-if="preview.kind === 'pdf'">
          <div class="toolbar">
            <button :disabled="pageNumber <= 1 || rendering" @click="setPage(pageNumber - 1)">上一页</button>
            <label>第 <input :value="pageNumber" type="number" min="1" :max="pageCount" aria-label="PDF 页码" @change="setPage(Number(($event.target as HTMLInputElement).value))"> / {{ pageCount }} 页</label>
            <button :disabled="pageNumber >= pageCount || rendering" @click="setPage(pageNumber + 1)">下一页</button>
            <button :disabled="rendering" @click="setPage(resolvedCitation.pageNumber || 1)">返回引用页</button>
          </div>
          <p v-if="pdfNotice" role="status" class="notice">{{ pdfNotice }}</p>
          <div class="pdf-scroll">
            <div class="pdf-page" :style="{ width: `${pageWidth}px`, height: `${pageHeight}px` }">
              <canvas ref="canvas" aria-label="PDF 原件页面" />
              <span v-for="(box, index) in highlights" :key="index" class="highlight" :style="{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }" />
            </div>
          </div>
        </template>
        <template v-else-if="preview.kind === 'video' || preview.kind === 'audio'">
          <component :is="preview.kind" ref="media" class="media" :src="assetUrl" controls preload="metadata" @loadedmetadata="seek" @error="mediaError" />
          <div class="toolbar">
            <button v-if="resolvedCitation.startSeconds !== undefined" @click="seek">跳到 {{ citationTimeLabel(resolvedCitation.startSeconds) }}{{ resolvedCitation.endSeconds !== undefined ? ` – ${citationTimeLabel(resolvedCitation.endSeconds)}` : '' }}</button>
            <label>播放速度 <select v-model.number="playbackRate" @change="applyRate"><option v-for="rate in [0.5, 0.75, 1, 1.25, 1.5, 2]" :key="rate" :value="rate">{{ rate }}×</option></select></label>
          </div>
          <p class="notice">{{ mediaNotice || (resolvedCitation.startSeconds === undefined ? '这份转写没有可靠时间戳，可以播放原件并核对引用文字。' : '已按字幕或转写时间定位；点击播放核对原件。') }}</p>
        </template>
        <img v-else-if="preview.kind === 'image'" :src="assetUrl" :alt="preview.fileName" class="image">
        <pre v-else-if="preview.content" class="text">{{ preview.content }}</pre>
        <p v-else class="notice">此附件暂不支持在引用窗口中展示。以上为索引中的引用原文。</p>
      </template>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFDocumentLoadingTask, type RenderTask } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { AiCitation } from '@shared/ai-types'
import type { FilePreviewSessionDto } from '@shared/file-preview'
import { citationTimeLabel } from '@shared/ai-citation-preview'
import { aiCitationPreviewApi } from '../api/ai-citation-preview'
import { pdfCitationHighlights, pdfCitationMatchCount, type PdfHighlightBox, type PdfTextPosition } from './pdf-citation-highlight'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl
const props = defineProps<{ modelValue: boolean; citation: AiCitation | null }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const preview = ref<FilePreviewSessionDto | null>(null), resolvedCitation = ref<AiCitation | null>(null)
const loading = ref(false), rendering = ref(false), error = ref(''), pdfNotice = ref(''), mediaNotice = ref('')
const pageNumber = ref(1), pageCount = ref(0), pageWidth = ref(0), pageHeight = ref(0), playbackRate = ref(1)
const canvas = ref<HTMLCanvasElement | null>(null), media = ref<HTMLMediaElement | null>(null)
const highlights = ref<PdfHighlightBox[]>([]), pdf = shallowRef<PDFDocumentProxy | null>(null)
let generation = 0, renderGeneration = 0, pdfLoading: PDFDocumentLoadingTask | null = null, renderTask: RenderTask | null = null
const assetUrl = computed(() => {
  try { const url = new URL(preview.value?.assetUrl || ''); return url.protocol === 'panlite-preview:' && url.host === 'session' && !url.search && !url.hash && /^\/[0-9a-f-]{36}$/.test(url.pathname) ? url.href : '' } catch { return '' }
})

watch(() => [props.modelValue, props.citation], () => { if (props.modelValue && props.citation) void load(); else { generation++; void cleanup() } }, { immediate: true })
onBeforeUnmount(() => { generation++; void cleanup() })

async function cleanup(): Promise<void> {
  renderGeneration++
  renderTask?.cancel(); renderTask = null
  if (media.value) { media.value.pause(); media.value.removeAttribute('src'); media.value.load() }
  const task = pdfLoading; pdfLoading = null; pdf.value = null
  const id = preview.value?.sessionId; preview.value = null; resolvedCitation.value = null
  if (task) await task.destroy().catch(() => undefined)
  if (id) await aiCitationPreviewApi.aiCitationPreviewCleanup(id).catch(() => undefined)
}
function close(): void { generation++; emit('update:modelValue', false); void cleanup() }
async function load(): Promise<void> {
  const current = ++generation
  await cleanup()
  if (current !== generation || !props.citation || !props.modelValue) return
  loading.value = true; error.value = ''; pdfNotice.value = ''; mediaNotice.value = ''; highlights.value = []; playbackRate.value = 1
  try {
    const result = await aiCitationPreviewApi.aiCitationPreview({ documentId: props.citation.documentId, citation: props.citation })
    if (current !== generation) { if (result.preview) await aiCitationPreviewApi.aiCitationPreviewCleanup(result.preview.sessionId); return }
    if (!result.success || !result.preview || !result.citation) throw new Error(result.error || '引用预览失败')
    preview.value = result.preview; resolvedCitation.value = result.citation
    if (['pdf', 'image', 'audio', 'video'].includes(result.preview.kind) && !assetUrl.value) throw new Error('原件预览地址无效')
    if (result.preview.kind === 'pdf') {
      const assets = new URL('./pdf-assets/', window.document.baseURI)
      const task = getDocument({ url: assetUrl.value, enableXfa: false, cMapPacked: true,
        cMapUrl: new URL('cmaps/', assets).href, standardFontDataUrl: new URL('standard_fonts/', assets).href,
        wasmUrl: new URL('wasm/', assets).href, useWorkerFetch: false })
      pdfLoading = task
      const document = await task.promise
      if (current !== generation) { await task.destroy(); return }
      pdf.value = document; pageCount.value = document.numPages
      await nextTick()
      await setPage(result.citation.pageNumber || 1)
    }
  } catch (cause) { if (current === generation) error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (current === generation) loading.value = false }
}
async function setPage(value: number): Promise<void> {
  if (!pdf.value || !Number.isFinite(value)) return
  const target = Math.min(pageCount.value, Math.max(1, Math.trunc(value)))
  const current = ++renderGeneration
  renderTask?.cancel(); rendering.value = true; highlights.value = []; pdfNotice.value = ''
  try {
    const page = await pdf.value.getPage(target)
    if (current !== renderGeneration) return
    pageNumber.value = target
    const viewport = page.getViewport({ scale: Math.min(1.6, 930 / page.getViewport({ scale: 1 }).width) })
    pageWidth.value = viewport.width; pageHeight.value = viewport.height
    await nextTick()
    if (!canvas.value || current !== renderGeneration) return
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.value.width = Math.ceil(viewport.width * pixelRatio); canvas.value.height = Math.ceil(viewport.height * pixelRatio)
    canvas.value.style.width = `${viewport.width}px`; canvas.value.style.height = `${viewport.height}px`
    renderTask = page.render({ canvas: canvas.value, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] })
    await renderTask.promise
    const text = await page.getTextContent()
    if (current !== renderGeneration) return
    if (target === (resolvedCitation.value?.pageNumber || 1)) {
      const items = text.items.filter(item => 'str' in item) as PdfTextPosition[]
      const quote = resolvedCitation.value?.quote || '', context = preview.value?.content
      const matches = pdfCitationMatchCount(items, quote, context)
      highlights.value = pdfCitationHighlights(items, quote, viewport, context)
      pdfNotice.value = matches > 1 ? `本页找到 ${matches} 处相同引用，已全部标示，请结合上下文核对。` : highlights.value.length ? '已高亮与引用匹配的原文文字。' : '已定位到引用页；页面没有可匹配文字层或 OCR 文字存在差异，无法精确高亮。'
    }
  } catch (cause) { if (current === renderGeneration) error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (current === renderGeneration) rendering.value = false }
}
function applyRate(): void { if (media.value) media.value.playbackRate = playbackRate.value }
function seek(): void {
  applyRate()
  const element = media.value, start = resolvedCitation.value?.startSeconds
  if (!element || start === undefined) return
  if (Number.isFinite(element.duration) && start > element.duration) { mediaNotice.value = '引用时间超过原件时长，请核对字幕与媒体是否对应。'; return }
  try { element.currentTime = start; mediaNotice.value = '' } catch { mediaNotice.value = '播放器暂时无法跳转，请等待加载后重试。' }
}
function mediaError(): void { mediaNotice.value = '当前浏览器无法播放此原件，请确认编码受支持。' }
</script>

<style scoped>
.citation-preview{min-height:160px;color:var(--pl-text);font-size:13px}.source-note,.notice{color:var(--pl-text-secondary);line-height:1.7}.error{color:var(--pl-danger)}blockquote{margin:12px 0;padding:10px 14px;border-left:3px solid var(--pl-primary);background:var(--pl-surface-subtle);white-space:pre-wrap;max-height:130px;overflow:auto}.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 0}.toolbar button,.toolbar select,.toolbar input{padding:5px 9px;border:1px solid var(--pl-border);border-radius:6px;color:inherit;background:var(--pl-surface)}.toolbar input{width:65px}.toolbar button{cursor:pointer}.toolbar button:disabled{opacity:.45;cursor:default}.pdf-scroll{max-height:65vh;overflow:auto;background:#e8eaed;padding:16px}.pdf-page{position:relative;margin:auto;background:white}.pdf-page canvas{display:block}.highlight{position:absolute;pointer-events:none;background:rgba(255,210,20,.34);outline:1px solid rgba(200,135,0,.5);mix-blend-mode:multiply}.media{display:block;width:100%;max-height:62vh}.image{display:block;max-width:100%;max-height:62vh;margin:auto}.text{white-space:pre-wrap;max-height:60vh;overflow:auto;padding:15px;background:var(--pl-surface-subtle)}
</style>
