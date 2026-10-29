import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { join } from 'node:path'

/** Remove only the owned directory tree, unlinking links without following them. */
export function removeOwnedDirectory(directory: string, expected: Stats): void {
  const current = lstatSync(directory)
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error('临时目录身份发生变化')
  }
  for (const name of readdirSync(directory)) {
    const child = join(directory, name), stat = lstatSync(child)
    if (stat.isSymbolicLink()) unlinkSync(child)
    else if (stat.isDirectory()) {
      if (stat.dev !== expected.dev) throw new Error('临时目录包含其他文件系统')
      removeOwnedDirectory(child, stat)
    } else if (stat.isFile()) unlinkSync(child)
    else throw new Error('临时目录包含不支持的文件类型')
  }
  const after = lstatSync(directory)
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== expected.dev || after.ino !== expected.ino) throw new Error('临时目录身份发生变化')
  rmdirSync(directory)
}
