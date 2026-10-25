import fs from 'node:fs'
import path from 'node:path'

/** Check every existing ancestor, including the selected root, without following links. */
function inspectPath(input: string): void {
  const absolute = path.resolve(input), parsed = path.parse(absolute)
  let current = parsed.root
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index])
    let stat: fs.Stats
    try { stat = fs.lstatSync(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('下载路径不能包含符号链接或目录联接，请选择普通目录')
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('下载路径的上级不是普通目录')
  }
}

/** Queue payloads may name a new download directory; check its existing ancestors before mkdir. */
export function prepareSafeDownloadRoot(rootInput: string): void {
  const root = path.resolve(rootInput)
  inspectPath(root)
  fs.mkdirSync(root, { recursive: true })
  assertSafeDownloadTarget(root)
}

/** Lexical containment is insufficient on Windows: junctions can redirect a child elsewhere. */
export function assertSafeDownloadTarget(rootInput: string, targetInput = rootInput): void {
  const root = path.resolve(rootInput), target = path.resolve(targetInput)
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('下载目标路径越界')
  inspectPath(root)
  const rootStat = fs.lstatSync(root)
  if (!rootStat.isDirectory()) throw new Error('下载目标必须是普通目录')
  const canonicalRoot = fs.realpathSync.native(root)
  inspectPath(target)
  // Resolve the deepest existing parent too, so a reparse point cannot satisfy only the string check.
  let existing = target
  while (!fs.existsSync(existing)) existing = path.dirname(existing)
  const actualRelative = path.relative(canonicalRoot, fs.realpathSync.native(existing))
  if (actualRelative === '..' || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) throw new Error('下载目标实际路径越界')
}
