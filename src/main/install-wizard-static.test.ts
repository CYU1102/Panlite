import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

const file = path.resolve('scripts/smoke-install-wizard.ps1')
const source = fs.readFileSync(file, 'utf8')

it('places the hosted Windows-only refusal before native initialization or filesystem mutation', () => {
  const guard = source.indexOf('if ([Environment]::OSVersion.Platform')
  expect(guard).toBeGreaterThan(0)
  const condition = source.slice(guard, source.indexOf('\n}', guard))
  expect(condition).toContain('[PlatformID]::Win32NT')
  expect(condition).toContain("$env:GITHUB_ACTIONS -ne 'true'")
  expect(condition).toContain("$env:RUNNER_ENVIRONMENT -ne 'github-hosted'")
  expect(condition).toContain('Local execution is forbidden')
  expect(guard).toBeLessThan(source.indexOf('Add-Type'))
  expect(guard).toBeLessThan(source.indexOf('New-Item'))
  expect(source).not.toContain('[switch]$IsolatedMachine')
})

it('keeps real non-silent wizard notifications scoped to owned enabled controls without desktop input', () => {
  expect(source).toContain("Run-Wizard $installer @('/currentuser') $true")
  expect(source).toContain('Run-Wizard $uninstaller[0].FullName @(\'/currentuser\',("_?=$installRoot")) $false')
  expect(source).toContain('PostMessageW(parent,0x0111,new IntPtr(id),button)')
  expect(source).toContain('!Owned(parent.ToInt64(),expectedPid)')
  expect(source).toContain('!IsWindowEnabled(parent)')
  expect(source).not.toMatch(/\b(?:SendInput|SetForegroundWindow|SetActiveWindow|SetCursorPos|mouse_event|keybd_event|GetDesktopWindow)\s*\(/)
  expect(source).not.toMatch(/@\([^\n]*['"]\/[Ss]['"]/)
  expect(source).toContain('visualReviewPerformed = $false')
  expect(source).toContain('No silent fallback is allowed')
  expect(source).toContain("$report.status = 'unsupported'")
})

it('preserves the outcome of control reads and distinguishes ownership from message failures', () => {
  expect(source).toContain('bool textReadSucceeded = ReadText(')
  expect(source).toContain('TextReadSucceeded=textReadSucceeded, TextReadWin32Error=textReadError')
  expect(source).toContain('Directory control ownership changed before setting text')
  expect(source).toContain('Directory text message failed; handle=')
  expect(source).toContain('win32Error="+error+" (zero means unavailable)')
})

it.runIf(process.platform === 'win32')('parses and compiles the native declarations with Windows PowerShell without executing the script or native methods', () => {
  const command = `$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; $ast=[System.Management.Automation.Language.Parser]::ParseFile($env:PANLITE_WIZARD_AST_SOURCE,[ref]$tokens,[ref]$errors); $add=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type'},$true)|Select-Object -First 1; $code=$add.CommandElements|Where-Object{$_ -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $_.Value.StartsWith('using System;')}|Select-Object -First 1; Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition $code.Value; [ordered]@{errors=@($errors | ForEach-Object {$_.Message}); startProcessCount=@($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Start-Process'},$true)).Count; compiledType=[PanLiteWizardNative].FullName; scriptExecuted=$false; nativeMethodsInvoked=$false} | ConvertTo-Json -Compress`
  const shell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, PANLITE_WIZARD_AST_SOURCE: file }, windowsHide: true, encoding: 'utf8', timeout: 15000,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())).toEqual({ errors: [], startProcessCount: 1, compiledType: 'PanLiteWizardNative', scriptExecuted: false, nativeMethodsInvoked: false })
}, 20000)

it.runIf(process.platform === 'win32')('reports invalid control ownership without sending a window message', () => {
  const command = `$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; $ast=[System.Management.Automation.Language.Parser]::ParseFile($env:PANLITE_WIZARD_AST_SOURCE,[ref]$tokens,[ref]$errors); $add=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type'},$true)|Select-Object -First 1; $code=$add.CommandElements|Where-Object{$_ -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $_.Value.StartsWith('using System;')}|Select-Object -First 1; Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition $code.Value; try { [PanLiteWizardNative]::SetText(0,-1,'unused'); throw 'Invalid handle was accepted' } catch { if (-not $_.Exception.Message.Contains('Directory control ownership changed')) { throw }; 'invalid ownership rejected' }`
  const shell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, PANLITE_WIZARD_AST_SOURCE: file }, windowsHide: true, encoding: 'utf8', timeout: 15000,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe('invalid ownership rejected')
}, 20000)
