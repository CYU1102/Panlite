import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'output/quark-long-page-ocr')
const settings = JSON.parse(fs.readFileSync(path.join(root, 'output/quark-document-acceptance/report.json'), 'utf8'))
const exec = promisify(execFile)
for (const width of [1125, 1500]) {
  const directory = path.join(output, `width-${width}`)
  fs.mkdirSync(directory, { recursive: true })
  const bundle = path.join(directory, 'runner.cjs')
  await build({
    stdin: { contents: "export { recognizePdfPages } from './output/quark-long-page-ocr/experimental-source/local-pdf-ocr'", resolveDir: root, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent',
    plugins: [{ name: 'experimental-width-only', setup(bundler) {
      bundler.onLoad({ filter: /pdf-ocr-tiles\.ts$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8').replace('targetWidth: 1200', `targetWidth: ${width}`), loader: 'ts' }))
    } }],
  })
  const run = async (executable, args, options = {}) => {
    const response = await exec(executable, args, { windowsHide: true, signal: options.signal, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024 })
    return { stdout: response.stdout, stderr: response.stderr }
  }
  const started = Date.now()
  const pages = await createRequire(import.meta.url)(bundle).recognizePdfPages(path.join(root, 'output/quark-live-acceptance/authorized-guide.pdf'), { pdftoppm: settings.toolPaths.pdftoppm, tesseract: settings.toolPaths.tesseract, language: 'chi_sim+eng', run }, undefined, [1])
  fs.writeFileSync(path.join(directory, 'pages.json'), JSON.stringify(pages, null, 2))
  fs.writeFileSync(path.join(directory, 'parser.txt'), pages.map(page => `[Page ${page.pageNumber}]\n${page.content}`).join('\n\n'))
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify({ width, durationMs: Date.now() - started, characters: pages.reduce((sum, page) => sum + [...page.content].length, 0), sourceFileUnmodified: true, productionCodeModifiedForVariant: false, onlineModelsUsed: false }, null, 2))
  process.stdout.write(`${JSON.stringify({ width, durationMs: Date.now() - started })}\n`)
}
