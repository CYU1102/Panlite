import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { resolve, join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'

const require = createRequire(import.meta.url)
const { metadata, sha256 } = require('./benchmark-report.cjs')
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, process.argv[2] || 'output/upgrade-20261025/file-table-smoke')
if (!output.startsWith(join(root, 'output') + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('File table smoke output must remain under the workspace output directory')
const fixtureDirectory = join(output, 'fixture')
await mkdir(fixtureDirectory, { recursive: true })
const temporary = await mkdtemp(join(tmpdir(), 'panlite-file-table-smoke-'))
if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('panlite-file-table-smoke-')) throw new Error('Unsafe fixture cleanup directory')

function sampleFiles() {
  return Array.from({ length: 100_000 }, (_, index) => ({ id: String(index + 1), name: `file-${index + 1}.txt`, accountId: 'synthetic',
    platform: 'quark', parentId: '0', isDir: false, size: index + 1, createdAt: 1700000000000, updatedAt: 1700000000000 }))
}
const sampleSha256 = sha256(JSON.stringify(sampleFiles()))
const source = metadata(root, { rows: 100000, pageSizes: [100, 200], viewports: [[1280, 800], [960, 800]], sampleSha256 },
  ['src/renderer/components/FileTable.vue', 'src/renderer/pages/FileManager.vue', 'src/renderer/styles/tokens.css', 'scripts/smoke-file-table.mjs'])
await writeFile(join(fixtureDirectory, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>PanLite isolated file table smoke</title><div id="app"></div><script type="module" src="./entry.js"></script></html>')
await writeFile(join(fixtureDirectory, 'entry.js'), `import {createApp,h,shallowRef,nextTick} from 'vue';
import FileTable from '/src/renderer/components/FileTable.vue';
import {getPlatformCapabilities} from '/src/shared/capabilities.ts';
import '/src/renderer/styles/tokens.css';
const style=document.createElement('style');style.textContent='html,body{height:100%;margin:0;overflow:hidden}body{box-sizing:border-box;padding:16px;font:14px Segoe UI,Microsoft YaHei,sans-serif;background:var(--pl-page-bg)}#app{height:100%;display:flex;flex-direction:column;gap:12px}.fixture-title{flex:0 0 auto;height:36px;display:flex;align-items:center;color:var(--pl-text)}.fixture-card{flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid var(--pl-border);border-radius:12px;overflow:hidden}.fixture-card>.file-table-wrapper{flex:1;min-height:0;height:auto}.fixture-footer{flex:0 0 auto;height:32px;background:var(--pl-surface-subtle);color:var(--pl-text-muted);display:flex;align-items:center;padding:0 12px}';document.head.append(style);
const files=(${sampleFiles.toString()})();const selection=shallowRef([]);let previewed=null;
const settle=async()=>{await nextTick();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))};
const started=performance.now();
createApp({setup(){return()=>[h('header',{class:'fixture-title'},'文件列表 · 100000 项隔离合成样本'),h('section',{class:'fixture-card'},[h(FileTable,{files,capabilities:getPlatformCapabilities('quark'),selectedFiles:selection.value,selectionContext:'synthetic:root',onSelectionChange:rows=>selection.value=rows,onPreview:file=>previewed=file.id}),h('footer',{class:'fixture-footer'},'合成目录，不连接真实网盘')])]}}).mount('#app');
window.fileTableFixture={ready:false,settle,selectedCount:()=>selection.value.length,previewed:()=>previewed};settle().then(()=>Object.assign(window.fileTableFixture,{ready:true,mountMs:performance.now()-started}));`)

async function electronFixture(options) {
  const { app, BrowserWindow } = require('electron')
  const fs = require('node:fs')
  const path = require('node:path')
  const trace = message => fs.appendFileSync(path.join(options.output, 'runtime.log'), `${new Date().toISOString()} ${message}\n`)
  app.setPath('userData', options.profile)
  app.disableHardwareAcceleration()
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  await app.whenReady()
  trace('Electron ready; creating hidden fixture window')
  const window = new BrowserWindow({ show: false, frame: false, useContentSize: true, width: 1280, height: 800,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('console-message', (_event, ...details) => trace(`Renderer: ${typeof details[0] === 'object' ? details[0]?.message : details[1]}`))
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).origin !== options.origin }))
  const execute = code => window.webContents.executeJavaScript(code)
  const loadStarted = performance.now()
  let report
  try {
    trace(`Loading ${options.url}`)
    await window.loadURL(options.url)
    trace('Page loaded; waiting for actual FileTable mount')
    await execute(`new Promise((resolve,reject)=>{const started=performance.now();const timer=setInterval(()=>{if(window.fileTableFixture?.ready){clearInterval(timer);resolve(true)}else if(performance.now()-started>60000){clearInterval(timer);reject(Error('File table fixture did not mount'))}},30)})`)
    const initial = await execute(`({mountMs:window.fileTableFixture.mountMs,usedJsHeapBytes:performance.memory?.usedJSHeapSize??null})`)
    trace('Actual FileTable ready')
    const loadFirstScreenWallMs = performance.now() - loadStarted
    const views = []
    for (const width of [1280, 960]) {
      window.setContentSize(width, 800)
      trace(`Verifying ${width}px viewport`)
      await execute(`(async()=>{const select=document.querySelector('[aria-label="每页文件数量"]');select.value='100';select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[aria-label="文件首页"]').click();await window.fileTableFixture.settle()})()`)
      const geometry = await execute(`(()=>{const rect=selector=>{const box=document.querySelector(selector).getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom}};return{viewport:{width:innerWidth,height:innerHeight},table:rect('.el-table'),body:rect('.el-table__body-wrapper'),pager:rect('.file-table-pagination'),documentOverflow:document.documentElement.scrollWidth>innerWidth,rows:document.querySelectorAll('.el-table__body tbody tr').length}})()`)
      check(geometry.rows === 100, 'Actual table DOM exceeded the 100 row page')
      check(geometry.pager.x >= 0 && geometry.pager.right <= width + 1 && geometry.pager.bottom <= 801 && geometry.pager.y >= 0, 'Pagination is outside the visible viewport')
      check(geometry.body.height > 100 && geometry.table.bottom <= geometry.pager.y + 1 && !geometry.documentOverflow, 'Table body overlaps pagination or overflows the viewport')
      const navigation = await execute(`(async()=>{const start=performance.now();document.querySelector('[aria-label="文件末页"]').click();await window.fileTableFixture.settle();const flipMs=performance.now()-start;const button=document.querySelector('button.file-name-open[title="file-100000.txt"]');if(!button)throw Error('Tail file is absent');button.scrollIntoView({block:'nearest',inline:'nearest'});await window.fileTableFixture.settle();const bounds=button.getBoundingClientRect(),body=document.querySelector('.el-table__body-wrapper').getBoundingClientRect();const visible=bounds.y>=body.y-1&&bounds.bottom<=body.bottom+1&&bounds.x>=0&&bounds.right<=innerWidth;button.click();await window.fileTableFixture.settle();return{flipMs,tailVisible:visible,previewed:window.fileTableFixture.previewed(),rows:document.querySelectorAll('.el-table__body tbody tr').length,usedJsHeapBytes:performance.memory?.usedJSHeapSize??null}})()`)
      check(navigation.tailVisible && navigation.previewed === '100000' && navigation.rows === 100, 'Tail file is not visible/openable on the final page')
      // capturePage can precede the hidden compositor's latest frame commit.
      await new Promise(resolvePaint => setTimeout(resolvePaint, 300))
      await fs.promises.writeFile(path.join(options.output, `file-table-${width}.png`), (await window.webContents.capturePage()).toPNG())
      const twoHundred = await execute(`(async()=>{const start=performance.now();const select=document.querySelector('[aria-label="每页文件数量"]');select.value='200';select.dispatchEvent(new Event('change',{bubbles:true}));await window.fileTableFixture.settle();return{changePageSizeMs:performance.now()-start,rows:document.querySelectorAll('.el-table__body tbody tr').length}})()`)
      check(twoHundred.rows === 200, 'Actual table DOM exceeded the 200 row page')
      views.push({ width, geometry, navigation, twoHundred })
    }
    const allSelection = await execute(`(async()=>{const start=performance.now();document.querySelector('.page-selection-scope button').click();await window.fileTableFixture.settle();const result={selectAllMs:performance.now()-start,count:window.fileTableFixture.selectedCount(),rows:document.querySelectorAll('.el-table__body tbody tr').length,usedJsHeapBytes:performance.memory?.usedJSHeapSize??null};document.querySelectorAll('.page-selection-scope button')[1].click();await window.fileTableFixture.settle();return{...result,clearedCount:window.fileTableFixture.selectedCount()}})()`)
    check(allSelection.count === 100000 && allSelection.rows === 200 && allSelection.clearedCount === 0, 'Full-range selection shrank to the current page or did not clear')
    check(!window.isVisible(), 'File table smoke unexpectedly showed a window')
    report = { passed: true, hiddenWindowVerified: true, actualVueAndElementPlus: true, syntheticOnly: true, network: 'only this fixture localhost origin permitted',
      electron: process.versions.electron, chromium: process.versions.chrome, initial, loadFirstScreenWallMs, totalScenarioWallMs: performance.now() - loadStarted, views, allSelection,
      memory: app.getAppMetrics().map(item => ({ type: item.type, memory: item.memory })),
      limits: ['Single run per viewport; machine load and caches are uncontrolled. Isolated Vite production component fixture, not packaged application startup.', 'mountMs excludes module loading and sample allocation; page timings include Vue update and two animation frames.', 'JS heap is a nonstandard Chromium byte snapshot, not peak memory. Other memory fields are raw Electron MemoryInfo; process memory includes fixture/runtime overhead.', 'Synthetic FileTable only; backend latency, real accounts and full FileManager rendering are not measured.'] }
  } catch (error) {
    report = { passed: false, error: String(error), hiddenWindowVerified: !window.isVisible() }
    await fs.promises.writeFile(path.join(options.output, 'runtime.json'), JSON.stringify(report, null, 2) + '\n')
    trace(`Failure: ${error}`)
    await fs.promises.writeFile(path.join(options.output, 'failure.png'), (await window.webContents.capturePage()).toPNG())
  }
  await fs.promises.writeFile(path.join(options.output, 'runtime.json'), JSON.stringify(report, null, 2) + '\n')
  app.exit(report.passed ? 0 : 1)
}

const built = join(fixtureDirectory, 'built')
await build({ root, configFile: false, base: './', cacheDir: join(temporary, 'vite-cache'),
  plugins: [vue(), Components({ dirs: [], dts: false, resolvers: [ElementPlusResolver({ importStyle: 'css' })] })],
  resolve: { alias: { '@shared': join(root, 'src/shared') } }, build: { outDir: built, emptyOutDir: true, rollupOptions: { input: join(fixtureDirectory, 'index.html') } }, logLevel: 'error' })
const server = createServer(async (request, response) => {
  try {
    const file = resolve(built, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname))
    if (!file.startsWith(built + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Outside fixture')
    const bytes = await readFile(file)
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
    response.end(bytes)
  } catch { response.writeHead(404); response.end() }
})
try {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  console.log('File table Vite production fixture is ready; testing the hidden Chromium window')
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  const index = (await readdir(built, { recursive: true })).find(file => file.endsWith('index.html'))
  if (!index) throw new Error('Built fixture HTML is missing')
  const url = `${origin}/${index.replaceAll('\\', '/')}`
  const entry = join(temporary, 'main.cjs')
  await writeFile(entry, `(${electronFixture.toString()})(${JSON.stringify({ origin, url, profile: join(temporary, 'profile'), output })}).catch(error=>{console.error(error);require('electron').app.exit(1)})`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.VITE_DEV_SERVER_URL
  await new Promise((resolveRun, reject) => {
    const child = spawn(require('electron'), [entry], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostics = ''
    const collect = chunk => { diagnostics = (diagnostics + chunk).slice(-32000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const timer = setTimeout(() => { child.kill(); reject(new Error('File table hidden smoke timed out')) }, 120000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolveRun(); else reject(new Error(`File table hidden smoke exited ${code}: ${diagnostics}`)) })
  })
  const runtime = JSON.parse(await readFile(join(output, 'runtime.json'), 'utf8'))
  await writeFile(join(output, 'report.json'), JSON.stringify({ schema: 1, benchmark: 'actual-file-table', createdAt: new Date().toISOString(), ...source, sampleSha256, ...runtime }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, output, mountMs: runtime.initial.mountMs, viewports: runtime.views.map(row => row.width), selectedAll: runtime.allSelection.count }))
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
