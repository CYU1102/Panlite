import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const outdir = resolve(root, 'dist/main/main')

await rm(resolve(root, 'dist/main'), { recursive: true, force: true })

const external = [
  'electron',
  'better-sqlite3',
  'archiver',
  'node-7z',
  'node-unrar-js',
  'pdf2json',
  'tar',
  'unzipper',
]

await build({
  entryPoints: {
    index: resolve(root, 'src/main/index.ts'),
    preload: resolve(root, 'src/main/preload.ts'),
    'login-preload': resolve(root, 'src/main/login-preload.ts'),
  },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external,
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
})
