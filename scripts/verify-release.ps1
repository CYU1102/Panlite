param(
  [string]$ReleaseDirectory = (Join-Path $PSScriptRoot '../release'),
  [switch]$RequireSignature
)
$ErrorActionPreference = 'Stop'
# A PowerShell 7 parent can pass its module search path to Windows PowerShell.
# Resolve built-in modules from this runtime to avoid loading incompatible copies.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security')
$releaseRoot = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$checksums = Join-Path $releaseRoot 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $checksums)) { throw 'Generate release checksums before verification.' }
$installers = @(Get-ChildItem -LiteralPath $releaseRoot -Filter '*Setup-*.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one installer in the release directory.' }
$rows = @(Get-Content -LiteralPath $checksums)
$listedInstaller = $false
foreach ($row in $rows) {
  if ($row -notmatch '^([a-f0-9]{64})  (.+)$') { throw 'Invalid checksum row.' }
  $expected = $Matches[1]
  $relative = $Matches[2]
  $target = [IO.Path]::GetFullPath((Join-Path $releaseRoot $relative))
  if (-not $target.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Checksum path is outside the release directory.'
  }
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $expected) { throw "Checksum mismatch: $relative" }
  if ($target -ieq $installers[0].FullName) { $listedInstaller = $true }
}
if (-not $listedInstaller) { throw 'Installer is absent from checksum manifest.' }
$executables = @($installers[0].FullName)
$unpackedApplication = Join-Path $releaseRoot 'win-unpacked/PanLite.exe'
if (Test-Path -LiteralPath $unpackedApplication) { $executables += $unpackedApplication }
foreach ($executable in $executables) {
  $signature = Get-AuthenticodeSignature -LiteralPath $executable
  if ($RequireSignature -or $env:PANLITE_PUBLISHER_NAME) {
    if ($signature.Status -ne 'Valid') { throw "Invalid or missing signature: $executable ($($signature.Status))" }
    if (-not $env:PANLITE_PUBLISHER_NAME) { throw 'Set PANLITE_PUBLISHER_NAME for publisher verification.' }
    $publisher = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($publisher -cne $env:PANLITE_PUBLISHER_NAME.Trim()) { throw "Unexpected signing publisher: $publisher" }
    Write-Output "Verified signature and publisher: $executable"
  } elseif ($signature.Status -eq 'NotSigned') {
    Write-Output "Verified unsigned artifact: $executable"
  } elseif ($signature.Status -eq 'Valid') {
    Write-Output "Verified signed artifact: $executable"
  } else {
    throw "Invalid signature state: $executable ($($signature.Status))"
  }
}
Write-Output 'Release checksums and artifact signature states verified.'
