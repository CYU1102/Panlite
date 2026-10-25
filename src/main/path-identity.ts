import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Resolve filesystem aliases even when the final file or its parents are absent.
 * This establishes identity only, not permission to traverse symbolic links.
 * Callers that copy/write data must still validate their owned directory tree.
 */
export async function canonicalPathWithMissingTail(input: string): Promise<string> {
  let current = path.resolve(input)
  const missing: string[] = []
  for (;;) {
    try { return path.join(await fs.realpath(current), ...missing.slice().reverse()) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      // An unavailable drive/share has no existing ancestor to canonicalize.
      if (parent === current) return path.join(current, ...missing.slice().reverse())
      missing.push(path.basename(current))
      current = parent
    }
  }
}
