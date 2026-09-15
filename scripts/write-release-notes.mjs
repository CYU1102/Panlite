import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, process.argv[2] || 'release')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
const section = changelog.split(/^## /m).find(value => value.startsWith(`${pkg.version}（`) || value.startsWith(`${pkg.version}\n`))
if (!section) throw new Error(`CHANGELOG.md has no entry for ${pkg.version}`)
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0
await mkdir(output, { recursive: true })
await writeFile(join(output, 'RELEASE_NOTES.md'), `# PanLite ${pkg.version}\n\n提交：${revision}${dirty ? '（含未提交工作区改动，属于本地验证构建）' : ''}\n\n${section.slice(section.indexOf('\n') + 1).trim()}\n\n详细发布门禁与回滚步骤见随包 RELEASE_GUIDE.md。\n`)
await copyFile(join(root, 'docs/RELEASE.md'), join(output, 'RELEASE_GUIDE.md'))
await copyFile(join(root, 'docs/RELEASE_ACCEPTANCE.md'), join(output, 'RELEASE_ACCEPTANCE.md'))
await copyFile(join(root, 'docs/FUNCTIONAL_AUDIT.md'), join(output, 'FUNCTIONAL_AUDIT.md'))
console.log(`Release notes and rollback guide written to ${output}`)
