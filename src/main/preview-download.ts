import { open, rm } from 'node:fs/promises'
import path from 'node:path'
import type { FilePreviewDownloadContext, FilePreviewDownloadResult } from './file-preview'
import type { PreviewSource } from './preview-stream'

/** Download document/archive previews with an actual transfer limit, not just a post-download check. */
export async function downloadPreviewSource(source: PreviewSource, context: FilePreviewDownloadContext): Promise<FilePreviewDownloadResult> {
  const localPath = path.join(context.directory, context.fileName)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000)
  timer.unref?.()
  let output: Awaited<ReturnType<typeof open>> | undefined
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const url = new URL(source.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('预览下载地址无效')
    response = await (source.fetch || fetch)(url.href, { headers: source.headers, signal: controller.signal })
    if (!response.ok || !response.body) throw new Error('预览文件下载失败')
    const declaredSize = Number(response.headers.get('content-length'))
    if (declaredSize > context.maxBytes) throw new Error('文件超过预览下载大小限制')
    output = await open(localPath, 'wx', 0o600)
    reader = response.body.getReader()
    let total = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > context.maxBytes) throw new Error('下载文件超过预览大小限制')
      await output.writeFile(chunk.value)
    }
    await output.close()
    output = undefined
    return { success: true, localPath }
  } catch (error) {
    controller.abort()
    await reader?.cancel().catch(() => undefined)
    if (!reader) await response?.body?.cancel().catch(() => undefined)
    await output?.close().catch(() => undefined)
    await rm(localPath, { force: true }).catch(() => undefined)
    return { success: false, error: error instanceof Error && /超过预览/.test(error.message) ? error.message : '预览文件下载失败，请检查网络或重新登录账号' }
  } finally { clearTimeout(timer) }
}
