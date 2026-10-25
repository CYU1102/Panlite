// Verify the actual packaged benchmark cannot resume transfers in an existing
// profile. This never installs an application or opens a visible window.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const executable = resolve(process.argv[2] || 'release/win-unpacked/PanLite.exe')
const reports = resolve(process.argv[3] || 'dist/reports/benchmark-queue')
const temporary = await mkdtemp(join(tmpdir(), 'panlite-benchmark-queue-'))
if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('panlite-benchmark-queue-')) throw new Error('Unsafe temporary cleanup path')
const profile = join(temporary, 'profile')
await mkdir(reports, { recursive: true })
const run = (args, env) => new Promise((resolveRun, reject) => {
  const child = spawn(executable, args, { cwd: dirname(executable), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  const collect = data => { diagnostics = (diagnostics + data).slice(-64_000) }
  child.stdout.on('data', collect); child.stderr.on('data', collect)
  const timer = setTimeout(() => { child.kill(); reject(new Error('Benchmark queue check timed out')) }, 60_000)
  child.once('error', error => { clearTimeout(timer); reject(error) })
  child.once('exit', code => { clearTimeout(timer); if (code === 0) resolveRun(diagnostics); else reject(new Error(`Benchmark queue check exited ${code}: ${diagnostics}`)) })
})
const environment = { ...process.env, PANLITE_BENCHMARK_USER_DATA: profile }
delete environment.VITE_DEV_SERVER_URL
delete environment.ELECTRON_RUN_AS_NODE
const launch = async name => {
  const output = join(reports, `${name}.json`)
  await rm(output, { force: true })
  await run(['--benchmark-startup'], { ...environment, PANLITE_BENCHMARK_OUTPUT: output })
  const report = JSON.parse(await readFile(output, 'utf8'))
  if (report.error || !report.renderer?.textLength || report.hiddenAtVerification !== true) throw new Error('Benchmark did not produce a hidden first screen')
  return report
}
const probe = script => run(['-e', `const path=require('node:path');const req=require('node:module').createRequire(${JSON.stringify(join(dirname(executable), 'resources/app.asar/package.json'))});const Database=req('better-sqlite3');const db=new Database(${JSON.stringify(join(profile, 'panlite.db'))},{fileMustExist:true});try{${script}}finally{db.close();}`], { ...environment, ELECTRON_RUN_AS_NODE: '1' })
let passed = false
try {
  await launch('initial')
  await probe(`const now=1700000000000;db.prepare("INSERT INTO accounts(id,platform,nickname,login_type,encrypted_credential,status,bind_machine,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run('benchmark-queue','webdav','Synthetic queue fixture','password','NOT-A-REAL-CREDENTIAL','expired',0,now,now);db.prepare("INSERT INTO tasks(id,account_id,platform,task_type,title,payload,status,progress,retry_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run('benchmark-queue','benchmark-queue','webdav','download','Pending queue guard',JSON.stringify({fileIds:[],targetPath:${JSON.stringify(join(profile, 'downloads'))}}),'pending',0,0,now,now);`)
  await launch('pending-profile')
  const diagnostics = await probe(`const row=db.prepare("SELECT status,progress,retry_count,updated_at FROM tasks WHERE id='benchmark-queue'").get();if(row.status!=='pending'||row.progress!==0||row.retry_count!==0||row.updated_at!==1700000000000)throw Error('Benchmark changed or resumed the pending task: '+JSON.stringify(row));console.log(JSON.stringify(row));`)
  await writeFile(join(reports, 'report.json'), JSON.stringify({ passed: true, pendingTaskUnchanged: true, hiddenWindowVerified: true, syntheticOnly: true, applicationInstalled: false, diagnostics: diagnostics.trim() }, null, 2) + '\n')
  passed = true
  console.log('Packaged hidden benchmark preserved the pending task without running the queue')
} finally {
  if (passed) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } else console.error(`Queue check failed; isolated diagnostics profile retained at ${temporary}`)
}
