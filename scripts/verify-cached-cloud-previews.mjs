import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const manifestPath = process.argv[2]
if (!manifestPath) throw new Error('Pass a manifest of explicitly authorized, already downloaded cloud samples')
const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'))
if (!Array.isArray(manifest.samples) || !manifest.samples.length || manifest.samples.length > 12) throw new Error('Expected 1–12 explicit samples')
const output = path.join(root, 'output/quark-cached-preview-acceptance')
fs.mkdirSync(output, { recursive: true })
const bundle = path.join(output, 'preview.cjs')
await build({ stdin: { contents: "export { FilePreviewService } from './src/main/file-preview'", resolveDir: root, loader: 'ts' },
  outfile: bundle, bundle: true, packages: 'external', platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{ name: 'offline-preview', setup(bundler) {
    bundler.onResolve({ filter: /^(\.\.\/db|\.\/ai-provider|electron-log)$/ }, ({ path: imported }) => ({ path: imported, namespace: 'offline' }))
    bundler.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path: imported }) => {
      if (imported === '../db') return { contents: 'export function getSetting(){return undefined} export function setSetting(){throw new Error("User settings writes forbidden")}' }
      if (imported === 'electron-log') return { contents: 'export default {info(){},warn(){},error(){},debug(){}}' }
      return { contents: 'function blocked(){globalThis.__blockedPreviewCalls++;throw new Error("Online model forbidden")} export const extractTextFromVisualFile=blocked; export const transcribeMediaFile=blocked; export function getAiProviderConfig(){return {type:"openai-compatible",baseUrl:"https://offline.invalid",model:"blocked"}}' }
    })
  } }],
})
globalThis.__blockedPreviewCalls = 0
globalThis.fetch = () => { globalThis.__blockedPreviewCalls++; throw new Error('Network forbidden for cached-file preview acceptance') }
const { FilePreviewService } = createRequire(import.meta.url)(bundle)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-cached-preview-'))
if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('panlite-cached-preview-')) throw new Error('Unexpected cleanup target')
const service = new FilePreviewService({ tempRoot: temp, maxDownloadBytes: 10 * 1024 * 1024 })
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const results = []
try {
  for (const sample of manifest.samples) {
    if (!/^[a-z\d_-]{1,50}$/i.test(sample.id)) throw new Error('Invalid sample ID')
    const source = path.resolve(sample.path), stat = fs.statSync(source)
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('Sample exceeds the accepted file limit')
    const before = digest(source)
    let dto
    try {
      dto = await service.createSession({ accountId: 'authorized-cache', platform: 'quark', fileId: sample.id,
        fileName: sample.originalName || path.basename(source), size: stat.size }, async (_request, context) => {
        const target = path.join(context.directory, context.fileName)
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
        return { success: true, localPath: target }
      })
      const content = dto.content || ''
      let utf8TextEqual
      if (['text', 'markdown'].includes(dto.kind)) {
        try { utf8TextEqual = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(source)) === content }
        catch { /* Other supported encodings need a separate independent reference. */ }
      }
      const managedPath = service.getSessionFilePath(dto.sessionId)
      const cacheSha256 = digest(managedPath)
      const removed = service.cleanupSession(dto.sessionId)
      results.push({ id: sample.id, extension: path.extname(source), kind: dto.kind,
        passed: removed && before === cacheSha256 && (dto.kind === 'archive' ? Boolean(dto.archive) : Boolean(content)),
        contentCharacters: [...content].length, contentSha256: crypto.createHash('sha256').update(content).digest('hex'),
        truncated: dto.truncated || false, utf8TextEqual,
        archive: dto.archive ? { fileCount: dto.archive.fileCount, totalSize: dto.archive.totalSize,
          isEncrypted: dto.archive.isEncrypted, format: dto.archive.format,
          listedEntries: dto.archive.files.length,
          listingSha256: crypto.createHash('sha256').update(JSON.stringify(dto.archive.files
            .map(entry => [entry.path, entry.size, entry.isDir]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest('hex') } : undefined,
        sampleSha256: before, downloadedCacheByteExact: before === cacheSha256,
        sessionRemoved: !service.getSession(dto.sessionId), managedCopyRemoved: !fs.existsSync(managedPath),
        originalUnchanged: before === digest(source) })
    } catch (error) {
      results.push({ id: sample.id, passed: false, errorType: error.name, originalUnchanged: before === digest(source) })
    } finally { if (dto) service.cleanupSession(dto.sessionId) }
  }
} finally {
  service.cleanupAll()
  fs.rmSync(temp, { recursive: true, force: true })
}
const report = { createdAt: new Date().toISOString(),
  scope: 'Production FilePreviewService receives explicit local copies of files already downloaded from the authorized cloud account. Cloud transfer was verified separately; this is not an additional cloud request or a complete visible UI interaction test.',
  onlineModelOrNetworkCalls: globalThis.__blockedPreviewCalls, userInputOperations: 0, results }
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ samples: results.length, passed: results.filter(item => item.passed).length, blockedCalls: globalThis.__blockedPreviewCalls }))
if (results.some(item => !item.passed || !item.originalUnchanged) || globalThis.__blockedPreviewCalls) process.exitCode = 1
