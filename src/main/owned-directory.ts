import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { join } from 'node:path'

/** Compare exact filesystem identifiers; a missing inode cannot prove ownership. */
export function sameDirectoryIdentity(a: Pick<BigIntStats, 'dev' | 'ino'>, b: Pick<BigIntStats, 'dev' | 'ino'>): boolean {
  return a.ino !== 0n && b.ino !== 0n && a.dev === b.dev && a.ino === b.ino
}

/** Remove only the owned directory tree, unlinking links without following them. */
export function removeOwnedDirectory(directory: string, expected: BigIntStats): void {
  const current = lstatSync(directory, { bigint: true })
  if (!current.isDirectory() || current.isSymbolicLink() || !sameDirectoryIdentity(current, expected)) {
    throw new Error('临时目录身份发生变化')
  }
  for (const name of readdirSync(directory)) {
    const child = join(directory, name), stat = lstatSync(child, { bigint: true })
    if (stat.isSymbolicLink()) unlinkSync(child)
    else if (stat.isDirectory()) {
      if (stat.dev !== expected.dev) throw new Error('临时目录包含其他文件系统')
      removeOwnedDirectory(child, stat)
    } else if (stat.isFile()) unlinkSync(child)
    else throw new Error('临时目录包含不支持的文件类型')
  }
  const after = lstatSync(directory, { bigint: true })
  if (!after.isDirectory() || after.isSymbolicLink() || !sameDirectoryIdentity(after, expected)) throw new Error('临时目录身份发生变化')
  rmdirSync(directory)
}
