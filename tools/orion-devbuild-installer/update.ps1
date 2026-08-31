<#
  Update the Orion Quests auto-update edition.

  Vencord's in-app updater does git pull + rebuild but does not run pnpm install first.
  This script does the full pull + dependency install + transactional build, then
  restarts only the Discord flavor(s) that were actually running before the restart.
#>
$ErrorActionPreference = 'Stop'
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$InstallDir = Join-Path $env:LOCALAPPDATA 'OrionVencord'
$PluginSrc  = Join-Path $PSScriptRoot 'plugin'
$PluginRepoUrl = 'https://github.com/nyxxbit/discord-quest-completer'

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Good($m) { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Fail($m) { Write-Host ''; Write-Host "  ERROR: $m" -ForegroundColor Red; Write-Host ''; try { Read-Host 'Press Enter to exit' } catch {}; exit 1 }
function Step([string]$what, [scriptblock]$run) {
    $global:LASTEXITCODE = 0
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $run } finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE). See output above." }
}

$Common = Join-Path $PSScriptRoot 'installer-common.ps1'
if (-not (Test-Path -LiteralPath $Common -PathType Leaf)) { Fail 'installer-common.ps1 is missing. Re-download/extract the full installer zip.' }
. $Common

if (-not (Test-Path (Join-Path $InstallDir '.git'))) { Fail "No OrionVencord install found at $InstallDir. Run INSTALL-autoupdate.cmd first." }
if (-not (Test-Path $PluginSrc)) { Fail 'plugin source folder not found next to this script. Extract the whole zip.' }

Info 'Updating Vencord source...'
$global:LASTEXITCODE = 0; $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
git -C $InstallDir pull --ff-only --quiet
$pc = $LASTEXITCODE; $ErrorActionPreference = $prev
if ($pc -ne 0) {
    Warn '  Fast-forward failed - hard-resetting to origin/main...'
    Step 'git fetch' { git -C $InstallDir fetch --depth 1 --quiet origin main }
    Step 'git reset' { git -C $InstallDir reset --hard --quiet FETCH_HEAD }
}

Info 'Updating the plugin...'
$dest = Join-Path $InstallDir 'src\userplugins\orionQuests'
$pluginReady = $false
$existingCheckoutUsable = $false
if (Test-Path (Join-Path $dest '.git')) {
    $existingCheckoutUsable = Test-Path (Join-Path $dest 'index.tsx') -PathType Leaf
    $updatedFromGit = $false
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        git -C $dest pull --ff-only --quiet
        $pullCode = $LASTEXITCODE
        if ($pullCode -eq 0) {
            $updatedFromGit = Test-Path (Join-Path $dest 'index.tsx') -PathType Leaf
        } else {
            git -C $dest fetch --depth 1 --quiet origin HEAD
            $fetchCode = $LASTEXITCODE
            $resetCode = 1
            if ($fetchCode -eq 0) {
                git -C $dest reset --hard --quiet FETCH_HEAD
                $resetCode = $LASTEXITCODE
            }
            $updatedFromGit = ($fetchCode -eq 0 -and $resetCode -eq 0 -and (Test-Path (Join-Path $dest 'index.tsx') -PathType Leaf))
        }
    } finally {
        $ErrorActionPreference = $prev
    }

    if ($updatedFromGit) {
        Good '  Plugin updated from git.'
        $pluginReady = $true
    } elseif ($existingCheckoutUsable -and (Test-Path (Join-Path $dest 'index.tsx') -PathType Leaf)) {
        Warn "  Couldn't update the plugin from GitHub; keeping the existing checkout instead of replacing it with the bundled copy."
        $pluginReady = $true
    }
}

if (-not $pluginReady) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
    git clone --depth 1 --quiet $PluginRepoUrl $dest 2>&1 | Out-Null
    $ok = ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $dest 'index.tsx') -PathType Leaf))
    $ErrorActionPreference = $prev
    if ($ok) {
        Good '  Plugin converted to a git checkout; future updates pull automatically.'
        $pluginReady = $true
    } else {
        Warn "  Couldn't reach GitHub for the plugin, using the copy in this zip instead."
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item (Join-Path $PluginSrc '*') $dest -Recurse -Force
        if (-not (Test-Path (Join-Path $dest 'index.tsx') -PathType Leaf)) { Fail 'bundled plugin copy is incomplete (index.tsx is missing).' }
        $pluginReady = $true
    }
}

Push-Location $InstallDir
try {
    try { $pnpm = Get-PnpmInvocation -PackageJsonPath (Join-Path $InstallDir 'package.json') }
    catch { Fail $_.Exception.Message }
    Info 'Installing dependencies...'
    Step 'pnpm install' { Invoke-Pnpm -Invocation $pnpm -Arguments @('install') }
    Info 'Building transactionally...'
    try { Invoke-VencordBuildTransactional -InstallDir $InstallDir -Invocation $pnpm -RequiredMarker 'OrionQuests' }
    catch { Fail $_.Exception.Message }
    Good 'Build verified. The previous working dist would have been restored automatically on failure.'
} finally { Pop-Location }

$runningBefore = @(Get-RunningDiscordFlavors)
if ($runningBefore.Count -gt 0) {
    Good "Updated. Restarting: $($runningBefore -join ', ')"
    try { Stop-DiscordProcesses } catch { Fail $_.Exception.Message }
    Start-Sleep -Seconds 2
    $failedReopen = @(Start-DiscordFlavors -Branches $runningBefore)
    if ($failedReopen.Count -gt 0) {
        Warn "Update succeeded, but these Discord clients did not reopen automatically: $($failedReopen -join ', ')."
        Warn 'Start them manually. If one still will not open, run the official Vencord installer and choose Repair.'
    }
} else {
    Good 'Updated. Discord was not running, so it was left closed.'
}
Write-Host ''
try { Read-Host 'Press Enter to close' } catch {}
