<#
  Orion Quests - Vencord "auto-update edition" installer.

  Builds Vencord from source with the OrionQuests plugin baked in, as a real git
  clone. Because the plugin lives in src/userplugins (gitignored upstream) and the
  install is a git checkout, Vencord's own updater keeps working: it git-pulls and
  rebuilds, and the plugin is recompiled back in every time.

  Flow: preflight Discord -> ensure Node 22+ and Git (winget if missing) -> clone/pull
  Vencord into %LOCALAPPDATA%\OrionVencord -> drop the plugin -> pnpm install ->
  transactional build -> verify -> patch the selected Discord flavor. Build happens
  BEFORE inject. Pass -SkipInject to do everything except patch Discord.
#>
param(
    [switch]$SkipInject,
    [ValidateSet('stable', 'canary', 'ptb')][string]$DiscordBranch
)

$ErrorActionPreference = 'Stop'
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$InstallDir = Join-Path $env:LOCALAPPDATA 'OrionVencord'
$PluginSrc  = Join-Path $PSScriptRoot 'plugin'
$RepoUrl    = 'https://github.com/Vendicated/Vencord'
$PluginRepoUrl = 'https://github.com/nyxxbit/discord-quest-completer'

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Good($m) { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Pause2($m) { try { Read-Host $m } catch {} }
function Fail($m) { Write-Host ''; Write-Host "  ERROR: $m" -ForegroundColor Red; Write-Host ''; Pause2 'Press Enter to exit'; exit 1 }
function Have($c) { $null -ne (Get-Command $c -ErrorAction SilentlyContinue) }
function RefreshPath { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

$Common = Join-Path $PSScriptRoot 'installer-common.ps1'
if (-not (Test-Path -LiteralPath $Common -PathType Leaf)) { Fail 'installer-common.ps1 is missing. Extract the whole zip and keep the files together.' }
. $Common

function Step([string]$what, [scriptblock]$run) {
    $global:LASTEXITCODE = 0
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $run } finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE). See the output above." }
}

function EnsureTool([string]$cmd, [string]$wingetId, [string]$name, [string]$url) {
    if (Have $cmd) { return }
    if (Have winget) {
        Warn "  $name not found - installing via winget (a 'Do you want to allow changes?' box may pop up - click Yes)..."
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        winget install -e --id $wingetId --accept-source-agreements --accept-package-agreements
        $ErrorActionPreference = $prev
        RefreshPath
    }
    if (-not (Have $cmd)) { Fail "$name is still not available. Install it from $url , then close this window and run the installer again. (If winget asked for a reboot, reboot first.)" }
}

function Choose-DiscordBranch {
    param([string[]]$Installed, [string[]]$Running, [string]$PreferredBranch)

    try { return Resolve-DiscordFlavor -Installed $Installed -Running $Running -PreferredBranch $PreferredBranch }
    catch {
        if ($PreferredBranch -or $Installed.Count -eq 0) { Fail $_.Exception.Message }
        Warn "  $($_.Exception.Message)"
        Write-Host "  Installed: $($Installed -join ', ')"
        if ($Running.Count -gt 0) { Write-Host "  Running:   $($Running -join ', ')" }
        $choice = (Read-Host '  Type the Discord branch to patch (stable/canary/ptb)').Trim().ToLowerInvariant()
        try { return Resolve-DiscordFlavor -Installed $Installed -Running @() -PreferredBranch $choice }
        catch { Fail $_.Exception.Message }
    }
}

Write-Host '==============================================================' -ForegroundColor Magenta
Write-Host '   Orion Quests - Vencord auto-update edition installer' -ForegroundColor Magenta
Write-Host '==============================================================' -ForegroundColor Magenta
Write-Host ''
Write-Host ' This builds Vencord from source with the plugin included, so Vencord keeps'
Write-Host ' auto-updating (unlike the simple bundle, which freezes it).'
Write-Host ''
Write-Host ' Expect 5-15 minutes and about 300 MB of downloads. It will sit on' -ForegroundColor Yellow
Write-Host " 'Installing dependencies' with scrolling text for a while - that is normal," -ForegroundColor Yellow
Write-Host ' do NOT close the window.' -ForegroundColor Yellow
Write-Host ''
Write-Host ' It installs into:' -NoNewline; Write-Host " $InstallDir" -ForegroundColor Yellow
Write-Host ' Do NOT move or delete that folder afterwards - Discord loads Vencord from it.' -ForegroundColor Yellow
Write-Host ''
if (-not (Test-Path $PluginSrc)) { Fail "plugin source folder not found next to this script ($PluginSrc). Extract the whole zip and keep the files together." }

# Fail fast on Discord selection before installing system-wide prerequisites or making the
# user wait through a Vencord build. -SkipInject intentionally needs no Discord install.
$targetBranch = $null
if (-not $SkipInject) {
    Info '[preflight] Checking the Discord client to patch...'
    $installedPreflight = @(Get-InstalledDiscordFlavors)
    $runningPreflight = @(Get-RunningDiscordFlavors)
    $targetBranch = Choose-DiscordBranch -Installed $installedPreflight -Running $runningPreflight -PreferredBranch $DiscordBranch
    Good "  Target selected: Discord $targetBranch"
}

Info '[1/6] Checking Node.js and Git...'
EnsureTool 'node' 'OpenJS.NodeJS.LTS' 'Node.js' 'https://nodejs.org'
EnsureTool 'git'  'Git.Git'           'Git'     'https://git-scm.com'
$nodeMajor = 0; try { $nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0]) } catch {}
if ($nodeMajor -lt 22) {
    if (Have winget) {
        Warn "  Node $nodeMajor is too old (Vencord needs 22+). Upgrading via winget..."
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        $ErrorActionPreference = $prev
        RefreshPath
        try { $nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0]) } catch {}
    }
    if ($nodeMajor -lt 22) { Fail "Node $nodeMajor is too old; Vencord needs Node 22 or newer. Get the latest from https://nodejs.org , then re-run." }
}
Good "  Node $(node -v), $(git --version)"

Info "[2/6] Getting Vencord source into $InstallDir ..."
if (Test-Path (Join-Path $InstallDir '.git')) {
    Warn '  Existing clone found - updating it...'
    $global:LASTEXITCODE = 0
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    git -C $InstallDir pull --ff-only --quiet
    $pullCode = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($pullCode -ne 0) {
        Warn '  Fast-forward failed (upstream history changed) - hard-resetting to origin/main...'
        Step 'git fetch' { git -C $InstallDir fetch --depth 1 --quiet origin main }
        Step 'git reset' { git -C $InstallDir reset --hard --quiet FETCH_HEAD }
    }
} else {
    if (Test-Path $InstallDir) { Fail "$InstallDir exists but isn't a git clone. Move or delete it, then re-run." }
    Step 'git clone' { git clone --depth 1 --quiet $RepoUrl $InstallDir }
}

Info '[3/6] Adding the OrionQuests plugin...'
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
        Good '  Existing plugin checkout updated from git.'
        $pluginReady = $true
    } elseif ($existingCheckoutUsable -and (Test-Path (Join-Path $dest 'index.tsx') -PathType Leaf)) {
        Warn "  Couldn't update the plugin from GitHub; keeping the existing checkout instead of replacing it with the bundled copy."
        $pluginReady = $true
    }
}

if (-not $pluginReady) {
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    git clone --depth 1 --quiet $PluginRepoUrl $dest 2>&1 | Out-Null
    $cloned = ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $dest 'index.tsx') -PathType Leaf))
    $ErrorActionPreference = $prev

    if ($cloned) {
        Good "  Plugin cloned from $PluginRepoUrl (UPDATE.cmd will keep it current)."
        $pluginReady = $true
    } else {
        Warn "  Couldn't clone the plugin, falling back to the copy in this zip."
        Warn '  UPDATE.cmd will keep Vencord current but not the plugin, so re-download the zip for new Orion releases.'
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

    Info '[4/6] Installing dependencies (this is the slow part - do not close the window)...'
    Step 'pnpm install' { Invoke-Pnpm -Invocation $pnpm -Arguments @('install') }
    Info '[5/6] Building Vencord + plugin transactionally...'
    try { Invoke-VencordBuildTransactional -InstallDir $InstallDir -Invocation $pnpm -RequiredMarker 'OrionQuests' }
    catch { Fail $_.Exception.Message }
    Good '  Build OK, all Vencord runtime files are present, and the plugin is in it.'

    if ($SkipInject) {
        Warn "[6/6] -SkipInject set: not patching Discord. Build is ready at $InstallDir\dist."
    } else {
        Info '[6/6] Patching Discord...'
        # Re-read only the running set after the long build. The target was selected during
        # preflight; a client the user opened meanwhile should be restored after injection too.
        $runningBefore = @(Get-RunningDiscordFlavors)
        $reopen = @(Get-DiscordReopenSet -RunningBefore $runningBefore -TargetBranch $targetBranch)

        Write-Host "  Target: Discord $targetBranch" -ForegroundColor Cyan
        Write-Host "  Windows may show a blue 'Windows protected your PC' box - if so, click 'More info'" -ForegroundColor Yellow
        Write-Host "  then 'Run anyway'. It's Vencord's own installer, freshly downloaded from GitHub." -ForegroundColor Yellow

        try { Stop-DiscordProcesses } catch { Fail $_.Exception.Message }
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        node scripts\runInstaller.mjs -- --install -branch $targetBranch
        $injectCode = $LASTEXITCODE
        $ErrorActionPreference = $prev

        $discordRoot = Get-DiscordRoot -Branch $targetBranch
        $resources = Select-VencordDiscordResourcesPath -DiscordRoot $discordRoot
        $asarPath = if ($resources) { Join-Path $resources 'app.asar' } else { $null }
        $patcherPath = Join-Path $InstallDir 'dist\patcher.js'
        $patched = $false
        if ($asarPath) {
            $patched = Test-AppAsarPointsToPatcher -AppAsar $asarPath -PatcherPath $patcherPath
        }

        if ($injectCode -ne 0 -or -not $patched) {
            Warn "  Inject didn't verify - reverting so Discord isn't left half-patched..."
            $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            node scripts\runInstaller.mjs -- --uninstall -branch $targetBranch 2>&1 | Out-Null
            $uninstallCode = $LASTEXITCODE
            $ErrorActionPreference = $prev

            # Trust the filesystem, not the uninstaller's exit code. If unpatch already
            # restored app.asar, ownership verification is enough. Otherwise use the same
            # checked restore helper as UNINSTALL.cmd and verify again before reopening.
            $rollbackOk = $false
            if ($asarPath -and (Test-Path -LiteralPath $asarPath -PathType Leaf)) {
                $rollbackOk = -not (Test-AppAsarPointsToPatcher -AppAsar $asarPath -PatcherPath $patcherPath)
            }
            if (-not $rollbackOk -and $asarPath) {
                $rollbackOk = Restore-VencordAppAsar -AppAsar $asarPath -PatcherPath $patcherPath
            }

            if ($rollbackOk) {
                $failedReopen = @(Start-DiscordFlavors -Branches $reopen)
                $extra = if ($failedReopen.Count -gt 0) { " Discord was restored, but these clients did not reopen automatically: $($failedReopen -join ', '). Start them manually." } else { '' }
                Fail "patching Discord $targetBranch failed. Discord was restored to its original state.$extra"
            }

            Warn "  Automatic rollback could not be verified (uninstaller exit code $uninstallCode)."
            Fail "patching Discord $targetBranch failed and rollback could not be verified. Discord was left closed. Run the official Vencord installer and choose Repair before reopening Discord."
        }

        Good "  Discord $targetBranch patched (verified)."
        $failedReopen = @(Start-DiscordFlavors -Branches $reopen)
        if ($failedReopen.Count -gt 0) {
            Warn "  Orion is installed, but these Discord clients did not reopen automatically: $($failedReopen -join ', ')."
            Warn '  Start them manually. If one still will not open, run the official Vencord installer and choose Repair.'
        }
    }
} finally {
    Pop-Location
}

Write-Host ''
Good 'Done.'
if (-not $SkipInject) {
    Write-Host ''
    Write-Host ' NEXT: in Discord, open Settings -> Plugins, search OrionQuests, enable it.' -ForegroundColor Cyan
    Write-Host "       For achievement quests, also enable the 'achievementBypass' toggle." -ForegroundColor Cyan
    Write-Host '       Vencord auto-updates normally now, and the plugin rebuilds in on updates.' -ForegroundColor Cyan
    Write-Host '       If an update ever says Build failed, run UPDATE.cmd from this installer folder.' -ForegroundColor Cyan
    Write-Host ''
    Write-Host ' To remove it later: run UNINSTALL.cmd from this installer folder.' -ForegroundColor DarkGray
}
Write-Host ''
Pause2 'Press Enter to close'