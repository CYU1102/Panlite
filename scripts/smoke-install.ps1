param([switch]$IsolatedMachine)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Management')
if ($env:GITHUB_ACTIONS -ne 'true' -and -not $IsolatedMachine) {
  throw 'Run only on a disposable Windows CI runner or pass -IsolatedMachine on a dedicated test VM. This test installs and uninstalls PanLite.'
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installer = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'release') -Filter '*Setup-*.exe' -File)
if ($installer.Count -ne 1) { throw 'Expected exactly one Windows installer.' }
# Never replace an existing installation, even when the isolation switch is set.
foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
  if (Test-Path $registryRoot) {
    $existing = Get-ChildItem $registryRoot | Get-ItemProperty | Where-Object { $_.DisplayName -like 'PanLite*' }
    if ($existing) { throw 'An existing PanLite installation was found. Use a clean test machine.' }
  }
}
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = Join-Path $tempRoot ('panlite-install-smoke-' + [Guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'app'
$reportPath = Join-Path $projectRoot 'dist/reports/install-smoke.json'
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path $reportPath) -Force | Out-Null
$report = [ordered]@{ scenario = 'disposable Windows: silent install, isolated-profile launch, uninstall'; passed = $false; installed = $false; startup = $false; uninstalled = $false }
try {
  $install = Start-Process -FilePath $installer[0].FullName -ArgumentList @('/S', '/currentuser', "/D=$installRoot") -WindowStyle Hidden -PassThru -Wait
  if ($install.ExitCode -ne 0) { throw "Installer failed with exit code $($install.ExitCode)" }
  $application = Join-Path $installRoot 'PanLite.exe'
  if (-not (Test-Path -LiteralPath $application)) { throw 'Installer did not create the application at the requested path.' }
  $report.installed = $true
  & node (Join-Path $PSScriptRoot 'benchmark-startup.mjs') 1 $application (Join-Path $projectRoot 'dist/reports/installed')
  if ($LASTEXITCODE -ne 0) { throw 'Installed application failed the startup check.' }
  $report.startup = $true
  $uninstaller = @(Get-ChildItem -LiteralPath $installRoot -Filter '*Uninstall*.exe' -File)
  if ($uninstaller.Count -ne 1) { throw 'Expected one installed uninstaller.' }
  $uninstall = Start-Process -FilePath $uninstaller[0].FullName -ArgumentList @('/S', '/currentuser', "_?=$installRoot") -WindowStyle Hidden -PassThru -Wait
  if ($uninstall.ExitCode -ne 0) { throw "Uninstaller failed with exit code $($uninstall.ExitCode)" }
  if (Test-Path -LiteralPath $application) { throw 'Application executable remains after uninstall.' }
  $report.uninstalled = $true
  $report.passed = $true
} catch {
  $report.error = $_.Exception.Message
  throw
} finally {
  $report | ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding utf8
  # A failed installation remains available for diagnostics on the disposable VM.
  if ($report.passed) {
    $resolved = (Resolve-Path -LiteralPath $testRoot).Path
    if (-not $resolved.StartsWith($tempRoot + '\panlite-install-smoke-', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup target.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
