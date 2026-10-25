// Executed with the installed application's Electron/SQLite runtime. All data is
// synthetic; credential preservation is byte equality, not a real login test.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createRequire } = require('node:module')

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const id = 'panlite-isolated-upgrade-fixture'
const attachmentName = 'upgrade-fixture-中文.txt'
const attachmentBytes = Buffer.from('PanLite 升级与回滚附件\nfixture-v1\n')

function readRows(database, expected) {
  return expected.map(({ table, key, value, row }) => {
    if (![table, key, ...Object.keys(row)].every(name => /^[a-z_][a-z0-9_]*$/.test(name))) throw new Error('Unsafe fixture identifier')
    return { table, key, value, row: database.prepare(`SELECT ${Object.keys(row).join(',')} FROM ${table} WHERE ${key}=?`).get(value) || null }
  })
}

function seed(database, profile, manifestPath) {
  if (fs.existsSync(manifestPath)) throw new Error('Refusing to replace an existing upgrade fixture manifest')
  const attachment = path.join(profile, attachmentName)
  if (fs.existsSync(attachment)) throw new Error('Refusing to overwrite an existing profile attachment')
  const now = 1700000000000
  const rows = [
    { table: 'accounts', key: 'id', value: id, row: { id, platform: 'webdav', nickname: '隔离升级测试', login_type: 'password',
      encrypted_credential: 'SYNTHETIC-NOT-A-REAL-ENCRYPTED-CREDENTIAL', status: 'expired', bind_machine: 0, created_at: now, updated_at: now } },
    { table: 'settings', key: 'key', value: 'isolated_upgrade_fixture', row: { key: 'isolated_upgrade_fixture', value: JSON.stringify({ marker: '旧版设置', enabled: false }), encrypted: 0, updated_at: now } },
    { table: 'tasks', key: 'id', value: id, row: { id, account_id: id, platform: 'webdav', task_type: 'download', title: '升级保留的暂停任务',
      payload: JSON.stringify({ fileIds: ['synthetic-file'], targetPath: path.join(profile, 'downloads') }), status: 'paused', progress: 37, retry_count: 1, created_at: now, updated_at: now } },
    { table: 'ai_documents', key: 'id', value: id, row: { id, name: attachmentName, source_type: 'local', source_path: attachment,
      extension: 'txt', mime_type: 'text/plain', size: attachmentBytes.length, sha256: digest(attachmentBytes), status: 'ready', content_preview: attachmentBytes.toString('utf8'), created_at: now, updated_at: now } },
  ]
  database.transaction(() => {
    for (const { table, row } of rows) {
      const columns = Object.keys(row)
      database.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row))
    }
  })()
  fs.writeFileSync(attachment, attachmentBytes, { flag: 'wx' })
  const expected = readRows(database, rows)
  if (JSON.stringify(expected) !== JSON.stringify(rows)) throw new Error('Seeded data differs from fixture')
  database.pragma('wal_checkpoint(TRUNCATE)')
  const manifest = { syntheticOnly: true, credentialCheck: 'stored bytes only; no login or decryption', rows, attachment: { name: attachmentName, sha256: digest(attachmentBytes) } }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  return { passed: true, seededRows: rows.length, attachmentSha256: manifest.attachment.sha256 }
}

function verify(database, profile, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.syntheticOnly !== true || manifest.attachment.name !== attachmentName) throw new Error('Invalid isolated fixture manifest')
  const actual = readRows(database, manifest.rows)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.rows)) throw new Error('Account, settings, task or AI document changed during upgrade/rollback')
  if (digest(fs.readFileSync(path.join(profile, attachmentName))) !== manifest.attachment.sha256) throw new Error('AI attachment bytes changed during upgrade/rollback')
  if (database.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Upgraded database integrity check failed')
  return { passed: true, verifiedRows: actual.length, accountCredentialBytesPreserved: true, settingsPreserved: true, pausedTaskPreserved: true,
    aiDocumentPreserved: true, attachmentSha256: manifest.attachment.sha256, syntheticOnly: true, realLoginTested: false }
}

module.exports = { seed, verify }
if (require.main === module) {
  const [action, application, profile, manifestPath] = process.argv.slice(2)
  if (!['seed', 'verify'].includes(action) || !application || !profile || !manifestPath) throw new Error('Expected action, installed application, profile and manifest paths')
  const archive = path.join(path.dirname(path.resolve(application)), 'resources', 'app.asar')
  const packagedRequire = createRequire(path.join(archive, 'package.json'))
  const loader = packagedRequire.resolve('better-sqlite3')
  if (!path.resolve(loader).startsWith(path.resolve(archive) + path.sep)) throw new Error('SQLite loader is outside the installed application')
  const Database = packagedRequire('better-sqlite3')
  const database = new Database(path.join(profile, 'panlite.db'), { fileMustExist: true })
  try { console.log(JSON.stringify({ action, electron: process.versions.electron, abi: process.versions.modules, ...module.exports[action](database, profile, manifestPath) })) }
  finally { database.close() }
}
