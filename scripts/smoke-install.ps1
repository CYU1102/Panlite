param(
  [switch]$IsolatedMachine,
  [string]$BaselineInstaller,
  [string]$BaselineSha256,
  [string]$BaselineVersion
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Management')
if ($env:GITHUB_ACTIONS -ne 'true' -and -not $IsolatedMachine) {
  throw 'Run only on a disposable Windows CI runner or pass -IsolatedMachine on a dedicated test VM. This test installs and uninstalls PanLite.'
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installer = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'release') -Filter '*Setup-*.exe' -File)
if ($installer.Count -ne 1) { throw 'Expected exactly one Windows installer.' }
$candidateVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$hasBaseline = -not [string]::IsNullOrWhiteSpace($BaselineInstaller)
if ($hasBaseline) {
  if ($BaselineSha256 -notmatch '^[a-fA-F0-9]{64}$' -or [string]::IsNullOrWhiteSpace($BaselineVersion)) { throw 'An upgrade baseline requires its expected SHA-256 and version.' }
  if ($BaselineVersion -eq $candidateVersion) { throw 'Upgrade validation requires a different previous version.' }
  $BaselineInstaller = (Resolve-Path -LiteralPath $BaselineInstaller).Path
  if ((Get-FileHash -LiteralPath $BaselineInstaller -Algorithm SHA256).Hash -ne $BaselineSha256) { throw 'Baseline installer SHA-256 does not match.' }
} elseif ($BaselineSha256 -or $BaselineVersion) { throw 'Baseline SHA-256 and version require a baseline installer.' }
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
$profile = Join-Path $testRoot 'profile'
$backup = Join-Path $testRoot 'offline-backup'
$reports = Join-Path $projectRoot 'dist/reports/installed'
$manifest = Join-Path $reports 'profile-fixture.json'
$reportPath = Join-Path $projectRoot 'dist/reports/install-smoke.json'
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
New-Item -ItemType Directory -Path $reports -Force | Out-Null
if (Test-Path -LiteralPath $manifest) { Remove-Item -LiteralPath $manifest -Force }
$report = [ordered]@{ scenario = 'disposable Windows: unsigned silent install, optional old-data upgrade and offline rollback, uninstall'; passed = $false;
  createdAt = [DateTime]::UtcNow.ToString('o'); windows = [Environment]::OSVersion.VersionString; architecture = $env:PROCESSOR_ARCHITECTURE;
  candidateVersion = $candidateVersion; candidateSha256 = (Get-FileHash -LiteralPath $installer[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant();
  baselineVersion = $BaselineVersion; baselineSha256 = $BaselineSha256; installed = $false; startup = $false; uninstalled = $false;
  upgrade = [ordered]@{ executed = $false; passed = $false; reason = 'No previous-version installer was supplied; upgrade and rollback are not validated.' };
  rollback = [ordered]@{ executed = $false; passed = $false }; releaseUpgradeGatePassed = $false; syntheticOnly = $true; realPlatformLoginTested = $false; interactiveInstallerTested = $false }

function Install-Application([string]$File) {
  $process = Start-Process -FilePath $File -ArgumentList @('/S', '/currentuser', "/D=$installRoot") -WindowStyle Hidden -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)" }
  if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'PanLite.exe'))) { throw 'Installer did not create the application at the requested path.' }
}
function Uninstall-Application {
  $uninstallers = @(Get-ChildItem -LiteralPath $installRoot -Filter '*Uninstall*.exe' -File)
  if ($uninstallers.Count -ne 1) { throw 'Expected one installed uninstaller.' }
  $process = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList @('/S', '/currentuser', "_?=$installRoot") -WindowStyle Hidden -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Uninstaller failed with exit code $($process.ExitCode)" }
  if (Test-Path -LiteralPath (Join-Path $installRoot 'PanLite.exe')) { throw 'Application executable remains after uninstall.' }
}
function Invoke-ProfileCheck([string]$Action, [string]$Name) {
  $output = Join-Path $reports ($Name + '.json')
  $messages = & node (Join-Path $PSScriptRoot 'check-install-profile.mjs') $Action (Join-Path $installRoot 'PanLite.exe') $profile $output $manifest
  if ($LASTEXITCODE -ne 0) { throw "Installed profile $Action failed: $Name" }
  Write-Host ($messages -join [Environment]::NewLine)
  return (Get-Content -LiteralPath $output -Raw | ConvertFrom-Json)
}
function Assert-LaunchVersion([string]$Name, [string]$Version) {
  $launch = Invoke-ProfileCheck 'launch' $Name
  if ($launch.version -ne $Version) { throw "Installed version $($launch.version) differs from expected $Version." }
}
function Get-ProfileHashes([string]$Directory) {
  $prefix = [IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\'
  $entries = @(Get-ChildItem -LiteralPath $Directory -Recurse -Force)
  if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Profile backup must not follow junctions or symbolic links.' }
  $hashes = @($entries | Where-Object { -not $_.PSIsContainer } | Sort-Object FullName | ForEach-Object {
    [ordered]@{ path = $_.FullName.Substring($prefix.Length); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
  return (ConvertTo-Json -InputObject $hashes -Compress)
}
function Remove-OwnedDirectory([string]$Directory) {
  $target = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
  if (-not $target.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup target outside the owned test root.' }
  if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to remove a junction or symbolic link.' }
  Remove-Item -LiteralPath $target -Recurse -Force
}
try {
  if ($hasBaseline) {
    Install-Application $BaselineInstaller
    Assert-LaunchVersion 'baseline-startup' $BaselineVersion
    $null = Invoke-ProfileCheck 'seed' 'baseline-seed'
    $null = Invoke-ProfileCheck 'verify' 'baseline-data'
    $originalHashes = Get-ProfileHashes $profile
    Copy-Item -LiteralPath $profile -Destination $backup -Recurse -Force
    if ((Get-ProfileHashes $backup) -ne $originalHashes) { throw 'Offline backup is not byte-identical to the stopped previous-version profile.' }
    $originalHashes | Set-Content -LiteralPath (Join-Path $reports 'offline-backup-hashes.json') -Encoding utf8
  }
  Install-Application $installer[0].FullName
  $report.installed = $true
  Assert-LaunchVersion 'candidate-startup' $candidateVersion
  $report.startup = $true
  if ($hasBaseline) {
    $report.upgrade.executed = $true
    $report.upgrade.reason = 'Previous-version installer, application-initialized schema and synthetic account/settings/task/AI attachment fixture.'
    $report.upgrade.data = Invoke-ProfileCheck 'verify' 'upgraded-data'
    $report.upgrade.passed = $true
    Copy-Item -LiteralPath $profile -Destination (Join-Path $testRoot 'upgraded-profile') -Recurse -Force
    Uninstall-Application
    Install-Application $BaselineInstaller
    $report.rollback.executed = $true
    Remove-OwnedDirectory $profile
    Copy-Item -LiteralPath $backup -Destination $profile -Recurse -Force
    if ((Get-ProfileHashes $profile) -ne $originalHashes) { throw 'Offline restore is not byte-identical to the stopped previous-version profile.' }
    $report.rollback.offlineRestoreExactBytes = $true
    Assert-LaunchVersion 'rollback-startup' $BaselineVersion
    $report.rollback.data = Invoke-ProfileCheck 'verify' 'rollback-data'
    $report.rollback.passed = $true
  }
  Uninstall-Application
  $report.uninstalled = $true
  if (-not (Test-Path -LiteralPath (Join-Path $profile 'panlite.db'))) { throw 'Uninstall removed the isolated profile unexpectedly.' }
  $report.isolatedProfilePreservedAfterUninstall = $true
  $report.releaseUpgradeGatePassed = $hasBaseline -and $report.upgrade.passed -and $report.rollback.passed
  $report.passed = $true
} catch {
  $report.error = $_.Exception.Message
  $report.diagnosticsDirectory = $testRoot
  throw
} finally {
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8
  # A failed installation remains available for diagnostics on the disposable VM.
  if ($report.passed) {
    $resolved = (Resolve-Path -LiteralPath $testRoot).Path
    if (-not $resolved.StartsWith($tempRoot + '\panlite-install-smoke-', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup target.' }
    if ((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe cleanup junction.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
