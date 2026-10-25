param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$InstallerSha256,
  [string]$ExpectedVersion,
  [string]$ReportDirectory = 'dist/reports/install-wizard',
  [ValidateRange(90, 900)][int]$DeadlineSeconds = 360,
  [ValidateRange(10, 120)][int]$PageTimeoutSeconds = 45
)
$ErrorActionPreference = 'Stop'
# This script must never execute on a developer's desktop, including with an
# isolation override. Local validation is PowerShell AST parsing only.
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Wizard acceptance runs only on a disposable GitHub-hosted Windows runner. Local execution is forbidden.'
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$workspaceRoot = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE).TrimEnd('\')
if (-not $workspaceRoot -or $projectRoot -ne $workspaceRoot) { throw 'Run the checked-out script from GITHUB_WORKSPACE.' }
$installer = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $InstallerPath).Path)
if (-not $installer.StartsWith($workspaceRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($installer) -notmatch '^PanLite-Setup-\d+\.\d+\.\d+\.exe$') { throw 'Installer must be a candidate EXE inside the checked-out workspace.' }
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $InstallerSha256) { throw 'Candidate installer SHA-256 mismatch.' }
if (-not $ExpectedVersion) { $ExpectedVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version }
if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'ExpectedVersion must identify a release version.' }
$reports = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($ReportDirectory)) { $ReportDirectory } else { Join-Path $projectRoot $ReportDirectory }))
if (-not $reports.StartsWith($workspaceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Reports must stay inside GITHUB_WORKSPACE.' }
$temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$runId = [Guid]::NewGuid().ToString('N')
$ownedRoot = Join-Path $temporaryParent ('panlite-install-smoke-' + $runId)
$installRoot = Join-Path $ownedRoot 'PanLite'
$profile = Join-Path $ownedRoot 'profile'
$application = Join-Path $installRoot 'PanLite.exe'
$appDataRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'PanLite'))
$appDataMarker = Join-Path $appDataRoot ('.wizard-acceptance-' + $runId + '.txt')
$desktopLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'PanLite.lnk'
$menuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'PanLite.lnk'
$trackedProcesses = @{}
$clock = [Diagnostics.Stopwatch]::StartNew()
$pageNumber = 0
$createdAppData = $false
$activeWizard = $null
$report = [ordered]@{ scenario = 'non-silent NSIS control-driven wizard on disposable hosted Windows'; createdAt = [DateTime]::UtcNow.ToString('o'); runId = $runId; sourceRevision = $env:GITHUB_SHA; workflowRunId = $env:GITHUB_RUN_ID;
  status = 'failed'; passed = $false; installerSha256 = $InstallerSha256.ToLowerInvariant(); expectedVersion = $ExpectedVersion;
  runner = $env:RUNNER_NAME; sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId; windows = [Environment]::OSVersion.VersionString; powershell = $PSVersionTable.PSVersion.ToString();
  installed = $false; installWizardCompleted = $false; shortcutsVerified = $false; hiddenStartup = $false; uninstallWizardCompleted = $false;
  appDataMarkerPreserved = $false; visualReviewPerformed = $false; pages = @(); actions = @();
  boundaries = @('No keyboard, mouse, foreground activation or user desktop capture is used.',
    'The current-user argument fixes installation mode; the mode selector is not tested.',
    'Uninstallation uses the NSIS in-place _? argument; self-copy bootstrap is not tested.',
    'Shortcut targets are validated without launching their normal tray-enabled workflow; startup uses an isolated hidden profile.',
    'PrintWindow capture is best effort and does not constitute visual review. No silent fallback is allowed.') }

function Assert-PlainPath([string]$Target, [string]$Boundary) {
  $absolute = [IO.Path]::GetFullPath($Target).TrimEnd('\')
  $base = [IO.Path]::GetFullPath($Boundary).TrimEnd('\')
  if ($absolute -ne $base -and -not $absolute.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path is outside its explicit test boundary.' }
  $cursor = $absolute
  while ($cursor -and $cursor.Length -ge $base.Length) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Test paths must not traverse junctions or symbolic links.' }
    }
    if ($cursor -eq $base) { break }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
function Check-Deadline {
  if ($clock.Elapsed.TotalSeconds -gt $DeadlineSeconds) { throw 'Wizard scenario exceeded its deadline.' }
}
function Unsupported([string]$Reason) { throw [NotSupportedException]::new($Reason) }
function Action([string]$Name) { $report.actions += [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); action = $Name } }
function Quote-Argument([string]$Value) {
  if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) { throw 'Unsafe native argument.' }
  if ($Value.EndsWith('\')) { $Value += '\' }
  return '"' + $Value + '"'
}

# All window messages below are addressed to a child of the exact process we
# created. Enumeration discards foreign PIDs before reading control metadata;
# there is no input injection, desktop-wide capture or activation API.
Assert-PlainPath $reports $workspaceRoot
New-Item -ItemType Directory -Path $reports -Force | Out-Null
try {
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class PanLiteWizardNative {
  public delegate bool EnumProc(IntPtr h, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  public sealed class Control { public long Handle, Parent; public int Id, Kind; public string Class, Text; public bool Enabled, LocalVisible; public Rect Bounds; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder text, int capacity);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int index);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessageW(IntPtr h, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint message, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW", SetLastError=true)] static extern IntPtr SendText(IntPtr h, uint message, UIntPtr w, string text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW", SetLastError=true)] static extern IntPtr ReadText(IntPtr h, uint message, UIntPtr w, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  public static bool Owned(long handle, int expectedPid) { uint pid; GetWindowThreadProcessId(new IntPtr(handle), out pid); return pid == expectedPid; }
  static Control Describe(IntPtr h) {
    StringBuilder cls = new StringBuilder(128), text = new StringBuilder(2048); UIntPtr result; Rect rect;
    GetClassNameW(h, cls, cls.Capacity); GetWindowRect(h, out rect);
    ReadText(h, 0x000D, new UIntPtr((uint)text.Capacity), text, 3, 300, out result);
    int style = GetWindowLongW(h, -16);
    return new Control { Handle=h.ToInt64(), Parent=GetParent(h).ToInt64(), Id=GetDlgCtrlID(h), Class=cls.ToString(), Text=text.ToString(),
      Enabled=IsWindowEnabled(h), LocalVisible=(style & 0x10000000)!=0, Kind=style & 15, Bounds=rect };
  }
  public static Control[] Windows(int expectedPid) { var list=new List<Control>(); EnumWindows((h,p)=>{if(Owned(h.ToInt64(),expectedPid))list.Add(Describe(h));return list.Count<8;},IntPtr.Zero); return list.ToArray(); }
  public static Control[] Children(long parent, int expectedPid) { var list=new List<Control>(); EnumChildWindows(new IntPtr(parent),(h,p)=>{if(Owned(h.ToInt64(),expectedPid))list.Add(Describe(h));return list.Count<64;},IntPtr.Zero); return list.ToArray(); }
  public static void Click(long handle, int expectedPid) {
    IntPtr button=new IntPtr(handle), parent=GetParent(button); int id=GetDlgCtrlID(button);
    if(!Owned(handle,expectedPid)||!Owned(parent.ToInt64(),expectedPid)||!IsWindowEnabled(button)||!IsWindowEnabled(parent)||id<1)throw new InvalidOperationException("Control ownership or enabled state changed");
    // Post the standard BN_CLICKED notification to the owned dialog. Unlike
    // BM_CLICK this does not require activating a hidden dialog. NSIS still
    // executes the real page callbacks; a later page is required as evidence.
    if(!PostMessageW(parent,0x0111,new IntPtr(id),button))throw new InvalidOperationException("Button notification could not be posted");
  }
  public static void SetText(long handle,int expectedPid,string value) { UIntPtr result; if(!Owned(handle,expectedPid)||SendText(new IntPtr(handle),0x000C,UIntPtr.Zero,value,3,2000,out result)==IntPtr.Zero)throw new InvalidOperationException("Directory value could not be set"); }
  public static void Uncheck(long handle,int expectedPid) { UIntPtr result; if(!Owned(handle,expectedPid)||SendMessageTimeoutW(new IntPtr(handle),0x00F1,UIntPtr.Zero,IntPtr.Zero,3,2000,out result)==IntPtr.Zero)throw new InvalidOperationException("Run checkbox could not be cleared"); }
  public static int Checked(long handle,int expectedPid) { UIntPtr result; if(!Owned(handle,expectedPid)||SendMessageTimeoutW(new IntPtr(handle),0x00F0,UIntPtr.Zero,IntPtr.Zero,3,2000,out result)==IntPtr.Zero)throw new InvalidOperationException("Checkbox state could not be read"); return (int)result.ToUInt64(); }
  public static string Capture(long handle,int expectedPid,string file) {
    if(!Owned(handle,expectedPid))return "ownership-changed";
    try {
    var work=Task.Run(()=>{Rect rect; if(!GetWindowRect(new IntPtr(handle),out rect))return "no-geometry"; int width=rect.Right-rect.Left,height=rect.Bottom-rect.Top;
      if(width<10||height<10||width>4000||height>4000)return "unsupported-geometry";
      using(var image=new Bitmap(width,height,PixelFormat.Format32bppArgb))using(var graphics=Graphics.FromImage(image)) {IntPtr dc=graphics.GetHdc(); bool ok;
        try {ok=PrintWindow(new IntPtr(handle),dc,2);}finally{graphics.ReleaseHdc(dc);}if(!ok)return "printwindow-failed";
        image.Save(file,ImageFormat.Png);return "captured-not-visually-reviewed";}});
    return work.Wait(2500)?work.Result:"printwindow-timeout";
    } catch { return "capture-failed"; }
  }
}
'@
} catch {
  $report.status = 'unsupported'; $report.error = 'Native wizard-control helper could not initialize: ' + $_.Exception.Message
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $reports 'wizard-report.json') -Encoding utf8
  exit 2
}

function Wizard-Page([Diagnostics.Process]$Process) {
  Check-Deadline
  $Process.Refresh()
  if ($Process.HasExited) { return $null }
  foreach ($window in [PanLiteWizardNative]::Windows($Process.Id)) {
    if ($window.Class -ne '#32770') { continue }
    $controls = @([PanLiteWizardNative]::Children($window.Handle, $Process.Id))
    $next = @($controls | Where-Object { $_.Id -eq 1 -and $_.Class -eq 'Button' -and $_.Parent -eq $window.Handle })
    $back = @($controls | Where-Object { $_.Id -eq 3 -and $_.Class -eq 'Button' -and $_.Parent -eq $window.Handle })
    if ($next.Count -eq 1 -and $back.Count -eq 1) { return [pscustomobject]@{ Window=$window; Controls=$controls; Next=$next[0] } }
  }
  return $null
}
function Save-Page($Page, [Diagnostics.Process]$Process, [string]$Phase) {
  $script:pageNumber++
  $name = '{0:d2}-{1}' -f $script:pageNumber, $Phase
  $evidence = [ordered]@{ at=[DateTime]::UtcNow.ToString('o'); phase=$Phase; pid=$Process.Id; window=$Page.Window; controls=$Page.Controls }
  $evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $reports ($name + '.json')) -Encoding utf8
  $capture = [PanLiteWizardNative]::Capture($Page.Window.Handle, $Process.Id, (Join-Path $reports ($name + '.png')))
  $report.pages += [ordered]@{ phase=$Phase; evidence=($name + '.json'); capture=$capture }
}
function Wait-Exit([Diagnostics.Process]$Process, [int]$Seconds) {
  $deadline = $clock.Elapsed.TotalSeconds + $Seconds
  while (-not $Process.HasExited) {
    Check-Deadline
    if ($clock.Elapsed.TotalSeconds -gt $deadline) { Unsupported 'The wizard did not respond or exit before its deadline.' }
    Start-Sleep -Milliseconds 150; $Process.Refresh()
  }
  if ($Process.ExitCode -ne 0) { throw "Wizard exited with code $($Process.ExitCode)." }
}
function Run-Wizard([string]$Executable, [string[]]$Arguments, [bool]$Installing) {
  Check-Deadline
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
  $trackedProcesses[$process.Id] = $Executable
  Action ('started non-silent ' + $(if ($Installing) { 'installer' } else { 'uninstaller' }))
  $lastAction = -100.0; $pageDeadline = $clock.Elapsed.TotalSeconds + $PageTimeoutSeconds
  $script:activeWizard = $process
  $directorySet = $false; $directoryEntered = $false; $finishClicked = $false; $uninstallStarted = $false
  while (-not $process.HasExited) {
    Check-Deadline
    if ($clock.Elapsed.TotalSeconds -gt $pageDeadline) { Unsupported 'No readable or advancing NSIS wizard page was observed; no silent fallback was attempted.' }
    $page = Wizard-Page $process
    if ($page -and ($clock.Elapsed.TotalSeconds - $lastAction) -gt 0.5) {
      $edit = @($page.Controls | Where-Object { $_.Id -eq 1019 -and $_.Class -eq 'Edit' -and $_.LocalVisible -and $_.Enabled })
      if ($Installing -and $edit.Count -eq 1 -and -not $directorySet) {
        if (-not $directoryEntered) { [PanLiteWizardNative]::SetText($edit[0].Handle, $process.Id, $installRoot) }
        $verifiedPage = Wizard-Page $process
        $verifiedEdit = @($verifiedPage.Controls | Where-Object { $_.Handle -eq $edit[0].Handle })
        if ($verifiedEdit.Count -ne 1 -or $verifiedEdit[0].Text -ne $installRoot) { Unsupported 'The directory control could not be read back after editing.' }
        if (-not $directoryEntered) { Save-Page $verifiedPage $process 'install-directory'; $directoryEntered = $true }
        if ($verifiedPage.Next.Enabled) {
          [PanLiteWizardNative]::Click($verifiedPage.Next.Handle, $process.Id)
          $directorySet = $true; $lastAction = $clock.Elapsed.TotalSeconds; $pageDeadline = $lastAction + 120
          Action 'directory confirmed through control 1019; installation requested through Next'
        }
      } elseif ($Installing -and $directorySet -and -not $finishClicked) {
        $runBoxes = @($page.Controls | Where-Object { $_.Class -eq 'Button' -and $_.Kind -in @(2,3) -and $_.LocalVisible -and $_.Text.IndexOf('PanLite',[StringComparison]::OrdinalIgnoreCase) -ge 0 })
        if ($runBoxes.Count -eq 1 -and $page.Next.Enabled -and (Test-Path -LiteralPath $application)) {
          [PanLiteWizardNative]::Uncheck($runBoxes[0].Handle, $process.Id)
          if ([PanLiteWizardNative]::Checked($runBoxes[0].Handle, $process.Id) -ne 0) { Unsupported 'Run-after-finish checkbox did not become unchecked.' }
          Save-Page $page $process 'install-finish-run-disabled'
          [PanLiteWizardNative]::Click($page.Next.Handle, $process.Id)
          $finishClicked = $true; Action 'finish clicked with normal application launch disabled'
          Wait-Exit $process 20
        }
      } elseif (-not $Installing -and $page.Next.Enabled) {
        if (-not $uninstallStarted) {
          Save-Page $page $process 'uninstall-welcome'
          [PanLiteWizardNative]::Click($page.Next.Handle, $process.Id)
          $uninstallStarted = $true; $lastAction = $clock.Elapsed.TotalSeconds; $pageDeadline = $lastAction + 120
          Action 'non-silent uninstall requested through wizard button'
        } elseif (-not (Test-Path -LiteralPath $application)) {
          Save-Page $page $process 'uninstall-finish'
          [PanLiteWizardNative]::Click($page.Next.Handle, $process.Id)
          $finishClicked = $true; Wait-Exit $process 20
        }
      }
    }
    Start-Sleep -Milliseconds 150; $process.Refresh()
  }
  $script:activeWizard = $null
  if ($process.ExitCode -ne 0) { throw "Non-silent wizard exited with code $($process.ExitCode)." }
  if (-not $finishClicked -or ($Installing -and -not $directorySet)) { Unsupported 'The process exited without the required observed wizard transitions.' }
}
function Verify-Shortcut([string]$Link) {
  if (-not (Test-Path -LiteralPath $Link)) { throw "Expected shortcut was not created: $Link" }
  $shell = New-Object -ComObject WScript.Shell
  try {
    $shortcut = $shell.CreateShortcut($Link)
    $target = [IO.Path]::GetFullPath($shortcut.TargetPath)
    if ($target -ne $application -or $shortcut.Arguments) { throw 'Shortcut points outside the exact owned application or contains unexpected arguments.' }
    return [ordered]@{ path=$Link; target=$target; arguments=$shortcut.Arguments }
  } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}
function Has-OwnedInstallLocation($Entry) {
  if (-not $Entry.InstallLocation) { return $false }
  try { return [IO.Path]::GetFullPath([string]$Entry.InstallLocation).TrimEnd('\') -eq $installRoot }
  catch { return $false } # Unrelated software may have a malformed registry value.
}

function Save-FailureWindows {
  try {
    if ($script:activeWizard -and -not $script:activeWizard.HasExited) {
      $windows = @([PanLiteWizardNative]::Windows($script:activeWizard.Id) | ForEach-Object {
        [ordered]@{ window=$_; controls=@([PanLiteWizardNative]::Children($_.Handle, $script:activeWizard.Id)) }
      })
      $windows | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $reports 'failure-windows.json') -Encoding utf8
    }
  } catch { $report.failureWindowError = $_.Exception.Message }
}

try {
  Assert-PlainPath $installer $workspaceRoot; Assert-PlainPath $reports $workspaceRoot
  foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    if ((Test-Path $registryRoot) -and (Get-ChildItem $registryRoot | Get-ItemProperty | Where-Object { $_.DisplayName -like 'PanLite*' })) { throw 'Runner already contains a PanLite installation.' }
  }
  foreach ($unexpected in @($appDataRoot,$desktopLink,$menuLink)) { if (Test-Path -LiteralPath $unexpected) { throw 'Runner contains existing PanLite data or shortcuts; refusing to replace them.' } }
  Assert-PlainPath $appDataRoot ([IO.Path]::GetDirectoryName($appDataRoot))
  New-Item -ItemType Directory -Path $reports -Force | Out-Null
  New-Item -ItemType Directory -Path $ownedRoot | Out-Null
  Assert-PlainPath $ownedRoot $temporaryParent
  Set-Content -LiteralPath (Join-Path $ownedRoot 'wizard-owner.txt') -Value $runId -Encoding ascii
  New-Item -ItemType Directory -Path $appDataRoot | Out-Null; $createdAppData = $true
  Set-Content -LiteralPath $appDataMarker -Value $runId -Encoding ascii
  Run-Wizard $installer @('/currentuser') $true
  $report.installWizardCompleted = $true
  Assert-PlainPath $application $ownedRoot
  if (-not (Test-Path -LiteralPath $application)) { throw 'Wizard did not install the expected executable.' }
  $report.installed = $true
  $report.shortcutTargets = @((Verify-Shortcut $desktopLink),(Verify-Shortcut $menuLink)); $report.shortcutsVerified = $true
  $normalRunProbeStarted = $clock.Elapsed.TotalSeconds
  while (($clock.Elapsed.TotalSeconds - $normalRunProbeStarted) -lt 2) {
    Check-Deadline
    foreach ($unexpectedProcess in @(Get-Process -Name PanLite -ErrorAction SilentlyContinue)) {
      $observedPath = $null
      try { $observedPath = $unexpectedProcess.Path } catch { continue }
      if ($observedPath -and [IO.Path]::GetFullPath($observedPath) -eq $application) { throw 'Finish asynchronously started the normal application; Run checkbox prevention failed.' }
    }
    Start-Sleep -Milliseconds 100
  }
  $report.normalRunPreventionProbeSeconds = $clock.Elapsed.TotalSeconds - $normalRunProbeStarted
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $startupReport = Join-Path $reports 'installed-startup.json'
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $node; $startInfo.WorkingDirectory = $projectRoot; $startInfo.UseShellExecute = $false; $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true; $startInfo.RedirectStandardError = $true
  $startInfo.Arguments = (@((Join-Path $PSScriptRoot 'check-install-profile.mjs'),'launch',$application,$profile,$startupReport) | ForEach-Object { Quote-Argument $_ }) -join ' '
  $startup = [Diagnostics.Process]::Start($startInfo); $trackedProcesses[$startup.Id] = $node
  $stdout = $startup.StandardOutput.ReadToEndAsync(); $stderr = $startup.StandardError.ReadToEndAsync()
  Wait-Exit $startup 75
  $stdout.Result | Set-Content -LiteralPath (Join-Path $reports 'startup-stdout.txt'); $stderr.Result | Set-Content -LiteralPath (Join-Path $reports 'startup-stderr.txt')
  $started = Get-Content -LiteralPath $startupReport -Raw | ConvertFrom-Json
  if ($started.version -ne $ExpectedVersion -or -not $started.renderer.textLength) { throw 'Installed application version or hidden first-screen validation failed.' }
  $report.hiddenStartup = $true
  $uninstaller = @(Get-ChildItem -LiteralPath $installRoot -Filter '*Uninstall*.exe' -File)
  if ($uninstaller.Count -ne 1) { throw 'Expected one owned uninstaller.' }
  Assert-PlainPath $uninstaller[0].FullName $ownedRoot
  # NSIS consumes the entire remaining command line after _?=. It must stay
  # last and unquoted, including when the installation path contains spaces.
  Run-Wizard $uninstaller[0].FullName @('/currentuser',("_?=$installRoot")) $false
  $report.uninstallWizardCompleted = $true
  if (Test-Path -LiteralPath $application) { throw 'Application remains after the interactive uninstall.' }
  foreach ($link in @($desktopLink,$menuLink)) { if (Test-Path -LiteralPath $link) { throw 'Application shortcut remains after uninstall.' } }
  foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    if ((Test-Path $registryRoot) -and (Get-ChildItem $registryRoot | Get-ItemProperty | Where-Object { $_.DisplayName -like 'PanLite*' -or (Has-OwnedInstallLocation $_) })) { throw 'PanLite or the exact owned InstallLocation remains registered after the wizard completed.' }
  }
  $report.ownedUninstallRegistrationRemoved = $true
  if (-not (Test-Path -LiteralPath $appDataMarker) -or (Get-Content -LiteralPath $appDataMarker -Raw).Trim() -ne $runId) { throw 'Default APPDATA marker was removed or changed by uninstall.' }
  $report.appDataMarkerPreserved = $true; $report.status = 'passed'; $report.passed = $true
} catch [NotSupportedException] {
  Save-FailureWindows
  $report.status = 'unsupported'; $report.error = $_.Exception.Message
} catch {
  Save-FailureWindows
  $report.status = 'failed'; $report.error = $_.Exception.Message
} finally {
  foreach ($processId in @($trackedProcesses.Keys)) {
    $live = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($live) { try { if ([IO.Path]::GetFullPath($live.Path) -eq $trackedProcesses[$processId]) { Stop-Process -Id $processId -Force -ErrorAction Stop } } catch { $report.actions += [ordered]@{ action='owned-process-cleanup-failed'; pid=$processId } } }
  }
  foreach ($ownedApplicationProcess in @(Get-Process -Name PanLite -ErrorAction SilentlyContinue)) {
    try { if ([IO.Path]::GetFullPath($ownedApplicationProcess.Path) -eq $application) { Stop-Process -Id $ownedApplicationProcess.Id -Force -ErrorAction Stop } } catch { $report.actions += [ordered]@{ action='owned-application-cleanup-failed' } }
  }
  if ($createdAppData -and (Test-Path -LiteralPath $appDataMarker)) {
    if ((Get-Content -LiteralPath $appDataMarker -Raw).Trim() -eq $runId) { Remove-Item -LiteralPath $appDataMarker -Force }
    if (@(Get-ChildItem -LiteralPath $appDataRoot -Force).Count -eq 0) { Remove-Item -LiteralPath $appDataRoot }
  }
  if (Test-Path -LiteralPath $ownedRoot) {
    if ($report.passed) {
      try {
        Assert-PlainPath $ownedRoot $temporaryParent
        if ((Get-Content -LiteralPath (Join-Path $ownedRoot 'wizard-owner.txt') -Raw).Trim() -ne $runId) { throw 'Owned-directory marker changed.' }
        if (Get-ChildItem -LiteralPath $ownedRoot -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Refusing recursive cleanup of a linked directory.' }
        Remove-Item -LiteralPath $ownedRoot -Recurse -Force
      } catch { $report.passed=$false; $report.status='failed'; $report.cleanupError=$_.Exception.Message }
    } else { $report.retainedDiagnosticRoot = $ownedRoot }
  }
  $report.elapsedSeconds = $clock.Elapsed.TotalSeconds
  if (-not (Test-Path -LiteralPath $reports)) { New-Item -ItemType Directory -Path $reports -Force | Out-Null }
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $reports 'wizard-report.json') -Encoding utf8
}
if ($report.status -eq 'unsupported') { exit 2 }
if (-not $report.passed) { exit 1 }
