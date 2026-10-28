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
  let ownsFile = false
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const url = new URL(source.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('预览下载地址无效')
    response = await (source.fetch || fetch)(url.href, { headers: source.headers, signal: controller.signal })
    // This is a full-document GET, not a range request. A 206 response must
    // not be mistaken for a complete document or archive.
    if (response.status !== 200 || !response.body) throw new Error('预览文件下载失败')
    const contentLength = response.headers.get('content-length')
    const declaredSize = contentLength === null ? undefined : Number(contentLength)
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(declaredSize))) throw new Error('预览下载长度无效')
    if (declaredSize !== undefined && declaredSize > context.maxBytes) throw new Error('文件超过预览下载大小限制')
    output = await open(localPath, 'wx', 0o600)
    ownsFile = true
    reader = response.body.getReader()
    let total = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > context.maxBytes) throw new Error('下载文件超过预览大小限制')
      await output.writeFile(chunk.value)
    }
    // Fetch may transparently decode compressed responses, so their wire
    // Content-Length does not describe the bytes written to disk.
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
    if (declaredSize !== undefined && (!encoding || encoding === 'identity') && total !== declaredSize) {
      throw new Error('预览文件下载不完整')
    }
    await output.close()
    output = undefined
    return { success: true, localPath }
  } catch (error) {
    controller.abort()
    await reader?.cancel().catch(() => undefined)
    if (!reader) await response?.body?.cancel().catch(() => undefined)
    await output?.close().catch(() => undefined)
    if (ownsFile) await rm(localPath, { force: true }).catch(() => undefined)
    return { success: false, error: error instanceof Error && /超过预览/.test(error.message) ? error.message : '预览文件下载失败，请检查网络或重新登录账号' }
  } finally { clearTimeout(timer) }
}
