import { app, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { StartupBenchmarkTrace } from './startup-benchmark-trace'

/** Opt-in CLI benchmark; uses an isolated profile and never touches user data. */
export function createStartupBenchmark(): { theme?: 'light' | 'dark'; recordWindow: (window: BrowserWindow) => void } | null {
  if (!process.argv.includes('--benchmark-startup')) return null
  const trace = new StartupBenchmarkTrace()
  const profile = process.env.PANLITE_BENCHMARK_USER_DATA
  const output = process.env.PANLITE_BENCHMARK_OUTPUT
  if (!profile || !output) throw new Error('Startup benchmark requires isolated profile and output paths')
  const theme = process.env.PANLITE_BENCHMARK_THEME
  const existingSuite = process.env.PANLITE_BENCHMARK_SUITE === 'existing'
  if (existingSuite) {
    // Cover embedded resource pages without reaching external sites/accounts.
    app.on('web-contents-created', (_event, contents) => {
      contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
    })
  }
  if (theme !== undefined && theme !== 'light' && theme !== 'dark') throw new Error('Benchmark theme must be light or dark')
  const route = process.env.PANLITE_BENCHMARK_ROUTE
  if (route !== undefined && route !== '/files' && route !== '/ai-workspace') {
    throw new Error('Benchmark route must be /files or /ai-workspace')
  }
  const action = process.env.PANLITE_BENCHMARK_ACTION
  if (action !== undefined && action !== 'open-ai-provider' && action !== 'open-ai-tools') {
    throw new Error('Unknown benchmark action')
  }
  if (action && route !== '/ai-workspace') {
    throw new Error('AI benchmark actions require /ai-workspace')
  }
  fs.mkdirSync(profile, { recursive: true })
  app.setPath('userData', path.resolve(profile))
  const startedAt = performance.now()
  trace.mark('prepare.complete')
  const traceSidecar = /\.json$/.test(output) ? output.replace(/\.json$/, '.trace.json') : `${output}.trace.json`
  const snapshot = (snapshotPoint: string) => ({
    ...trace.snapshot(), snapshotPoint, postReportSidecar: path.basename(traceSidecar),
    instrumentation: {
      mainReportSnapshot: 'Taken before main-report JSON serialization and write; reportWrite includes both.',
      sidecarWrite: 'One synchronous sidecar write after the main report; its own duration is not measured and is included in parent observation-to-exit time.',
      clockScope: 'Main-process events share one monotonic clock; renderer marks and parent observations have separate origins.',
    },
  })
  const writeReport = (report: Record<string, unknown>, termination: 'quit' | 'exit') => {
    trace.mark('report.write.start')
    fs.writeFileSync(output, JSON.stringify({ ...report, trace: snapshot('before-main-report-write') }, null, 2) + '\n')
    trace.mark('report.write.end')
    if (termination === 'quit') {
      app.once('before-quit', () => {
        try {
          trace.mark('quit.request')
          fs.writeFileSync(traceSidecar, JSON.stringify(snapshot('before-quit'), null, 2) + '\n')
        } catch (error) {
          console.error('Cannot preserve startup benchmark post-report trace:', error)
          app.exit(1)
        }
      })
    } else {
      // app.exit deliberately skips before-quit; retain that different lifecycle
      // rather than inventing a quit event for the existing-function suite.
      trace.mark('exit.request')
      fs.writeFileSync(traceSidecar, JSON.stringify(snapshot('before-exit'), null, 2) + '\n')
    }
  }
  return {
    theme,
    recordWindow(window) {
      trace.mark('window.received')
      const runtime = { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, moduleAbi: process.versions.modules, chrome: process.versions.chrome }
      if (process.env.PANLITE_BENCHMARK_WIDTH) {
        const width = Number(process.env.PANLITE_BENCHMARK_WIDTH)
        if (!Number.isInteger(width) || width < 960 || width > 1920) throw new Error('Benchmark width must be 960–1920')
        window.setSize(width, 800)
      }
      const windowCreatedMs = performance.now() - startedAt
      trace.mark('window.configured')
      window.webContents.once('did-finish-load', () => {
        trace.mark('load.finished')
        void (async () => {
          // The renderer mark waits for the initial lazy route and two frames.
          trace.mark('ready.query.start')
          const renderer = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const deadline = performance.now() + 30000;
            const timer = setInterval(() => {
              const ready = performance.getEntriesByName('panlite-first-screen')[0];
              if (ready) {
                clearInterval(timer);
                resolve({ firstScreenMs: ready.startTime,
                  firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
                  route: location.hash, textLength: document.querySelector('#app')?.textContent?.trim().length || 0 });
              } else if (performance.now() > deadline) { clearInterval(timer); reject(new Error('Renderer did not reach first screen')); }
            }, 25);
          })`)
          trace.mark('ready.query.end')
          if (!renderer.textLength) throw new Error('Renderer produced an empty screen')
          const readyMs = performance.now() - startedAt
          trace.mark('ready')
          if (existingSuite) {
            const { verifyExistingRoutes } = await import('./existing-function-smoke')
            const verification = await verifyExistingRoutes(window, output)
            fs.mkdirSync(path.dirname(output), { recursive: true })
            writeReport({ ...runtime, readyMs, renderer, hiddenAtVerification: !window.isVisible(), mainProcessMemory: process.memoryUsage(), ...verification }, 'exit')
            app.exit(verification.passed ? 0 : 1)
            return
          }
          if (route) {
            await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
              location.hash = ${JSON.stringify(`#${route}`)};
              const deadline = performance.now() + 30000;
              const selector = ${JSON.stringify(route === '/ai-workspace' ? '.ai-workspace' : '.file-manager')};
              const timer = setInterval(() => {
                if (document.querySelector(selector)) { clearInterval(timer); resolve(true); }
                else if (performance.now() > deadline) { clearInterval(timer); reject(new Error('Benchmark route did not render')); }
              }, 25);
            })`)
          }
          if (action === 'open-ai-provider') {
            await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
              const button = [...document.querySelectorAll('.header-actions button')]
                .find(item => item.textContent?.includes('模型设置'));
              if (!button) { reject(new Error('AI model settings button was not found')); return; }
              button.click();
              const deadline = performance.now() + 10000;
              const timer = setInterval(() => {
                if (document.querySelector('.provider-manager')) { clearInterval(timer); resolve(true); }
                else if (performance.now() > deadline) { clearInterval(timer); reject(new Error('AI provider dialog did not open')); }
              }, 25);
            })`)
          }
          let processingPolicy: unknown
          if (action === 'open-ai-tools') {
            const localToolsConfig = process.env.PANLITE_BENCHMARK_TOOLS_CONFIG
              ? JSON.parse(process.env.PANLITE_BENCHMARK_TOOLS_CONFIG) : null
            const importFixtures = process.env.PANLITE_BENCHMARK_IMPORT_FIXTURES
              ? JSON.parse(process.env.PANLITE_BENCHMARK_IMPORT_FIXTURES) : []
            processingPolicy = await window.webContents.executeJavaScript(`(async () => {
              const api = window.electronAPI;
              const initial = await api.aiProcessingPolicyGet();
              if (!initial.success || initial.policy.allowModelFallback || initial.policy.useSemanticIndex) throw new Error('Automatic model use is enabled by default');
              const enabled = await api.aiProcessingPolicySave({ allowModelFallback: true, useSemanticIndex: false });
              const readBack = await api.aiProcessingPolicyGet();
              if (!enabled.success || !readBack.policy.allowModelFallback || readBack.policy.useSemanticIndex) throw new Error('Processing policy did not persist');
              const invalid = await api.aiProcessingPolicySave({ allowModelFallback: 'false', useSemanticIndex: false });
              if (invalid.success) throw new Error('Processing policy accepts invalid switches');
              const restored = await api.aiProcessingPolicySave({ allowModelFallback: false, useSemanticIndex: false });
              if (!restored.success) throw new Error('Cannot restore default processing policy');
              const toolConfig = ${JSON.stringify(localToolsConfig)};
              let localOcrReady = null;
              if (toolConfig) {
                const saved = await api.aiLocalToolsSave(toolConfig);
                localOcrReady = saved.success && ['tesseract', 'pdftoppm'].every(key => saved.tools?.some(tool => tool.key === key && tool.ready));
                if (!localOcrReady) throw new Error('Configured local OCR tools are not ready: ' + JSON.stringify(saved.tools));
              }
              const imports = [];
              for (const fixture of ${JSON.stringify(importFixtures)}) {
                const imported = await api.aiImportFiles([{ localPath: fixture.localPath }]);
                const document = imported.documents?.[0];
                if (!imported.success || document?.status !== 'ready' || !document.contentPreview?.includes(fixture.includes)) {
                  throw new Error('Packaged fixture import failed: ' + JSON.stringify(imported));
                }
                imports.push({ name: document.name, status: document.status, expectedTextPresent: true });
              }
              const button = [...document.querySelectorAll('.header-actions button')].find(item => item.textContent?.includes('本地能力'));
              if (!button) throw new Error('Local tools button was not found');
              button.click();
              await new Promise((resolve, reject) => {
                const deadline = performance.now() + 15000;
                const timer = setInterval(() => {
                  const switches = [...document.querySelectorAll('.processing-policy input[type=checkbox]')];
                  if (switches.length === 2 && switches.every(input => !input.disabled)) {
                    clearInterval(timer);
                    if (switches.some(input => input.checked)) reject(new Error('Model policy switches do not reflect saved defaults'));
                    else resolve(true);
                  } else if (performance.now() > deadline) { clearInterval(timer); reject(new Error('Local tools policy did not load')); }
                }, 25);
              });
              return { defaultsDisabled: true, persisted: true, invalidWriteRejected: true, localOcrReady, imports };
            })()`)
          }
          trace.mark('visual.start')
          const visual = await window.webContents.executeJavaScript(`(async () => {
            const started = performance.now();
            let firstFrame;
            await new Promise(resolve => requestAnimationFrame(() => {
              firstFrame = performance.now();
              requestAnimationFrame(resolve);
            }));
            const secondFrame = performance.now();
            const style = selector => {
              const element = document.querySelector(selector);
              return element ? getComputedStyle(element) : null;
            };
            const bar = document.querySelector('.topbar');
            const provider = document.querySelector('.provider-manager');
            const footer = provider?.closest('.el-dialog')?.querySelector('.el-dialog__footer');
            const footerRect = footer?.getBoundingClientRect();
            const tools = document.querySelector('.processing-policy')?.closest('.el-dialog');
            const toolsFooter = tools?.querySelector('.el-dialog__footer')?.getBoundingClientRect();
            const result = { theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
              header: style('.topbar-wrapper')?.backgroundColor, statusChip: style('.status-chip')?.backgroundColor,
              aiPage: style('.ai-workspace')?.backgroundColor ?? null,
              providerSidebar: style('.provider-manager > aside')?.backgroundColor ?? null,
              providerForm: style('.provider-form')?.backgroundColor ?? null,
              providerFooterVisible: footerRect ? footerRect.top >= 0 && footerRect.bottom <= innerHeight : null,
              providerHorizontalOverflow: provider ? provider.scrollWidth > provider.clientWidth + 1 : false,
              localToolsFooterVisible: toolsFooter ? toolsFooter.top >= 0 && toolsFooter.bottom <= innerHeight : null,
              localToolsGeometry: tools ? { height: tools.getBoundingClientRect().height,
                footerBottom: toolsFooter?.bottom, viewportHeight: innerHeight,
                bodyMaxHeight: getComputedStyle(tools.querySelector('.el-dialog__body')).maxHeight } : null,
              localToolsHorizontalOverflow: tools ? tools.scrollWidth > tools.clientWidth + 1 : false,
              topbarOverflow: bar ? bar.scrollWidth > bar.clientWidth + 1 : false };
            const stylesComplete = performance.now();
            result.rendererVisualTiming = { clock: 'renderer performance.now', started, firstFrame, secondFrame, stylesComplete };
            return result;
          })()`)
          trace.mark('visual.end')
          if (theme && visual.theme !== theme) throw new Error('Requested benchmark theme was not applied')
          if (visual.theme === 'dark') {
            const surfaces = [visual.header, visual.statusChip, visual.aiPage, visual.providerSidebar, visual.providerForm]
              .filter((color: string | null): color is string => Boolean(color))
            for (const color of surfaces) {
              const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) || []
              if (channels.length !== 3 || channels.some((value: number) => value > 100)) throw new Error(`Bright surface in dark shell: ${color}`)
            }
          }
          if (visual.topbarOverflow) throw new Error('File toolbar overflows the window')
          if (action === 'open-ai-tools' && (!visual.localToolsFooterVisible || visual.localToolsHorizontalOverflow)) {
            fs.mkdirSync(path.dirname(output), { recursive: true })
            fs.writeFileSync(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG())
            throw new Error(`Local tools dialog overflows the window: ${JSON.stringify(visual.localToolsGeometry)}`)
          }
          if (visual.providerFooterVisible === false) throw new Error('AI provider actions are outside the visible window')
          if (visual.providerHorizontalOverflow) throw new Error('AI provider form overflows horizontally')
          visual.menuBarVisible = window.isMenuBarVisible()
          if (process.platform === 'win32' && visual.menuBarVisible) throw new Error('Default application menu is visible')
          fs.mkdirSync(path.dirname(output), { recursive: true })
          // Let Chromium commit the navigated route and teleported dialog to
          // the compositor before capturePage reads the frame.
          trace.mark('delay.start')
          await new Promise(resolve => setTimeout(resolve, 350))
          trace.mark('delay.end')
          trace.mark('capture.start')
          const screenshot = await window.webContents.capturePage()
          trace.mark('capture.end')
          trace.mark('png.encode.start')
          const png = screenshot.toPNG()
          trace.mark('png.encode.end')
          trace.mark('png.write.start')
          fs.writeFileSync(output.replace(/\.json$/, '.png'), png)
          trace.mark('png.write.end')
          writeReport({ ...runtime,
            platform: process.platform, windowCreatedMs, readyMs, renderer, visual, processingPolicy,
            hiddenAtVerification: !window.isVisible(), mainProcessMemory: process.memoryUsage() }, 'quit')
          app.quit()
        })().catch(error => {
          try {
            trace.mark('error')
            fs.mkdirSync(path.dirname(output), { recursive: true })
            fs.writeFileSync(output, JSON.stringify({ error: String(error), trace: snapshot('error') }, null, 2) + '\n')
          } finally { app.exit(1) }
        })
      })
    },
  }
}
