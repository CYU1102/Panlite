import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb, getAccountById } from '../db'
import { getAdapter } from '../../adapters/registry'
import { dbAccountToDriveAccount } from '../ipc/account-mapping'
import { downloadPreviewSource } from '../preview-download'
import { assertPathInside, type FilePreviewService, type FilePreviewDownloadContext } from '../file-preview'
import type { IpcRegistrar } from '../ipc/types'
import type { AiCitation } from '../../shared/ai-types'
import { AI_CITATION_PREVIEW_CHANNELS, subtitleTimeRange, type AiCitationPreviewInput, type AiCitationPreviewResult } from '../../shared/ai-citation-preview'

interface CitationDocument {
  id: string; name: string; sha256: string; source_path: string | null
  source_account_id: string | null; source_file_id: string | null; size: number
}
interface CitationChunk {
  id: string; document_id: string; content: string; page_number: number | null; section: string | null
  start_seconds?: number | null; end_seconds?: number | null
}
export interface CitationPreviewDependencies {
  database: Database.Database
  previews: FilePreviewService
  downloadCloud?: (document: CitationDocument, context: FilePreviewDownloadContext) => Promise<string>
}

export async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of fs.createReadStream(filePath)) hash.update(bytes)
  return hash.digest('hex')
}

function trustedCitation(database: Database.Database, input: AiCitationPreviewInput): { document: CitationDocument; citation: AiCitation; content: string } {
  if (!input || typeof input.documentId !== 'string' || !input.citation || input.documentId !== input.citation.documentId) throw new Error('引用文档信息无效')
  const document = database.prepare('SELECT id, name, sha256, source_path, source_account_id, source_file_id, size FROM ai_documents WHERE id = ?').get(input.documentId) as CitationDocument | undefined
  if (!document) throw new Error('引用文档已经被删除')
  if (!/^[a-f0-9]{64}$/i.test(document.sha256)) throw new Error('文档缺少可验证的原件版本，请重新导入')
  if (input.citation.sourceSha256 && input.citation.sourceSha256 !== document.sha256) throw new Error('文档已重新解析为新版本，请重新提问后查看引用')
  const quote = String(input.citation.quote || '')
  if (!quote.trim() || quote.length > 10_000) throw new Error('引用原文无效')
  const rows = input.citation.chunkId
    ? database.prepare('SELECT * FROM ai_document_chunks WHERE document_id = ? AND id = ?').all(document.id, input.citation.chunkId)
    : database.prepare('SELECT * FROM ai_document_chunks WHERE document_id = ? AND instr(content, ?) > 0 ORDER BY chunk_index').all(document.id, quote)
  const matches = (rows as CitationChunk[]).filter(row => row.content.includes(quote)
    && (input.citation.pageNumber == null || input.citation.pageNumber === row.page_number)
    && (input.citation.section == null || input.citation.section === row.section))
  if (!matches.length) throw new Error('引用与当前索引不符，请重新提问；原文可能已经变化')
  // Legacy citations lack a stable ID. Ambiguous source positions must never be guessed.
  if (matches.length > 1 && matches.some(row => row.page_number !== matches[0].page_number || row.section !== matches[0].section)) throw new Error('旧引用对应多个位置，请重新提问后定位')
  const chunk = matches[0]
  const legacy = subtitleTimeRange(chunk.section || undefined)
  const startSeconds = chunk.start_seconds != null && Number.isFinite(chunk.start_seconds) && chunk.start_seconds >= 0 ? chunk.start_seconds : legacy.startSeconds
  const endSeconds = chunk.end_seconds != null && Number.isFinite(chunk.end_seconds) && chunk.end_seconds >= (startSeconds || 0) ? chunk.end_seconds : legacy.endSeconds
  return {
    document, content: chunk.content,
    citation: { documentId: document.id, documentName: document.name, chunkId: chunk.id, sourceSha256: document.sha256,
      pageNumber: chunk.page_number || undefined, section: chunk.section || undefined, quote, startSeconds, endSeconds },
  }
}

export async function prepareAiCitationPreview(input: AiCitationPreviewInput, dependencies: CitationPreviewDependencies): Promise<AiCitationPreviewResult> {
  let sessionId: string | undefined
  try {
    const { document, citation, content } = trustedCitation(dependencies.database, input)
    const preview = await dependencies.previews.createSession({
      accountId: document.source_account_id || 'ai-local', fileId: document.source_file_id || document.id,
      fileName: document.name, fileSize: document.size,
    }, async (_request, context) => {
      let localPath: string
      if (document.source_path && fs.existsSync(document.source_path)) {
        const source = fs.realpathSync(document.source_path)
        const sourceStat = fs.statSync(source)
        if (!sourceStat.isFile()) throw new Error('原件路径不是文件')
        if (sourceStat.size > context.maxBytes) throw new Error('原件超过预览大小限制')
        localPath = path.join(context.directory, context.fileName)
        // Serve a verified snapshot, so editing the source after this check cannot change the preview.
        await fs.promises.copyFile(source, localPath)
      } else if (document.source_account_id && document.source_file_id && dependencies.downloadCloud) {
        localPath = await dependencies.downloadCloud(document, context)
      } else throw new Error('原件已移动或删除，请恢复原位置或重新导入文件')
      const safePath = assertPathInside(fs.realpathSync(context.directory), fs.realpathSync(localPath))
      const stat = fs.statSync(safePath)
      if (!stat.isFile() || stat.size > context.maxBytes) throw new Error('原件超过预览大小限制')
      if (await fileSha256(safePath) !== document.sha256) throw new Error('原件内容已经变化，与这条引用的版本不同；请重新导入并提问')
      return { success: true, localPath: safePath }
    })
    sessionId = preview.sessionId
    if (preview.kind === 'pdf') preview.content = content
    // Text citations can lie far beyond the ordinary preview prefix.
    if (['text', 'markdown', 'office'].includes(preview.kind)) {
      preview.content = content
      preview.truncated = false
      preview.notice = '显示已验证原件对应的完整引用片段'
    }
    return { success: true, preview, citation }
  } catch (error) {
    if (sessionId) dependencies.previews.cleanupSession(sessionId)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function downloadCloud(document: CitationDocument, context: FilePreviewDownloadContext): Promise<string> {
  const row = getAccountById(document.source_account_id!)
  if (!row) throw new Error('原件缓存已清理且原网盘账号已删除，请重新导入文件')
  const account = dbAccountToDriveAccount(row)
  const adapter = getAdapter(account.platform)
  const result = adapter.getDownloadSource
    ? await downloadPreviewSource(await adapter.getDownloadSource(account, document.source_file_id!), context)
    : adapter.download ? await adapter.download(account, document.source_file_id!, context.directory, { fileName: context.fileName }) : null
  if (!result?.success || !result.localPath) throw new Error(result?.error || '无法重新取得网盘原件，请检查账号或重新导入')
  return result.localPath
}

export function registerAiCitationPreviewIpc(ipc: IpcRegistrar, previews: FilePreviewService): void {
  const owners = new Map<string, number>()
  ipc.handle(AI_CITATION_PREVIEW_CHANNELS.create, async (event, input: AiCitationPreviewInput) => {
    const result = await prepareAiCitationPreview(input, { database: getDb(), previews, downloadCloud })
    if (result.preview) {
      if (event.sender.isDestroyed()) { previews.cleanupSession(result.preview.sessionId); return { success: false, error: '窗口已关闭' } }
      for (const id of owners.keys()) if (!previews.getSession(id)) owners.delete(id)
      owners.set(result.preview.sessionId, event.sender.id)
    }
    return result
  })
  ipc.handle(AI_CITATION_PREVIEW_CHANNELS.cleanup, (event, sessionId: string) => {
    if (owners.get(sessionId) !== event.sender.id) return { success: false, error: '预览会话不存在' }
    owners.delete(sessionId)
    previews.cleanupSession(sessionId)
    return { success: true }
  })
}
