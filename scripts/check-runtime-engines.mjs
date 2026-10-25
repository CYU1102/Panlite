import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const semver = require('semver')
const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'))
const declared = pkg.engines?.node
if (!semver.validRange(declared)) throw new Error('Declare a valid Node.js engines range')
const incompatible = Object.entries(lock.packages).filter(([name, entry]) => name && entry.engines?.node
  && !semver.subset(declared, entry.engines.node)).map(([name, entry]) => ({ package: name, required: entry.engines.node }))
if (!semver.satisfies(process.version, declared)) throw new Error(`Current Node ${process.version} is outside ${declared}`)
if (incompatible.length) throw new Error(`Declared Node ${declared} includes versions unsupported by locked dependencies:\n${JSON.stringify(incompatible, null, 2)}`)
console.log(`Node ${process.version} and declared range ${declared} satisfy all locked dependency engines`)
