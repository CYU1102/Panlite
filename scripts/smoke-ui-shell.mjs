import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const renderer = resolve(root, 'dist/renderer')
const output = join(root, 'output/ui-shell-smoke')
const profile = await mkdtemp(join(tmpdir(), 'panlite-ui-shell-smoke-'))
await mkdir(output, { recursive: true })

try {
  const env = { ...process.env, PANLITE_UI_SMOKE_OUTPUT: output, PANLITE_UI_SMOKE_PROFILE: profile, PANLITE_UI_SMOKE_RENDERER: renderer }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolveRun, reject) => {
    const child = spawn(electron, [join(root, 'scripts/fixtures/ui-shell-smoke.cjs')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    let diagnostic = ''
    child.stdout.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-12000) })
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-12000) })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`UI smoke timed out\n${diagnostic}`)) }, 45000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolveRun()
      else reject(new Error(`UI smoke exited ${code}\n${diagnostic}`))
    })
  })
  console.log(await readFile(join(output, 'report.json'), 'utf8'))
} finally {
  const checked = resolve(profile)
  if (dirname(checked) === resolve(tmpdir()) && basename(checked).startsWith('panlite-ui-shell-smoke-')) {
    await rm(checked, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
