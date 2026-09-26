import { app, BrowserWindow, ipcMain, protocol } from 'electron'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { FilePreviewService } from '../../src/main/file-preview'
import { handlePreviewCors } from '../../src/main/preview-cors'
import { prepareAiCitationPreview } from '../../src/main/ai/citation-preview'
import { DocumentWorkflowStore, exportWorkflowMarkdown } from '../../src/main/ai/document-workflow-store'
import { DocumentWorkflowRuntime } from '../../src/main/ai/document-workflow-runtime'
import { AI_WORKFLOW_CHANNELS } from '../../src/shared/ai-workflow'

const profile = process.env.PANLITE_AI_SMOKE_PROFILE!, output = process.env.PANLITE_AI_SMOKE_OUTPUT!, devUrl = process.env.VITE_DEV_SERVER_URL || '', renderer = process.env.PANLITE_AI_SMOKE_RENDERER || ''
if (!profile || !output || (!devUrl && !renderer)) throw new Error('Isolated AI smoke paths are required')
app.setPath('userData', profile)
protocol.registerSchemesAsPrivileged([{ scheme: 'panlite-preview', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }])

function pdfFixture(): Buffer {
  const streams = ['BT /F1 20 Tf 40 220 Td (Opening page) Tj ET', 'BT /F1 20 Tf 40 220 Td (Annual budget: 42) Tj ET']
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', ...streams.map(stream => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)]
  let value = '%PDF-1.4\n'; const offsets: number[] = []
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(value)
  return Buffer.from(value + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}
function audioFixture(): Buffer {
  const samples = 16000 * 20, wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index++) wav.writeInt16LE(Math.round(Math.sin(index / 16000 * Math.PI * 440 * 2) * 1000), 44 + index * 2)
  return wav
}

app.whenReady().then(async () => {
  const database = new Database(':memory:')
  database.exec(`CREATE TABLE ai_documents(id TEXT PRIMARY KEY,name TEXT,sha256 TEXT,source_path TEXT,source_account_id TEXT,source_file_id TEXT,size INTEGER,status TEXT,parse_coverage TEXT);
    CREATE TABLE ai_document_chunks(id TEXT PRIMARY KEY,document_id TEXT,chunk_index INTEGER,content TEXT,page_number INTEGER,section TEXT,start_seconds REAL,end_seconds REAL);`)
  const now = Date.now(), documents: Record<string, unknown>[] = []
  for (const [id, name, bytes, texts] of [['pdf', '合同.pdf', pdfFixture(), ['Opening page', 'Annual budget: 42']], ['audio', '会议.wav', audioFixture(), ['预算42万元，将在下周交付。']]] as const) {
    const source = path.join(profile, name); fs.writeFileSync(source, bytes)
    const hash = createHash('sha256').update(bytes).digest('hex')
    database.prepare('INSERT INTO ai_documents VALUES(?,?,?,?,?,?,?,?,?)').run(id, name, hash, source, null, null, bytes.length, 'ready', JSON.stringify({ version: 1, sourceComplete: true, partial: false, unit: 'sections', sourceUnits: texts.length, parsedUnits: texts.length, warnings: [] }))
    texts.forEach((text, index) => database.prepare('INSERT INTO ai_document_chunks VALUES(?,?,?,?,?,?,?,?)').run(`${id}-${index}`, id, index, text, id === 'pdf' ? index + 1 : null, id === 'pdf' ? `第 ${index + 1} 页` : '字幕 · 00:00:12.500 → 00:00:15.000', id === 'audio' ? 12.5 : null, id === 'audio' ? 15 : null))
    documents.push({ id, name, sourceType: 'local', sourcePath: source, extension: name.split('.').pop(), size: bytes.length, sha256: hash, status: 'ready', createdAt: now, updatedAt: now })
  }
  const store = new DocumentWorkflowStore(database)
  let modelCalls = 0
  const runtime = new DocumentWorkflowRuntime(store, async (_system, user) => {
    modelCalls++
    const input = JSON.parse(user), last = input.untrustedContent[input.untrustedContent.length - 1]
    return JSON.stringify({ summary: last.text, citations: [{ chunkId: last.chunkId, quote: last.text }] })
  })
  const previews = new FilePreviewService({ tempRoot: path.join(profile, 'previews') })
  const liveSessions = new Set<string>()
  let cleanedSessions = 0
  const requests: Array<{ origin: string; status: number }> = []
  protocol.handle('panlite-preview', async request => {
    const response = await handlePreviewCors(request, value => previews.handleRequest(value), devUrl || undefined, renderer ? path.join(renderer, 'index.html') : undefined)
    requests.push({ origin: request.headers.get('origin') || '', status: response.status }); return response
  })
  ipcMain.handle('fixture:documents', () => ({ success: true, documents }))
  ipcMain.handle('ai:citation-preview', async (_event, input) => { const result = await prepareAiCitationPreview(input, { database, previews }); if (result.preview) liveSessions.add(result.preview.sessionId); return result })
  ipcMain.handle('ai:citation-preview-cleanup', (_event, id) => { const success = previews.cleanupSession(id); if (success) cleanedSessions++; liveSessions.delete(id); return { success } })
  const actions: Record<string, (...args: any[]) => unknown> = { list: () => store.list(), get: id => store.get(id), start: input => runtime.start(input), resume: id => runtime.resume(id), cancel: id => runtime.cancel(id), templates: () => store.templates(), saveTemplate: input => store.saveTemplate(input), deleteTemplate: id => store.deleteTemplate(id) }
  for (const [name, channel] of Object.entries(AI_WORKFLOW_CHANNELS)) if (name !== 'export') ipcMain.handle(channel, async (_event, ...args) => {
    try { return { success: true, data: await actions[name](...args) } } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(AI_WORKFLOW_CHANNELS.export, (_event, id, format) => {
    const result = store.get(id), filePath = path.join(output, format === 'json' ? 'result.json' : 'result.md')
    fs.writeFileSync(filePath, format === 'json' ? JSON.stringify(result, null, 2) : exportWorkflowMarkdown(result)); return { success: true, filePath }
  })
  const win = new BrowserWindow({ width: 1350, height: 1050, show: false, webPreferences: { preload: path.join(output, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  win.webContents.setFrameRate(30)
  const errors: string[] = []
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  const evaluate = <T>(source: string): Promise<T> => win.webContents.executeJavaScript(source)
  const waitFor = async (condition: string, label: string) => {
    const until = Date.now() + 15000
    while (Date.now() < until) { if (await evaluate<boolean>(condition)) return; await new Promise(resolve => setTimeout(resolve, 100)) }
    throw new Error(`Timed out: ${label}; ${await evaluate('document.body.innerText')}; console=${errors.join('|')}`)
  }
  const click = (label: string) => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)}); if (!button) throw new Error('Missing button'); button.click(); })()`)
  const loadWorkspace = () => renderer ? win.loadFile(path.join(renderer, 'index.html'), { hash: '/ai-workspace' }) : win.loadURL(`${devUrl}/__ai-smoke`)
  try {
    await loadWorkspace()
    await waitFor("document.querySelectorAll('.workspace-tabs button').length === 5", 'workspace tabs')
    await waitFor("document.querySelectorAll('.capability-grid article').length === 6", 'capability cards')
    fs.writeFileSync(path.join(output, 'overview-light.png'), (await win.webContents.capturePage()).toPNG())
    await evaluate("document.documentElement.classList.add('dark')")
    await new Promise(resolve => setTimeout(resolve, 150))
    fs.writeFileSync(path.join(output, 'overview-dark.png'), (await win.webContents.capturePage()).toPNG())
    await evaluate("document.documentElement.classList.remove('dark')")
    await new Promise(resolve => setTimeout(resolve, 150))
    if (modelCalls !== 0) throw new Error('Viewing workspace started model work')
    await click('全文处理'); await waitFor("document.querySelectorAll('.document-choice input').length === 2", 'document choices')
    await evaluate("document.querySelector('.document-choice input[value=pdf]').click()")
    await click('开始完整处理')
    await waitFor("document.querySelector('progress')?.value === 2", 'PDF complete workflow')
    await click('合同.pdf · 第 2 页')
    await waitFor("document.querySelectorAll('.citation-preview .highlight').length > 0", 'PDF canvas source highlight')
    const pdf = await evaluate<{ page: number; highlights: number; width: number }>("({page: Number(document.querySelector('[aria-label=\"PDF 页码\"]').value), highlights: document.querySelectorAll('.highlight').length, width: document.querySelector('.pdf-page canvas').width})")
    if (pdf.page !== 2 || pdf.width <= 0) throw new Error('PDF page not rendered')
    await new Promise(resolve => setTimeout(resolve, 400))
    fs.writeFileSync(path.join(output, 'pdf-dom.json'), JSON.stringify(await evaluate("[...document.querySelectorAll('.el-overlay,.el-dialog')].map(element => ({className:element.className,rect:element.getBoundingClientRect().toJSON(),display:getComputedStyle(element).display,visibility:getComputedStyle(element).visibility,opacity:getComputedStyle(element).opacity,position:getComputedStyle(element).position}))"), null, 2))
    fs.writeFileSync(path.join(output, 'pdf.png'), (await win.webContents.capturePage()).toPNG())
    await evaluate("document.querySelector('.el-dialog__headerbtn').click()")
    await waitFor("!document.querySelector('.citation-preview')", 'close original preview')
    await click('导出 JSON')
    await waitFor("document.body.innerText.includes('已导出')", 'structured export')
    await new Promise(resolve => setTimeout(resolve, 400))
    fs.writeFileSync(path.join(output, 'workflow.png'), (await win.webContents.capturePage()).toPNG())
    await evaluate("document.querySelector('.document-choice input[value=pdf]').click()")
    await evaluate("document.querySelector('.document-choice input[value=audio]').click()")
    await click('开始完整处理'); await waitFor("[...document.querySelectorAll('.summary-section')].some(section => section.innerText.includes('预算42万元'))", 'audio workflow')
    await click('会议.wav · 00:12')
    await waitFor("document.querySelector('audio')?.currentTime === 12.5", 'actual media seeking')
    const media = await evaluate<{ currentTime: number; duration: number }>("({currentTime:document.querySelector('audio').currentTime,duration:document.querySelector('audio').duration})")
    await new Promise(resolve => setTimeout(resolve, 400))
    fs.writeFileSync(path.join(output, 'audio.png'), (await win.webContents.capturePage()).toPNG())
    await evaluate("document.querySelector('.el-dialog__headerbtn').click()")
    await waitFor("!document.querySelector('.citation-preview')", 'close audio preview')
    await loadWorkspace(); await waitFor("document.querySelectorAll('.workspace-tabs button').length === 5", 'reopen workspace')
    await click('全文处理'); await waitFor("[...document.querySelectorAll('.summary-section')].some(section => section.innerText.includes('预算42万元'))", 'restore stored workflow')
    const exported = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'))
    if (!exported.result.sections.some((item: { summary: string }) => item.summary.includes('Annual budget: 42'))) throw new Error('Export lost full result')
    if (!requests.some(request => [200, 206].includes(request.status))) throw new Error(`PDF protocol bridge was not exercised: ${JSON.stringify(requests)}`)
    if (liveSessions.size || cleanedSessions !== 2) throw new Error('Closing citation previews did not release both sessions')
    if (errors.length) throw new Error(`Renderer errors: ${errors.join('; ')}`)
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, mode: renderer ? 'production-file' : 'development', pdf, media, modelCalls, persistedRuns: store.list().length, cleanedSessions, requests, errors }, null, 2))
    win.destroy(); previews.cleanupAll(); runtime.dispose(); database.close(); app.exit(0)
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG())
    console.error(error); win.destroy(); previews.cleanupAll(); runtime.dispose(); database.close(); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
