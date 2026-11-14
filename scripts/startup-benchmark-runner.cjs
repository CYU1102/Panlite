const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

/** Reserve every output before launching anything. Failed and earlier evidence
 * remains intact; the lock only coordinates simultaneous harness invocations. */
async function reserveOutputs(directory, runs) {
  await fs.mkdir(directory, { recursive: true })
  const lock = path.join(directory, '.startup-benchmark.lock')
  const handle = await fs.open(lock, 'wx')
  const outputs = ['startup-benchmark.json']
  for (let index = 1; index <= runs; index++) {
    for (const suffix of ['json', 'png', 'log', 'trace.json']) outputs.push(`startup-${index}.${suffix}`)
  }
  let released = false
  const release = async () => {
    if (released) return
    released = true
    await handle.close()
    await fs.unlink(lock)
  }
  try {
    for (const name of outputs) {
      try { await fs.lstat(path.join(directory, name)) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      throw new Error(`Startup evidence already exists: ${name}; choose a new reports directory`)
    }
  } catch (error) { await release(); throw error }
  return release
}

/** Capture exit at the actual event boundary. Report reads and stdio close can
 * happen later and must not be labelled as child-process lifetime. */
function runProcess(executable, args, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn
  const clock = options.clock ?? (() => performance.now())
  const startedAt = clock()
  return new Promise((resolve, reject) => {
    let child, exitMs = null, settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        child?.stdout?.destroy()
        child?.stderr?.destroy()
        child?.unref()
        reject(error)
      } else resolve(value)
    }
    const timer = setTimeout(() => {
      // A descendant may keep stdio open after exit. Do not signal a PID after
      // we observed its exit: it may already have been reused by the OS.
      const error = new Error(`Startup benchmark timed out after ${options.timeoutMs ?? 45_000} ms`)
      try { if (exitMs === null) child?.kill() }
      catch (terminationError) { error.cause = terminationError }
      finally { finish(error) }
    }, options.timeoutMs ?? 45_000)
    try {
      child = spawnProcess(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) { finish(error); return }
    child.stdout.on('data', chunk => options.onDiagnostics?.(chunk))
    child.stderr.on('data', chunk => options.onDiagnostics?.(chunk))
    child.once('error', error => finish(error))
    child.once('exit', () => { exitMs = clock() - startedAt })
    child.once('close', code => {
      if (code !== 0) { finish(new Error(`Electron exited with code ${code}`)); return }
      if (exitMs === null) { finish(new Error('Child closed without an observed exit event')); return }
      finish(null, { startedAt, processWallMs: exitMs, processCloseMs: clock() - startedAt })
    })
  })
}

module.exports = { reserveOutputs, runProcess }
