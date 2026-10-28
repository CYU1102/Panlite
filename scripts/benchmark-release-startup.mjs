/** Compare untouched NSIS application payloads on ONE disposable hosted Windows
 * runner. Never install either application and never run this on a user's PC.
 * Local validation: node scripts/benchmark-release-startup.mjs --check
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { finished } from 'node:stream/promises'
import { performance } from 'node:perf_hooks'

const BASELINE_SHA256 = '810297db7e0bbe788e1fffe3f48e40be2d583c2b8f45bc860cd0a180575f41bc'
const BASELINE_REVISION = '0ed304fd1eb86d2e888349146a7d944330a0e0d9'
const require = createRequire(import.meta.url)
const optionNames = new Set(['baseline-installer', 'baseline-sha256', 'candidate-installer', 'candidate-sha256', 'candidate-manifest', 'output'])
const protocol = Object.freeze({ version: 'release-startup-trace-v2', candidateTraceSchema: 1, rendererVisualTimingSchema: 1, warmupRoundsPerVersion: 2, measuredPairs: 20, pairOrder: 'AB for odd pairs, BA for even pairs', profile: 'new empty directory per launch', theme: 'light', windowWidth: 1280, launchTimeoutMs: 45000, osCache: 'not flushed', performanceThresholdGate: false })
const traceEvents = ['prepare.start', 'prepare.complete', 'window.received', 'window.configured', 'load.finished', 'ready.query.start', 'ready.query.end', 'ready', 'visual.start', 'visual.end', 'delay.start', 'delay.end', 'capture.start', 'capture.end', 'png.encode.start', 'png.encode.end', 'png.write.start', 'png.write.end', 'report.write.start']
const traceStageEvents = { prepare: ['prepare.start', 'prepare.complete'], mainInitialization: ['prepare.complete', 'window.received'], readyQuery: ['ready.query.start', 'ready.query.end'], visual: ['visual.start', 'visual.end'], settleDelay: ['delay.start', 'delay.end'], capture: ['capture.start', 'capture.end'], pngEncode: ['png.encode.start', 'png.encode.end'], pngWrite: ['png.write.start', 'png.write.end'], reportWrite: ['report.write.start', 'report.write.end'] }
const traceStages = Object.keys(traceStageEvents)

function argumentsFor(args) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const name = args[index].replace(/^--/, '')
    if (args[index] === '--check' || args[index] === '--visibility-comparison') {
      if (options[name]) throw new Error(`Duplicate --${name}`)
      options[name] = true; continue
    }
    if (!args[index].startsWith('--') || !optionNames.has(name) || options[name] !== undefined) throw new Error(`Unknown or duplicate option: ${args[index]}`)
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`--${name} needs a value`)
    options[name] = args[++index]
  }
  if (options.check && args.length !== 1) throw new Error('--check must be used alone')
  return options
}

function assertHostedWindows(environment = process.env, operatingSystem = process.platform) {
  if (operatingSystem !== 'win32' || environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_ENVIRONMENT !== 'github-hosted' || environment.RUNNER_OS !== 'Windows'
    || !environment.RUNNER_TEMP || !environment.GITHUB_WORKSPACE || !/^\d+$/.test(environment.GITHUB_RUN_ID ?? '') || !/^[a-f\d]{40}$/i.test(environment.GITHUB_SHA ?? '')) {
    throw new Error('Execution is restricted to a disposable GitHub-hosted Windows CI runner. Local use permits --check only.')
  }
}

function archivePath(name) {
  const normalized = name.replaceAll('\\', '/').replace(/\/$/, '')
  if (!normalized || normalized.startsWith('/') || normalized.includes(':') || normalized.includes('\0') || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe archive member path')
  return normalized
}

function archiveEntries(listing) {
  const boundary = listing.indexOf('----------')
  if (boundary < 0) throw new Error('7-Zip did not return a technical archive listing')
  return listing.slice(boundary + 10).trim().split(/\r?\n\s*\r?\n/).filter(Boolean).map(block => {
    const fields = Object.fromEntries(block.split(/\r?\n/).map(line => /^([^=]+?) = (.*)$/.exec(line)).filter(Boolean).map(match => [match[1].trim(), match[2]]))
    if (!fields.Path) throw new Error('Archive listing has an unnamed member')
    if (fields['Symbolic Link'] || fields['Hard Link'] || fields.Symlink || /^l/.test(fields.Mode ?? '')) throw new Error('Archive contains a link')
    return { ...fields, safePath: archivePath(fields.Path) }
  })
}

const inside = (parent, child) => { const value = relative(parent, child); return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value)) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const round = value => Math.round(value * 100) / 100

async function fileHash(file) {
  const hash = createHash('sha256'), stream = createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  await finished(stream)
  return hash.digest('hex')
}

function assertOrdinaryTree(directory) {
  assert(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Expected an ordinary owned directory')
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, item.name)
    assert(!lstatSync(file).isSymbolicLink(), 'Owned tree must not contain links or junctions')
    if (item.isDirectory()) assertOrdinaryTree(file)
    else assert(item.isFile(), 'Owned tree has a non-file member')
  }
}

function removeOwned(directory, scratch, tempRoot) {
  const absolute = resolve(directory)
  assert(inside(scratch, absolute), 'Cleanup escaped the owned root')
  assert(realpathSync.native(scratch).toLowerCase() === scratch.toLowerCase() && dirname(scratch).toLowerCase() === tempRoot.toLowerCase() && basename(scratch).startsWith('panlite-release-startup-'), 'Owned cleanup root changed')
  assertOrdinaryTree(absolute)
  assert(inside(scratch, realpathSync.native(absolute)), 'Cleanup identity escaped the owned root')
  rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

function plannedRuns(visibilityComparison = false) {
  const plan = []
  const conditions = visibilityComparison ? ['hidden', 'visible'] : ['baseline', 'candidate']
  const add = (phase, round, condition, index) => plan.push(visibilityComparison
    ? { phase, round, order: index + 1, version: 'candidate', visibility: condition }
    : { phase, round, order: index + 1, version: condition })
  for (let round = 1; round <= protocol.warmupRoundsPerVersion; round++) conditions.forEach((condition, index) => add('warmup', round, condition, index))
  for (let pair = 1; pair <= protocol.measuredPairs; pair++) (pair % 2 ? conditions : [...conditions].reverse()).forEach((condition, index) => add('measured', pair, condition, index))
  return plan
}

// Both experimental conditions use the same launch setting. In the legacy
// comparison retain windowsHide=true for backward-compatible observations.
const launchWindowsHide = run => !run.visibility

function statistics(values) {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
  if (!sorted.length) return { count: 0, medianMs: null, p95Ms: null, maxMs: null }
  return { count: sorted.length, medianMs: round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]), maxMs: round(sorted[sorted.length - 1]) }
}

function validateManifest(manifest, expectedRevision) {
  assert(manifest.version === '0.2.3' && manifest.channel === 'windows-unsigned', 'Expected the unsigned 0.2.3 candidate manifest')
  assert(manifest.releaseEligibleSource === true && manifest.dirty === false && manifest.revision === expectedRevision, 'Candidate source must be the clean commit of this workflow run')
  assert(/^[a-f\d]{64}$/i.test(manifest.sourceSha256 ?? '') && /^[a-f\d]{64}$/i.test(manifest.lockfileSha256 ?? ''), 'Candidate manifest lacks source/lock hashes')
}

function validateTrace(trace, final = false) {
  assert(trace?.schema === 1 && Number.isFinite(trace.originPerformanceMs) && trace.originPerformanceMs >= 0, 'Missing child trace origin/schema')
  assert.equal(trace.clock, 'child performance.now relative to trace origin', 'Trace clock scope changed')
  assert.equal(trace.snapshotPoint, final ? 'before-quit' : 'before-main-report-write', 'Trace snapshot boundary changed')
  assert.equal(trace.postReportSidecar, 'startup.trace.json', 'Unexpected trace sidecar path')
  assert(Array.isArray(trace.events) && trace.events.length >= traceEvents.length, 'Incomplete child trace events')
  const names = new Set()
  for (let index = 0; index < trace.events.length; index++) {
    const event = trace.events[index]
    assert(typeof event.name === 'string' && event.name && !names.has(event.name), 'Duplicate or unnamed child trace event')
    assert(Number.isFinite(event.atMs) && event.atMs >= 0 && (!index || event.atMs >= trace.events[index - 1].atMs), 'Non-monotonic or negative child trace time')
    names.add(event.name)
  }
  for (const name of [...traceEvents, ...(final ? ['report.write.end', 'quit.request'] : [])]) assert(names.has(name), `Missing child trace event: ${name}`)
  assert(trace.validation?.monotonic && trace.validation.nonNegative && trace.validation.uniqueNames && trace.validation.stageOrder, 'Child trace reports invalid timing')
  const eventTimes = new Map(trace.events.map(event => [event.name, event.atMs]))
  for (const name of traceStages) {
    const stage = trace.stages?.[name]
    assert(stage && Number.isFinite(stage.startMs) && stage.startMs >= 0, `Missing child stage: ${name}`)
    assert.equal(stage.startMs, eventTimes.get(traceStageEvents[name][0]), `Child stage start does not match its event: ${name}`)
    if (name === 'reportWrite' && !final) {
      assert(stage.complete === false && stage.endMs === null && stage.durationMs === null, 'Main report must not invent its own write completion')
    } else {
      assert.equal(stage.endMs, eventTimes.get(traceStageEvents[name][1]), `Child stage end does not match its event: ${name}`)
      assert(stage.complete === true && Number.isFinite(stage.endMs) && stage.endMs >= stage.startMs && Number.isFinite(stage.durationMs) && Math.abs(stage.durationMs - (stage.endMs - stage.startMs)) < 0.001, `Invalid child stage duration: ${name}`)
    }
  }
  return trace
}

function validateRendererVisualTiming(timing) {
  assert.equal(timing?.clock, 'renderer performance.now', 'Missing renderer visual timing clock')
  const values = ['started', 'firstFrame', 'secondFrame', 'stylesComplete'].map(name => timing[name])
  assert(values.every((value, index) => Number.isFinite(value) && value >= 0 && (!index || value >= values[index - 1])), 'Invalid renderer visual timestamps')
  return { ...timing, firstFrameWaitMs: values[1] - values[0], secondFrameWaitMs: values[2] - values[1], stylesReadMs: values[3] - values[2] }
}

function staticCheck() {
  assert.throws(() => assertHostedWindows({}, 'win32'))
  assert.throws(() => assertHostedWindows({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }, 'win32'))
  assert.throws(() => argumentsFor(['--unknown', 'x']))
  assert.throws(() => argumentsFor(['--output', 'x', '--output', 'y']))
  for (const name of ['../escape', 'a/../b', '/absolute', 'C:\\escape', 'data:stream', '\\\\host\\share']) assert.throws(() => archivePath(name))
  assert.equal(archivePath('$PLUGINSDIR\\app-64.7z'), '$PLUGINSDIR/app-64.7z')
  assert.equal(archiveEntries('header\n----------\nPath = $PLUGINSDIR/app-64.7z\nSize = 1\n')[0].safePath, '$PLUGINSDIR/app-64.7z')
  const plan = plannedRuns()
  assert.equal(plan.length, 44)
  for (const version of ['baseline', 'candidate']) {
    assert.equal(plan.filter(item => item.phase === 'warmup' && item.version === version).length, 2)
    assert.equal(plan.filter(item => item.phase === 'measured' && item.version === version).length, 20)
  }
  assert.equal(plan.filter(item => item.phase === 'measured' && item.order === 1 && item.version === 'baseline').length, 10)
  const visibilityPlan = plannedRuns(true)
  assert.equal(visibilityPlan.length, 44)
  for (const visibility of ['hidden', 'visible']) {
    assert.equal(visibilityPlan.filter(item => item.phase === 'warmup' && item.visibility === visibility && item.version === 'candidate').length, 2)
    assert.equal(visibilityPlan.filter(item => item.phase === 'measured' && item.visibility === visibility && item.version === 'candidate').length, 20)
  }
  assert.equal(visibilityPlan.filter(item => item.phase === 'measured' && item.order === 1 && item.visibility === 'visible').length, 10)
  assert.equal(launchWindowsHide({ version: 'candidate' }), true)
  assert.equal(launchWindowsHide({ version: 'candidate', visibility: 'hidden' }), false)
  assert.equal(launchWindowsHide({ version: 'candidate', visibility: 'visible' }), false)
  assert.equal(argumentsFor(['--visibility-comparison'])['visibility-comparison'], true)
  assert.throws(() => argumentsFor(['--visibility-comparison', '--visibility-comparison']))
  assert.throws(() => argumentsFor(['--check', '--visibility-comparison']))
  assert.deepEqual(statistics([1, 2, 3, 4]), { count: 4, medianMs: 2.5, p95Ms: 4, maxMs: 4 })
  assert.equal(statistics(Array.from({ length: 20 }, (_, index) => index + 1)).p95Ms, 19)
  const manifest = { version: '0.2.3', channel: 'windows-unsigned', releaseEligibleSource: true, dirty: false, revision: 'a'.repeat(40), sourceSha256: 'b'.repeat(64), lockfileSha256: 'c'.repeat(64) }
  validateManifest(manifest, 'a'.repeat(40))
  assert.throws(() => validateManifest({ ...manifest, dirty: true }, 'a'.repeat(40)))
  assert.throws(() => validateManifest(manifest, 'd'.repeat(40)))
  assert.throws(() => archiveEntries('header\n----------\nPath = linked\nSymbolic Link = elsewhere\n'))
  const staticEventTimes = new Map(traceEvents.map((name, index) => [name, index]))
  const trace = { schema: 1, clock: 'child performance.now relative to trace origin', originPerformanceMs: 100, snapshotPoint: 'before-main-report-write', postReportSidecar: 'startup.trace.json', events: traceEvents.map((name, atMs) => ({ name, atMs })), validation: { monotonic: true, nonNegative: true, uniqueNames: true, stageOrder: true }, stages: Object.fromEntries(Object.entries(traceStageEvents).map(([name, [start, end]]) => [name, { startMs: staticEventTimes.get(start), endMs: name === 'reportWrite' ? null : staticEventTimes.get(end), durationMs: name === 'reportWrite' ? null : staticEventTimes.get(end) - staticEventTimes.get(start), complete: name !== 'reportWrite' }])) }
  validateTrace(trace)
  assert.throws(() => validateTrace({ ...trace, events: [...trace.events, { name: 'prepare.start', atMs: 20 }] }))
  assert.throws(() => validateTrace({ ...trace, events: trace.events.map((event, index) => index === 1 ? { ...event, atMs: -1 } : event) }))
  assert.throws(() => validateTrace({ ...trace, stages: { ...trace.stages, capture: { startMs: 5, endMs: 1, durationMs: -4, complete: true } } }))
  assert.throws(() => validateTrace(trace, true))
  const visualTiming = { clock: 'renderer performance.now', started: 10, firstFrame: 15, secondFrame: 55, stylesComplete: 60 }
  assert.deepEqual(validateRendererVisualTiming(visualTiming), { ...visualTiming, firstFrameWaitMs: 5, secondFrameWaitMs: 40, stylesReadMs: 5 })
  assert.throws(() => validateRendererVisualTiming({ ...visualTiming, secondFrame: 14 }))
  assert.throws(() => validateRendererVisualTiming({ ...visualTiming, firstFrame: null }))
  console.log(JSON.stringify({ staticCheck: 'passed', applicationLaunched: false, archiveExtracted: false, installerExecuted: false, baselineSha256: BASELINE_SHA256, protocol,
    requiredOptions: [...optionNames], extraction: 'Hosted runner full 7z.exe reads NSIS; npm 7zip-bin reads the inner 7z. No installation fallback.',
    scope: 'Release-as-shipped descriptive observation. 0.2.2 benchmark shows its GUI and may resume an empty queue; 0.2.3 benchmark hides its window. Runtime/visibility differences are retained.' }, null, 2))
}

function runArchiveTool(binary, args) {
  const result = spawnSync(binary, args, { windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 24 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`Read-only archive operation failed: ${result.error?.message ?? (result.stderr || result.stdout).slice(-2000)}`)
  return result.stdout
}

function fullSevenZip() {
  const candidates = [process.env.ProgramFiles && join(process.env.ProgramFiles, '7-Zip/7z.exe'), process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], '7-Zip/7z.exe')].filter(Boolean)
  const located = spawnSync('where.exe', ['7z.exe'], { windowsHide: true, encoding: 'utf8' })
  if (located.status === 0) candidates.push(...located.stdout.trim().split(/\r?\n/))
  for (const candidate of candidates) if (isAbsolute(candidate) && existsSync(candidate)) {
    const capabilities = runArchiveTool(candidate, ['i'])
    if (/\bNsis\b/i.test(capabilities)) return candidate
  }
  throw new Error('Hosted Windows runner needs the full 7z.exe with NSIS support. npm 7zip-bin alone cannot read NSIS. No installer will be executed.')
}

async function extractPayload(installer, name, scratch, outerTool, innerTool) {
  const outer = join(scratch, `${name}-nsis`), application = join(scratch, `${name}-application`)
  mkdirSync(outer); mkdirSync(application)
  const listing = archiveEntries(runArchiveTool(outerTool, ['l', '-slt', '-sccUTF-8', installer]))
  const members = listing.filter(item => item.safePath === '$PLUGINSDIR/app-64.7z')
  assert.equal(members.length, 1, 'Expected exactly the NSIS x64 application payload')
  runArchiveTool(outerTool, ['e', '-y', '-bd', `-o${outer}`, installer, members[0].Path])
  const inner = join(outer, 'app-64.7z')
  assert(lstatSync(inner).isFile() && !lstatSync(inner).isSymbolicLink(), 'Inner application archive missing')
  const innerEntries = archiveEntries(runArchiveTool(innerTool, ['l', '-slt', '-sccUTF-8', inner]))
  assert(innerEntries.some(item => item.safePath === 'PanLite.exe') && innerEntries.some(item => item.safePath === 'resources/app.asar'), 'Application payload is incomplete')
  runArchiveTool(innerTool, ['x', '-y', '-bd', `-o${application}`, inner])
  assertOrdinaryTree(application)
  const executable = join(application, 'PanLite.exe'), archive = join(application, 'resources/app.asar')
  const asar = require('@electron/asar')
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  assert.equal(pkg.version, name === 'baseline' ? '0.2.2' : '0.2.3', 'Payload version does not match its role')
  return { executable, version: pkg.version, installerSha256: await fileHash(installer), executableSha256: await fileHash(executable), archiveSha256: await fileHash(archive), innerArchiveSha256: await fileHash(inner), memberCount: innerEntries.length }
}

async function launch(run, payload, output, scratch, tempRoot) {
  const directory = join(output, run.phase, `${String(run.round).padStart(2, '0')}-${run.order}-${run.version}${run.visibility ? `-${run.visibility}` : ''}`)
  mkdirSync(directory, { recursive: true })
  const profile = mkdtempSync(join(scratch, 'profile-'))
  assert.equal(readdirSync(profile).length, 0, 'Every launch must start from an empty profile')
  const rawFile = join(directory, 'startup.json'), env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('PANLITE_')) delete env[key]
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
  Object.assign(env, { PANLITE_BENCHMARK_USER_DATA: profile, PANLITE_BENCHMARK_OUTPUT: rawFile, PANLITE_BENCHMARK_THEME: protocol.theme, PANLITE_BENCHMARK_WIDTH: String(protocol.windowWidth) })
  const started = performance.now()
  let firstStdoutMs = null, reportObservedMs = null, exitMs = null, diagnostics = '', child, exited = false, closed = false, timer, launchFailure
  const processRecord = { ...run, applicationVersion: payload.version, completed: false, freshProfile: true, profileRemoved: false }
  const observer = watch(directory, () => {
    if (reportObservedMs !== null) return
    try { const raw = JSON.parse(readFileSync(rawFile, 'utf8')); if (raw.renderer?.textLength) reportObservedMs = performance.now() - started } catch { /* Observe only complete JSON. */ }
  })
  try {
    await new Promise((resolveLaunch, reject) => {
      child = spawn(payload.executable, ['--benchmark-startup', ...(run.visibility === 'visible' ? ['--benchmark-visible'] : [])], { cwd: dirname(payload.executable), env, windowsHide: launchWindowsHide(run), stdio: ['ignore', 'pipe', 'pipe'] })
      const collect = chunk => { diagnostics = (diagnostics + chunk).slice(-128000) }
      child.stdout.on('data', chunk => { firstStdoutMs ??= performance.now() - started; collect(chunk) })
      child.stderr.on('data', collect)
      timer = setTimeout(() => {
        processRecord.timedOut = true
        reject(new Error('Application benchmark timed out; shutdown is bounded independently of stdio close'))
      }, protocol.launchTimeoutMs)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { exited = true; exitMs = performance.now() - started })
      child.once('close', code => { closed = true; clearTimeout(timer); if (code !== 0) reject(new Error(`Application exited with code ${code}`)); else resolveLaunch() })
    })
    const raw = JSON.parse(readFileSync(rawFile, 'utf8'))
    assert(!raw.error && raw.renderer?.textLength > 0 && raw.version === payload.version, 'Invalid application startup report')
    assert(Number.isFinite(raw.readyMs) && Number.isFinite(raw.renderer.firstScreenMs), 'Missing startup durations')
    let childTrace = null, rendererVisualTiming = null
    if (run.version === 'candidate') {
      assert.equal(raw.hiddenAtVerification, run.visibility !== 'visible', 'Candidate window visibility differs from the selected mode')
      validateTrace(raw.trace)
      childTrace = validateTrace(JSON.parse(readFileSync(join(directory, 'startup.trace.json'), 'utf8')), true)
      assert.equal(childTrace.originPerformanceMs, raw.trace.originPerformanceMs, 'Trace sidecar uses a different clock origin')
      assert.deepEqual(childTrace.events.slice(0, raw.trace.events.length), raw.trace.events, 'Trace sidecar changed already-recorded events')
      rendererVisualTiming = validateRendererVisualTiming(raw.visual?.rendererVisualTiming)
      if (run.visibility) {
        assert.equal(raw.benchmarkVisibleRequested, run.visibility === 'visible', 'Application did not receive the selected visibility argument')
        assert.equal(raw.windowVisibleAtCreation, run.visibility === 'visible', 'Initial window visibility differs from the selected mode')
        assert.equal(raw.windowVisibleAtVisualStart, run.visibility === 'visible', 'Visual-check window visibility differs from the selected mode')
        assert(['visible', 'hidden'].includes(raw.renderer.visibilityState) && typeof raw.renderer.hasFocus === 'boolean', 'Renderer visibility/focus at ready is missing')
        assert(['visible', 'hidden'].includes(rendererVisualTiming.visibilityAtStart) && ['visible', 'hidden'].includes(rendererVisualTiming.visibilityAtEnd), 'Renderer visual visibility is missing')
      }
    }
    assert(existsSync(join(directory, 'startup.png')), 'Application did not preserve its screenshot')
    Object.assign(processRecord, { completed: true, rawReport: relative(output, rawFile).replaceAll('\\', '/'),
      firstScreenMs: raw.renderer.firstScreenMs, readyMs: raw.readyMs, processWallMs: round(exitMs), firstStdoutMs: firstStdoutMs === null ? null : round(firstStdoutMs),
      reportObservedMs: reportObservedMs === null ? null : round(reportObservedMs), postReportObservationToExitMs: reportObservedMs !== null && exitMs >= reportObservedMs ? round(exitMs - reportObservedMs) : null,
      route: raw.renderer.route, firstContentfulPaintMs: raw.renderer.firstContentfulPaintMs ?? null,
      childTrace, rendererVisualTiming, runtime: { electron: raw.electron ?? null, node: raw.node ?? null, moduleAbi: raw.moduleAbi ?? null, chrome: raw.chrome ?? null },
      hiddenAtVerification: raw.hiddenAtVerification ?? null, benchmarkVisibleRequested: raw.benchmarkVisibleRequested ?? null, windowVisibleAtCreation: raw.windowVisibleAtCreation ?? null,
      windowVisibleAtVisualStart: raw.windowVisibleAtVisualStart ?? null, visibilityAtReady: raw.renderer.visibilityState ?? null,
      hasFocusAtReady: raw.renderer.hasFocus ?? null, freshProfile: true })
    writeFileSync(join(directory, 'process.json'), JSON.stringify(processRecord, null, 2) + '\n')
  } catch (error) {
    processRecord.error = error instanceof Error ? error.message : String(error)
    launchFailure = error
  } finally {
    clearTimeout(timer)
    observer.close()
    writeFileSync(join(directory, 'process.log'), diagnostics)
    if (child && !closed) {
      // A dead parent can leave inherited stdio handles open in descendants.
      // Never wait forever for close, or target a PID already known to be dead.
      if (!exited && Number.isInteger(child.pid)) {
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
        processRecord.treeTermination = { attempted: true, status: killed.status, error: killed.error?.message ?? null }
      } else processRecord.treeTermination = { attempted: false, reason: 'Main process already exited; no live parent PID to address descendants safely.' }
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref()
      processRecord.inheritedPipesClosed = true
    }
    try {
      removeOwned(profile, scratch, tempRoot)
      processRecord.profileRemoved = true
    } catch (error) {
      processRecord.completed = false
      processRecord.cleanupError = error instanceof Error ? error.message : String(error)
      launchFailure ??= error
    } finally {
      writeFileSync(join(directory, 'process.json'), JSON.stringify(processRecord, null, 2) + '\n')
    }
  }
  if (launchFailure) throw launchFailure
  return processRecord
}

async function main(options) {
  assertHostedWindows()
  const visibilityComparison = options['visibility-comparison'] === true
  for (const name of optionNames) assert(options[name], `Missing --${name}`)
  assert.equal(options['baseline-sha256'].toLowerCase(), BASELINE_SHA256, 'Only the explicitly pinned published 0.2.2 baseline is supported')
  assert(/^[a-f\d]{64}$/i.test(options['candidate-sha256']), 'Candidate SHA-256 is required from the same-run installation report')
  const baselineInstaller = realpathSync.native(resolve(options['baseline-installer'])), candidateInstaller = realpathSync.native(resolve(options['candidate-installer'])), manifestFile = realpathSync.native(resolve(options['candidate-manifest']))
  assert.equal(await fileHash(baselineInstaller), BASELINE_SHA256, 'Published baseline installer checksum mismatch')
  assert.equal(await fileHash(candidateInstaller), options['candidate-sha256'].toLowerCase(), 'Same-run candidate installer checksum mismatch')
  const manifestBytes = readFileSync(manifestFile), manifest = JSON.parse(manifestBytes.toString('utf8'))
  validateManifest(manifest, process.env.GITHUB_SHA)
  const output = resolve(options.output)
  assert(!existsSync(output) || readdirSync(output).length === 0, 'Output must be new or empty; prior performance data will never be overwritten')
  mkdirSync(output, { recursive: true })
  const tempRoot = realpathSync.native(process.env.RUNNER_TEMP)
  assert(lstatSync(tempRoot).isDirectory(), 'RUNNER_TEMP is not a directory')
  const scratch = realpathSync.native(mkdtempSync(join(tempRoot, 'panlite-release-startup-')))
  assert(dirname(scratch).toLowerCase() === tempRoot.toLowerCase(), 'Scratch escaped RUNNER_TEMP')
  assert(!inside(scratch, output), 'Reports must survive scratch cleanup')
  const report = { schema: 1, benchmark: visibilityComparison ? 'candidate-window-visibility-startup' : 'release-as-shipped-startup', recordedAt: new Date().toISOString(),
    protocol: visibilityComparison ? { ...protocol, version: 'candidate-window-visibility-v1', conditions: ['hidden', 'visible'], candidatePayloadIdentical: true } : protocol,
    scope: visibilityComparison ? 'Same candidate payload and runtime on one disposable runner; only benchmark window visibility is selected. Not a normal user startup or cold-cache measurement.' : 'Descriptive comparison of untouched installer application payloads on the same CI VM. Legacy GUI visibility, queue startup and bundled runtime differ; this is not a like-for-like configuration or a cold-cache benchmark.',
    performanceThresholdGate: false, taskCancellationReviewClosed: false,
    ci: { repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, revision: process.env.GITHUB_SHA, runnerImage: process.env.ImageOS, runnerImageVersion: process.env.ImageVersion },
    environment: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), harnessNode: process.version },
    sourceBinding: { baselineRelease: 'v0.2.2', baselineReleaseRevision: BASELINE_REVISION, baselineInstallerSha256: BASELINE_SHA256, candidateExpectedInstallerSha256: options['candidate-sha256'].toLowerCase(), candidateManifestSha256: digest(manifestBytes), candidateRevision: manifest.revision, candidateSourceSha256: manifest.sourceSha256, candidateLockfileSha256: manifest.lockfileSha256, sameWorkflowRunCandidateReceipt: 'Expected candidate installer SHA is supplied by the consuming job from this run\'s installation acceptance report; manifest revision must equal GITHUB_SHA.' },
    configurationDifferences: visibilityComparison ? { hidden: 'Candidate benchmark creates a hidden window.', visible: 'The same candidate benchmark explicitly creates a visible window on the hosted runner.', shared: 'Both use empty profiles, the same runtime, disabled benchmark background throttling and skip queue/background startup.' } : { baseline: '0.2.2 benchmark creates a normal GUI in the disposable remote runner and calls queue recovery; every launch has a new empty profile with no accounts or queued work.', candidate: '0.2.3 benchmark creates a hidden window and skips queue/background startup.', bundledRuntime: 'Actual Electron/Node versions are preserved per sample; differing runtimes are part of the shipped releases.' },
    samples: [], completed: false, temporaryDirectoryRemoved: false,
  }
  writeFileSync(join(output, 'protocol.json'), JSON.stringify({ ...report, plan: plannedRuns(visibilityComparison) }, null, 2) + '\n')
  let failure
  try {
    const outerTool = fullSevenZip(), innerTool = require('7zip-bin').path7za
    report.archiveTools = { nsis: outerTool, application7z: innerTool }
    const payloads = { ...(visibilityComparison ? {} : { baseline: await extractPayload(baselineInstaller, 'baseline', scratch, outerTool, innerTool) }), candidate: await extractPayload(candidateInstaller, 'candidate', scratch, outerTool, innerTool) }
    report.payloads = Object.fromEntries(Object.entries(payloads).map(([key, { executable: _executable, ...identity }]) => [key, identity]))
    for (const run of plannedRuns(visibilityComparison)) {
      const sample = await launch(run, payloads[run.version], output, scratch, tempRoot)
      sample.profileRemoved = true
      report.samples.push(sample)
      writeFileSync(join(output, 'progress.json'), JSON.stringify(report, null, 2) + '\n')
      console.log(`${run.phase} ${run.round} ${run.visibility ?? run.version}: first screen ${sample.firstScreenMs.toFixed(1)}ms; process ${sample.processWallMs.toFixed(1)}ms`)
    }
    const metrics = ['firstScreenMs', 'readyMs', 'processWallMs', 'reportObservedMs', 'postReportObservationToExitMs', ...(visibilityComparison ? ['firstContentfulPaintMs'] : [])]
    const conditions = visibilityComparison ? ['hidden', 'visible'] : ['baseline', 'candidate']
    report.statistics = Object.fromEntries(conditions.map(condition => [condition, Object.fromEntries(metrics.map(metric => [metric, statistics(report.samples.filter(sample => sample.phase === 'measured' && (visibilityComparison ? sample.visibility === condition : sample.version === condition)).map(sample => sample[metric]))]))]))
    const tracedSamples = report.samples.filter(sample => sample.phase === 'measured' && sample.version === 'candidate')
    report.childTraceStatistics = Object.fromEntries(traceStages.map(stage => [stage, statistics(tracedSamples.map(sample => sample.childTrace.stages[stage].durationMs))]))
    report.rendererVisualStatistics = Object.fromEntries(['firstFrameWaitMs', 'secondFrameWaitMs', 'stylesReadMs'].map(stage => [stage, statistics(tracedSamples.map(sample => sample.rendererVisualTiming[stage]))]))
    if (visibilityComparison) report.rendererVisualByVisibility = Object.fromEntries(conditions.map(condition => [condition, Object.fromEntries(['firstFrameWaitMs', 'secondFrameWaitMs', 'stylesReadMs'].map(stage => [stage, statistics(tracedSamples.filter(sample => sample.visibility === condition).map(sample => sample.rendererVisualTiming[stage]))]))]))
    report.traceLimits = ['Only the candidate has phase instrumentation; legacy phase times are not synthesized.', 'Child stages share a monotonic origin. Parent observations and renderer marks use separate clocks; renderer visual intervals share their own renderer clock and exclude the main-to-renderer bridge.', 'The sidecar is written once after the main report. Its own write cost is included in parent process exit time and is not self-measured.', 'firstScreenMs is the DOM/double-animation-frame readiness mark. Missing FCP values are preserved, not treated as equivalent visible paint.']
    report.descriptiveDifferences = Object.fromEntries(metrics.map(metric => {
      const before = report.statistics[conditions[0]][metric], after = report.statistics[conditions[1]][metric]
      return [metric, Object.fromEntries(['medianMs', 'p95Ms'].map(percentile => [percentile, before[percentile] !== null && after[percentile] !== null ? { absoluteMs: round(after[percentile] - before[percentile]), percent: before[percentile] > 0 ? round((after[percentile] / before[percentile] - 1) * 100) : null } : null]))]
    }))
    report.interpretation = ['All 40 measured launches are preserved; the four predefined warmup launches are preserved and excluded from aggregate statistics.', 'The same VM runs every launch serially with AB/BA alternation. OS filesystem caches and host load remain uncontrolled.', 'processWallMs includes post-first-screen visual checks, screenshot capture and application exit; it is not user first-screen latency.', 'reportObservedMs is the parent observation of complete JSON after screenshot capture, not an exact child write timestamp. Observation-to-exit may be unavailable.', visibilityComparison ? 'Same candidate payload in each condition; benchmark mode suppresses normal background services. BrowserWindow visibility and renderer visibility/focus are recorded separately and do not prove actual screen presentation.' : 'No like-for-like comparator is modified or overridden. Runtime/GUI/queue differences prevent claiming identical measurement configuration.', 'This collection alone does not close the existing task cancellation or startup tail-latency review, and no new performance pass/fail threshold is imposed.']
    report.completed = true
  } catch (error) { failure = error; report.error = error instanceof Error ? error.message : String(error) }
  finally {
    try {
      removeOwned(scratch, scratch, tempRoot)
      report.temporaryDirectoryRemoved = !existsSync(scratch)
    } catch (error) {
      failure ??= error
      report.completed = false
      report.cleanupError = error instanceof Error ? error.message : String(error)
    }
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  }
  if (failure) throw failure
  console.log(`Release-as-shipped observations saved to ${output}; configuration differences and existing reviews remain explicit.`)
}

try {
  const options = argumentsFor(process.argv.slice(2))
  if (options.check) staticCheck()
  else await main(options)
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
