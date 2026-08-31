$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DevbuildDir = Join-Path $RepoRoot 'tools\orion-devbuild-installer'
$BundleDir = Join-Path $RepoRoot 'tools\orion-vencord-bundle'
$Helper = Join-Path $DevbuildDir 'installer-common.ps1'
$BundleVerifier = Join-Path $BundleDir 'verify-vencord-target.ps1'
$Workflow = Join-Path $RepoRoot '.github\workflows\installer.yml'
$Packager = Join-Path $RepoRoot 'tools\package-release.ps1'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Assert-False([bool]$Condition, [string]$Message) {
    if ($Condition) { throw $Message }
}
function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) { throw "$Message`nExpected: $Expected`nActual:   $Actual" }
}
function Assert-SequenceEqual([object[]]$Actual, [object[]]$Expected, [string]$Message) {
    $a = @($Actual); $e = @($Expected)
    if ($a.Count -ne $e.Count) { throw "$Message`nExpected: $($e -join ', ')`nActual:   $($a -join ', ')" }
    for ($i = 0; $i -lt $e.Count; $i++) {
        if ($a[$i] -ne $e[$i]) { throw "$Message`nExpected: $($e -join ', ')`nActual:   $($a -join ', ')" }
    }
}
function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $threw = $false
    try { & $Action } catch { $threw = $true }
    if (-not $threw) { throw $Message }
}

Assert-True (Test-Path $Helper) 'installer-common.ps1 is required so install/update/uninstall share one tested Discord/toolchain implementation.'
. $Helper

Assert-Equal (Resolve-DiscordFlavor -Installed @('stable', 'canary') -Running @('canary')) 'canary' 'Running Canary must win when Stable is also installed.'
Assert-Equal (Resolve-DiscordFlavor -Installed @('stable', 'ptb') -Running @('ptb')) 'ptb' 'Running PTB must win when Stable is also installed.'
Assert-Equal (Resolve-DiscordFlavor -Installed @('canary') -Running @()) 'canary' 'A single installed flavor is unambiguous even when Discord is closed.'
Assert-Equal (Resolve-DiscordFlavor -Installed @('stable', 'canary') -Running @() -PreferredBranch 'canary') 'canary' 'An explicit installed branch must be honored.'
Assert-Throws { Resolve-DiscordFlavor -Installed @('stable', 'canary') -Running @() } 'Multiple installed flavors with none running must not silently fall back to Stable.'
Assert-Throws { Resolve-DiscordFlavor -Installed @('stable', 'canary') -Running @('stable', 'canary') } 'Multiple running flavors are ambiguous and must not be guessed.'

Assert-SequenceEqual (Get-DiscordReopenSet -RunningBefore @('canary') -TargetBranch 'stable') @('canary', 'stable') 'Patch Stable while Canary was running must reopen both Canary and the patched Stable target.'
Assert-SequenceEqual (Get-DiscordReopenSet -RunningBefore @('canary') -TargetBranch 'canary') @('canary') 'The target must not be duplicated in the reopen set.'
Assert-SequenceEqual (Get-DiscordReopenSet -RunningBefore @() -TargetBranch 'ptb') @('ptb') 'A closed client install must reopen the target that was patched.'

$roots = @('C:\Users\ci\AppData\Local\Discord','C:\Users\ci\AppData\Local\DiscordCanary','C:\Users\ci\AppData\Local\DiscordPTB')
Assert-True (Test-IsDiscordUpdaterPath -Path 'C:\Users\ci\AppData\Local\DiscordCanary\Update.exe' -DiscordRoots $roots) 'Discord Canary updater must be recognized as Discord-owned.'
Assert-False (Test-IsDiscordUpdaterPath -Path 'C:\Program Files\SomeOtherApp\Update.exe' -DiscordRoots $roots) 'An unrelated Update.exe must never be classified as Discord-owned.'

$temp = Join-Path ([IO.Path]::GetTempPath()) ("orion-installer-test-" + [guid]::NewGuid().ToString('N'))
try {
    $discordRoot = Join-Path $temp 'DiscordCanary'
    $oldResources = Join-Path $discordRoot 'app-1.0.100\resources'
    $newResources = Join-Path $discordRoot 'app-1.0.200\resources'
    New-Item -ItemType Directory -Force -Path $oldResources, $newResources | Out-Null
    (Get-Item (Split-Path $oldResources -Parent)).LastWriteTime = (Get-Date).AddMinutes(10)
    (Get-Item (Split-Path $newResources -Parent)).LastWriteTime = (Get-Date).AddMinutes(-10)
    Assert-Equal (Select-VencordDiscordResourcesPath -DiscordRoot $discordRoot) $newResources 'Verification must select the same app-* target rule as Vencord Installer.'
} finally { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("orion-asar-test-" + [guid]::NewGuid().ToString('N'))
try {
    $resources = Join-Path $temp 'resources'
    New-Item -ItemType Directory -Force -Path $resources | Out-Null
    $asar = Join-Path $resources 'app.asar'
    $backup = Join-Path $resources '_app.asar'
    $ours = Join-Path $temp 'OrionVencord\dist\patcher.js'
    $other = Join-Path $temp 'OtherVencord\dist\patcher.js'
    $collision = $ours + '.backup'

    $serializedCollision = ([IO.Path]::GetFullPath($collision)).Replace('\', '\\')
    Set-Content -LiteralPath $asar -Value ("require(`"$serializedCollision`")") -Encoding UTF8
    Assert-False (Test-AppAsarPointsToPatcher -AppAsar $asar -PatcherPath $ours) 'A path whose text merely starts with our patcher path must be rejected.'

    $serializedOurs = ([IO.Path]::GetFullPath($ours)).Replace('\', '\\')
    Set-Content -LiteralPath $asar -Value ("require(`"$serializedOurs`")") -Encoding UTF8
    Assert-True (Test-AppAsarPointsToPatcher -AppAsar $asar -PatcherPath $ours) 'Exact OrionVencord patcher path must be accepted.'
    Assert-False (Test-AppAsarPointsToPatcher -AppAsar $asar -PatcherPath $other) 'A different checkout must not be treated as ours.'

    Set-Content -LiteralPath $backup -Value 'original discord app.asar' -Encoding UTF8
    Assert-True (Restore-VencordAppAsar -AppAsar $asar -PatcherPath $ours) 'Restore helper must replace the Orion stub with _app.asar.'
    Assert-True (Test-Path -LiteralPath $asar -PathType Leaf) 'Restore helper must leave app.asar present.'
    Assert-False (Test-Path -LiteralPath $backup -PathType Leaf) 'Successful restore must consume _app.asar.'
    Assert-False (Test-AppAsarPointsToPatcher -AppAsar $asar -PatcherPath $ours) 'Restored app.asar must no longer point at OrionVencord.'

    Set-Content -LiteralPath $asar -Value ("require(`"$serializedOurs`")") -Encoding UTF8
    Assert-False (Restore-VencordAppAsar -AppAsar $asar -PatcherPath $ours) 'Restore must fail when _app.asar is missing instead of reporting success.'
    Assert-True (Test-AppAsarPointsToPatcher -AppAsar $asar -PatcherPath $ours) 'A failed restore with no backup must leave the current Orion stub untouched.'
} finally { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }

$tempPackage = Join-Path ([IO.Path]::GetTempPath()) ("orion-package-" + [guid]::NewGuid().ToString('N') + '.json')
try {
    '{"packageManager":"pnpm@11.9.0","engines":{"node":">=22"}}' | Set-Content -Path $tempPackage -Encoding UTF8
    $pnpm = Get-PnpmInvocation -PackageJsonPath $tempPackage
    Assert-True (-not [string]::IsNullOrWhiteSpace($pnpm.Command)) 'A pnpm command must be resolved.'
    Assert-True ($null -ne (Get-Command $pnpm.Command -ErrorAction SilentlyContinue)) "Resolved pnpm launcher '$($pnpm.Command)' must exist on PATH."
    $nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
    if ($nodeMajor -ge 25) {
        Assert-True ($null -ne (Get-Command npx -ErrorAction SilentlyContinue)) 'Node 25 fallback requires npx from the normal Node distribution.'
        $actualPnpmVersion = (& npx --yes pnpm@11.9.0 --version | Select-Object -Last 1).Trim()
        Assert-Equal $actualPnpmVersion '11.9.0' 'The Node 25 npx fallback must execute the exact pnpm version declared by Vencord.'
        if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) { Assert-Equal $pnpm.Command 'npx' 'Without Corepack the resolver must select npx.' }
    }
} finally { Remove-Item $tempPackage -Force -ErrorAction SilentlyContinue }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("orion-bundle-test-" + [guid]::NewGuid().ToString('N'))
try {
    $vencordRoot = Join-Path $temp 'Roaming\Vencord'
    $customRoot = Join-Path $temp 'Local\OtherVencord'
    New-Item -ItemType Directory -Force -Path $vencordRoot, $customRoot | Out-Null
    $asar = Join-Path $temp 'app.asar'
    $expected = [IO.Path]::GetFullPath((Join-Path $vencordRoot 'dist\patcher.js'))

    $collision = $expected + '.backup'
    $serializedCollision = $collision.Replace('\', '\\')
    Set-Content -LiteralPath $asar -Value ("binary-header require(`"$serializedCollision`") tail") -Encoding UTF8
    & powershell -NoProfile -ExecutionPolicy Bypass -File $BundleVerifier -AppAsar $asar -VencordRoot $vencordRoot
    Assert-Equal $LASTEXITCODE 1 'Bundle verifier must reject a prefix collision instead of substring-matching our patcher path.'

    $serialized = $expected.Replace('\', '\\')
    Set-Content -LiteralPath $asar -Value ("binary-header require(`"$serialized`") tail") -Encoding UTF8
    & powershell -NoProfile -ExecutionPolicy Bypass -File $BundleVerifier -AppAsar $asar -VencordRoot $vencordRoot
    Assert-Equal $LASTEXITCODE 0 'Bundle verifier must accept a stub pointing at the shared Vencord dist.'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $BundleVerifier -AppAsar $asar -VencordRoot $customRoot
    Assert-Equal $LASTEXITCODE 1 'Bundle verifier must reject a stub pointing at a different Vencord checkout.'
    $global:LASTEXITCODE = 0
} finally { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("orion-bundle-cmd-test-" + [guid]::NewGuid().ToString('N'))
$oldAppData = $env:APPDATA
$oldLocalAppData = $env:LOCALAPPDATA
try {
    $roaming = Join-Path $temp 'Roaming'
    $local = Join-Path $temp 'Local'
    $bundleCopy = Join-Path $temp 'bundle'
    $vencordDist = Join-Path $roaming 'Vencord\dist'
    $stableResources = Join-Path $local 'Discord\app-1.0.100\resources'
    $canaryResources = Join-Path $local 'DiscordCanary\app-1.0.200\resources'
    New-Item -ItemType Directory -Force -Path $bundleCopy, $vencordDist, $stableResources, $canaryResources | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $bundleCopy 'dist') | Out-Null

    Copy-Item (Join-Path $BundleDir 'INSTALL.cmd') $bundleCopy
    Copy-Item $BundleVerifier $bundleCopy
    Set-Content -LiteralPath (Join-Path $bundleCopy 'dist\patcher.js') -Value "// Vencord deadbeef`n// Standalone: true`n// Updater Disabled: true`norion-patcher" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $bundleCopy 'dist\preload.js') -Value "// Vencord deadbeef`norion-preload" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $bundleCopy 'dist\renderer.js') -Value "// Vencord deadbeef`nOrionQuests`norion-renderer" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $bundleCopy 'dist\renderer.css') -Value 'orion-css' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $vencordDist 'patcher.js') -Value 'official-patcher' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $vencordDist 'preload.js') -Value 'official-preload' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $vencordDist 'renderer.js') -Value 'official-renderer' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $vencordDist 'renderer.css') -Value 'official-css' -Encoding ASCII

    New-Item -ItemType File -Force -Path (Join-Path $local 'Discord\Update.exe'), (Join-Path $local 'DiscordCanary\Update.exe') | Out-Null
    Set-Content -LiteralPath (Join-Path $stableResources 'app.asar') -Value 'plain discord app' -Encoding UTF8
    $sharedPatcher = [IO.Path]::GetFullPath((Join-Path $vencordDist 'patcher.js'))
    $serializedSharedPatcher = $sharedPatcher.Replace('\', '\\')
    Set-Content -LiteralPath (Join-Path $canaryResources 'app.asar') -Value ("require(`"$serializedSharedPatcher`")") -Encoding UTF8

    $env:APPDATA = $roaming
    $env:LOCALAPPDATA = $local
    Push-Location $bundleCopy
    try {
        & cmd.exe /d /c 'INSTALL.cmd <nul'
        $bundleExit = $LASTEXITCODE
    } finally { Pop-Location }

    Assert-Equal $bundleExit 0 'Simple bundle INSTALL.cmd must complete successfully in the isolated Canary smoke test.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $vencordDist 'patcher.js') -Raw).Contains('orion-patcher')) 'Bundle installer must copy the bundled patcher into the shared Vencord dist.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $vencordDist 'renderer.js') -Raw).Contains('orion-renderer')) 'Bundle installer must copy the bundled renderer into the shared Vencord dist.'
    $backupDist = Join-Path $roaming 'Vencord\dist.orion-backup'
    Assert-Equal ((Get-Content -LiteralPath (Join-Path $backupDist 'patcher.js') -Raw).Trim()) 'official-patcher' 'Bundle installer must preserve the original patcher in its recovery backup.'
    Assert-Equal ((Get-Content -LiteralPath (Join-Path $backupDist 'renderer.js') -Raw).Trim()) 'official-renderer' 'Bundle installer must preserve the original renderer in its recovery backup.'
} finally {
    $env:APPDATA = $oldAppData
    $env:LOCALAPPDATA = $oldLocalAppData
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}

$install = Get-Content (Join-Path $DevbuildDir 'install-autoupdate.ps1') -Raw
$update = Get-Content (Join-Path $DevbuildDir 'update.ps1') -Raw
$uninstall = Get-Content (Join-Path $DevbuildDir 'uninstall.ps1') -Raw
$helperText = Get-Content $Helper -Raw
$devReadme = Get-Content (Join-Path $DevbuildDir 'README.txt') -Raw
$bundle = Get-Content (Join-Path $BundleDir 'INSTALL.cmd') -Raw
$workflowText = Get-Content $Workflow -Raw
$packagerText = Get-Content $Packager -Raw

foreach ($pair in @(@{Name='install-autoupdate.ps1';Text=$install},@{Name='update.ps1';Text=$update},@{Name='uninstall.ps1';Text=$uninstall})) {
    Assert-True ($pair.Text -match 'installer-common\.ps1') "$($pair.Name) must use the shared tested installer helpers."
    Assert-False ($pair.Text -match 'Get-Process[^\r\n]*\bUpdate\b') "$($pair.Name) must not kill every process named Update.exe."
}

Assert-True ($helperText -match 'remaining' -and $helperText -match 'throw') 'Stop-DiscordProcesses must fail if Discord is still alive after its timeout.'
Assert-True ($helperText -match 'serializedExpected') 'app.asar ownership verification must compare the complete JSON-quoted patcher path.'
Assert-True ($helperText -match 'Restore-VencordAppAsar') 'Shared helper must expose a verified app.asar restore path.'
Assert-True ($helperText -match 'Write-OrionVencordHealthStamp') 'Managed Vencord builds must persist a runtime health stamp after semantic verification.'
Assert-True ($helperText -match 'Test-OrionVencordDistHealthy') 'Transactional rollback must require a previously stamped healthy dist.'
Assert-True ($helperText -match 'Get-FileHash[^\r\n]*SHA256') 'The Vencord health stamp must bind the runtime files with SHA-256 hashes.'
Assert-True ($install -match 'Get-DiscordReopenSet') 'Install must derive its reopen set from the patched target plus previously running clients.'
Assert-True ($install -match 'Test-AppAsarPointsToPatcher') 'Install verification must use the exact OrionVencord patcher path.'
Assert-False ($install -match "-like '\*OrionVencord\*'") 'Install verification must not use a loose OrionVencord substring.'
Assert-False ($install -match 'corepack is missing') 'Install must not reject supported Node versions solely because bundled Corepack is absent.'
Assert-True ($install -match 'Invoke-Pnpm') 'Install must use the shared pnpm invocation that supports Node 25+.'
Assert-True ($install -match 'Restore-VencordAppAsar') 'Install rollback must use the checked restore helper when Vencord unpatch does not verify.'
Assert-True ($install -match 'rollback could not be verified') 'Install must fail closed when rollback cannot be verified.'
Assert-True ($update -match '\$fetchCode') 'Plugin update fallback must record git fetch success explicitly.'
Assert-True ($update -match '\$resetCode') 'Plugin update fallback must record git reset success explicitly.'
Assert-True ($update -match '\$fetchCode\s*-eq\s*0\s*-and\s*\$resetCode\s*-eq\s*0') 'A stale FETCH_HEAD reset must not be reported as a successful plugin update.'
Assert-True ($update -match 'keeping the existing checkout') 'A transient GitHub failure must preserve an existing usable plugin checkout instead of deleting it.'
Assert-True ($update -match '\$existingCheckoutUsable') 'Update must explicitly gate preservation on a usable existing plugin checkout.'
Assert-True ($update -match 'Get-RunningDiscordFlavors') 'Update must remember which Discord flavor(s) were running before restart.'
Assert-True ($update -match 'Start-DiscordFlavors') 'Update must reopen the same running flavor(s), not the first installed flavor.'
Assert-True ($uninstall -match 'Restore-VencordAppAsar') 'Uninstall must only count a restore after the checked restore helper succeeds.'
Assert-False ($uninstall -match "-notlike '\*OrionVencord\*'") 'Uninstall must not use a loose OrionVencord substring.'
Assert-True ($uninstall -match 'Do NOT delete') 'A partial uninstall must warn users not to delete OrionVencord before Repair/Uninstall succeeds.'
Assert-True ($uninstall -match 'Discord was left closed') 'A partial uninstall must fail closed instead of reopening a potentially broken client.'
Assert-True ($uninstall -match 'Get-RunningDiscordFlavors') 'Uninstall must remember which Discord flavor(s) were running before restart.'
Assert-True ($uninstall -match 'Start-DiscordFlavors') 'Successful uninstall must reopen the same running flavor(s), not the first installed flavor.'
Assert-True ($devReadme -match 'DiscordCanary') 'Recovery documentation must include the Canary install root.'
Assert-True ($devReadme -match 'DiscordPTB') 'Recovery documentation must include the PTB install root.'
Assert-False ($packagerText.Contains("StartsWith('_')")) 'Release packaging must not ignore underscore-prefixed userplugin entries because native discovery still scans them.'
Assert-False ($packagerText.Contains("StartsWith('.')")) 'Release packaging must not ignore dot-prefixed userplugin entries because native discovery still scans them.'
Assert-True ($packagerText.Contains('additional Vencord userplugin entries are present')) 'Release packaging must fail closed on foreign userplugin entries instead of relying on a marker blacklist.'

foreach ($needle in @('Discord.exe','DiscordCanary.exe','DiscordPTB.exe','WAS_CANARY','WAS_PTB','PATCHED_STABLE','PATCHED_CANARY','PATCHED_PTB','check_vencord_target','verify-vencord-target.ps1','discord_still_running','backup_failed','copy_failed','restore_failed','invalid_backup')) {
    Assert-True ($bundle.Contains($needle)) "Simple bundle installer is missing '$needle'."
}
Assert-True ($bundle -match 'WAS_CANARY.+PATCHED_CANARY') 'Running Canary must be rejected when Canary itself does not point at the shared Vencord build.'
Assert-True ($bundle -match 'WAS_PTB.+PATCHED_PTB') 'Running PTB must be rejected when PTB itself does not point at the shared Vencord build.'
Assert-True ($bundle.Contains('goto :discord_still_running')) 'Bundle must verify taskkill actually closed Discord before copying Vencord files.'
Assert-True ($bundle.Contains('Could not create a complete Vencord backup')) 'Bundle must fail safely when its first backup cannot be completed.'
Assert-True ($bundle.Contains('Automatic rollback also failed')) 'Bundle must surface rollback failure instead of claiming the original Vencord was restored.'
Assert-True ($bundle.Contains('call :check_dist_complete "%APPDATA%\Vencord\dist.orion-backup"')) 'Bundle recovery validation must apply the complete runtime manifest to its saved backup.'
Assert-True ($workflowText.Contains('tools/package-release.ps1')) 'Installer CI must run when release packaging changes.'
Assert-True ($workflowText.Contains('shell: powershell')) 'Installer CI must exercise Windows PowerShell 5.1, which the shipped CMD wrappers use.'
Assert-True ($workflowText.Contains('shell: pwsh')) 'Installer CI must also exercise PowerShell 7.'

Write-Host 'Installer regression tests passed.' -ForegroundColor Green
exit 0
