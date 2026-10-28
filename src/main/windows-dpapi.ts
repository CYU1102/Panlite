import { spawn } from 'node:child_process'
import path from 'node:path'

const PREFIX = 'win-dpapi-v1:'
const MAX_INPUT_BYTES = 64 * 1024
const MAX_PASSWORD_BYTES = 32 * 1024
const TIMEOUT_MS = 15_000

// Fixed script; the data is passed on stdin, never on the command line.
const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $operation = [Console]::In.ReadLine()
  $inputData = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($operation -eq 'protect') {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($inputData, $null, $scope)
  } elseif ($operation -eq 'unprotect') {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($inputData, $null, $scope)
  } else { throw 'Invalid operation' }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { exit 1 }
`
const encodedScript = Buffer.from(script, 'utf16le').toString('base64')

async function callDpapi(operation: 'protect' | 'unprotect', input: Buffer): Promise<Buffer> {
  if (!input.length || input.length > MAX_INPUT_BYTES) throw new Error('系统加密数据大小无效')
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('系统加密服务不可用')
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: Error, output?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(output!)
    }
    const timer = setTimeout(() => { child.kill(); finish(new Error('系统加密服务超时')) }, TIMEOUT_MS)
    child.stderr.resume()
    child.stdin.on('error', () => { child.kill(); finish(new Error('系统加密服务不可用')) })
    child.once('error', () => finish(new Error('系统加密服务不可用')))
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_INPUT_BYTES * 3) { child.kill(); finish(new Error('系统加密服务响应无效')); return }
      chunks.push(chunk)
    })
    child.once('close', code => {
      if (code !== 0) { finish(new Error('系统加密服务失败')); return }
      const result = Buffer.concat(chunks).toString('ascii').trim()
      if (!result || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result)) {
        finish(new Error('系统加密服务响应无效')); return
      }
      finish(undefined, Buffer.from(result, 'base64'))
    })
    child.stdin.end(`${operation}\n${input.toString('base64')}`)
  })
}

export async function protectWindowsTaskPassword(password: string): Promise<string> {
  const plaintext = Buffer.from(password, 'utf8')
  try {
    if (plaintext.length > MAX_PASSWORD_BYTES) throw new Error('压缩包密码过长')
    return PREFIX + (await callDpapi('protect', plaintext)).toString('base64')
  }
  finally { plaintext.fill(0) }
}

export async function unprotectWindowsTaskPassword(value: string): Promise<string> {
  if (!value.startsWith(PREFIX)) throw new Error('系统加密数据格式无效')
  const encoded = value.slice(PREFIX.length)
  if (!encoded || encoded.length > MAX_INPUT_BYTES * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('系统加密数据格式无效')
  const plaintext = await callDpapi('unprotect', Buffer.from(encoded, 'base64'))
  try { return plaintext.toString('utf8') }
  finally { plaintext.fill(0) }
}

export function isWindowsTaskPassword(value: string): boolean { return value.startsWith(PREFIX) }
