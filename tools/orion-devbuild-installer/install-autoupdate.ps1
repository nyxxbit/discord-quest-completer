<#
  Orion Quests - Vencord "auto-update edition" installer.

  Builds Vencord from source with the OrionQuests plugin baked in, as a real git
  clone. Because the plugin lives in src/userplugins (gitignored upstream) and the
  install is a git checkout, Vencord's own updater keeps working: it git-pulls and
  rebuilds, and the plugin is recompiled back in every time. This is the heavier,
  correct alternative to the prebuilt bundle (which freezes Vencord).

  Flow: ensure Node 22+ and Git (winget if missing) -> clone/pull Vencord into
  %LOCALAPPDATA%\OrionVencord -> drop the plugin -> pnpm install -> build -> verify
  the plugin is in the build -> patch Discord (inject). Build happens BEFORE inject.
  The inject step does NOT trust the installer's exit code (Vencord's runInstaller
  swallows CLI failures and still exits 0); it verifies Discord's app.asar actually
  points at this build, and if not it rolls back and directly restores the original
  app.asar so Discord always boots.

  Pass -SkipInject to do everything except patch Discord (used for testing).
#>
param([switch]$SkipInject)

$ErrorActionPreference = 'Stop'
# let corepack fetch pnpm without an interactive y/n prompt
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$InstallDir = Join-Path $env:LOCALAPPDATA 'OrionVencord'
$PluginSrc  = Join-Path $PSScriptRoot 'plugin'
$RepoUrl    = 'https://github.com/Vendicated/Vencord'

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Good($m) { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Pause2($m) { try { Read-Host $m } catch {} }
function Fail($m) { Write-Host ""; Write-Host "  ERROR: $m" -ForegroundColor Red; Write-Host ""; Pause2 'Press Enter to exit'; exit 1 }
function Have($c) { $null -ne (Get-Command $c -ErrorAction SilentlyContinue) }
function RefreshPath { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

# Run a native command (git/corepack). They write progress to stderr, which PowerShell
# would otherwise treat as fatal under -Stop. Run under Continue and judge by exit code.
function Step([string]$what, [scriptblock]$run) {
    $global:LASTEXITCODE = 0
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $run } finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE). See the output above." }
}

# winget returns nonzero for benign reasons (reboot-required, already-installed), so do NOT
# gate on its exit code. Install, refresh PATH, and let the presence recheck be the oracle.
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

# Which Discord flavor is installed (for kill + relaunch). Stable preferred.
function DiscordFlavor {
    foreach ($f in @('Discord', 'DiscordCanary', 'DiscordPTB')) {
        if (Test-Path (Join-Path $env:LOCALAPPDATA "$f\Update.exe")) { return $f }
    }
    return $null
}
function KillDiscord {
    Get-Process Discord, DiscordCanary, DiscordPTB, DiscordSystemHelper, Update -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(15)
    while (((Get-Process Discord, DiscordCanary, DiscordPTB -ErrorAction SilentlyContinue) | Measure-Object).Count -gt 0 -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
}

Write-Host "==============================================================" -ForegroundColor Magenta
Write-Host "   Orion Quests - Vencord auto-update edition installer" -ForegroundColor Magenta
Write-Host "==============================================================" -ForegroundColor Magenta
Write-Host ""
Write-Host " This builds Vencord from source with the plugin included, so Vencord keeps"
Write-Host " auto-updating (unlike the simple bundle, which freezes it)."
Write-Host ""
Write-Host " Expect 5-15 minutes and about 300 MB of downloads. It will sit on" -ForegroundColor Yellow
Write-Host " 'Installing dependencies' with scrolling text for a while - that is normal," -ForegroundColor Yellow
Write-Host " do NOT close the window." -ForegroundColor Yellow
Write-Host ""
Write-Host " It installs into:" -NoNewline; Write-Host " $InstallDir" -ForegroundColor Yellow
Write-Host " Do NOT move or delete that folder afterwards - Discord loads Vencord from it." -ForegroundColor Yellow
Write-Host ""
if (-not (Test-Path $PluginSrc)) { Fail "plugin source folder not found next to this script ($PluginSrc). Extract the whole zip and keep the files together." }

# ---- 1. prerequisites: Node 22+ and Git ----------------------------------------
Info "[1/6] Checking Node.js and Git..."
EnsureTool 'node' 'OpenJS.NodeJS.LTS' 'Node.js' 'https://nodejs.org'
EnsureTool 'git'  'Git.Git'           'Git'     'https://git-scm.com'
if (-not (Have corepack)) { Fail "corepack is missing (it ships with Node 16.9+). Reinstall Node LTS and re-run." }
# Vencord now requires Node 22+. A pre-existing older Node would pass EnsureTool but fail the build.
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

# ---- 2. clone or update Vencord ------------------------------------------------
Info "[2/6] Getting Vencord source into $InstallDir ..."
if (Test-Path (Join-Path $InstallDir '.git')) {
    Warn "  Existing clone found - updating it..."
    $global:LASTEXITCODE = 0
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    git -C $InstallDir pull --ff-only --quiet
    $pullCode = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($pullCode -ne 0) {
        Warn "  Fast-forward failed (upstream history changed) - hard-resetting to origin/main..."
        Step 'git fetch' { git -C $InstallDir fetch --depth 1 --quiet origin main }
        Step 'git reset' { git -C $InstallDir reset --hard --quiet FETCH_HEAD }
    }
} else {
    if (Test-Path $InstallDir) { Fail "$InstallDir exists but isn't a git clone. Move or delete it, then re-run." }
    Step 'git clone' { git clone --depth 1 --quiet $RepoUrl $InstallDir }
}

# ---- 3. drop the plugin into src/userplugins (clean each run) -------------------
Info "[3/6] Adding the OrionQuests plugin..."
$dest = Join-Path $InstallDir 'src\userplugins\orionQuests'
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $PluginSrc '*') $dest -Recurse -Force

# ---- 4. install deps + 5. build ------------------------------------------------
Push-Location $InstallDir
try {
    Info "[4/6] Installing dependencies (this is the slow part - do not close the window)..."
    # no version pin and no --frozen-lockfile: corepack reads the pnpm version from the
    # clone's packageManager field (so it matches the lockfile), and a non-frozen install
    # tolerates minor lockfile drift on whatever upstream commit the friend happened to clone.
    Step 'pnpm install' { corepack pnpm install }
    Info "[5/6] Building Vencord + plugin..."
    Step 'pnpm build' { corepack pnpm run build }
    if (-not (Test-Path 'dist\patcher.js')) { Fail "build produced no dist. Aborting before touching Discord." }
    if (-not (Select-String -Path 'dist\renderer.js' -Pattern 'OrionQuests' -SimpleMatch -Quiet)) {
        Fail "the plugin isn't in the build output. Aborting before touching Discord so nothing breaks."
    }
    Good "  Build OK and the plugin is in it."

    # ---- 6. inject (patch Discord) ---------------------------------------------
    if ($SkipInject) {
        Warn "[6/6] -SkipInject set: not patching Discord. Build is ready at $InstallDir\dist."
    } else {
        Info "[6/6] Patching Discord..."
        Write-Host "  Windows may show a blue 'Windows protected your PC' box - if so, click 'More info'" -ForegroundColor Yellow
        Write-Host "  then 'Run anyway'. It's Vencord's own installer, freshly downloaded from GitHub." -ForegroundColor Yellow
        # Patch the detected Discord explicitly (-branch) so Vencord's CLI never drops into its
        # interactive "Select Discord install to patch" arrow-key menu. Left interactive it stalls a
        # headless/logged run and makes a non-technical friend guess at a TUI with no instructions.
        $flavor = DiscordFlavor
        if (-not $flavor) { Fail "No Discord install found to patch. Install Discord first, then re-run." }
        $branch = switch ($flavor) { 'DiscordCanary' { 'canary' } 'DiscordPTB' { 'ptb' } default { 'stable' } }
        KillDiscord
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        node scripts\runInstaller.mjs -- --install -branch $branch
        $injectCode = $LASTEXITCODE
        $ErrorActionPreference = $prev

        # runInstaller.mjs swallows CLI failures and still exits 0, so do NOT trust $injectCode.
        # Verify the patch actually landed: the newest Discord app.asar stub must now point at
        # THIS clone's patcher.js.
        $asar = Get-ChildItem "$env:LOCALAPPDATA\Discord\app-*\resources\app.asar" -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
        $patched = $false
        if ($asar) {
            try { $txt = [IO.File]::ReadAllText($asar.FullName) } catch { $txt = '' }
            if ($txt -like '*patcher.js*' -and $txt -like '*OrionVencord*') { $patched = $true }
        }
        if ($injectCode -ne 0 -or -not $patched) {
            Warn "  Inject didn't verify - reverting so Discord isn't left half-patched..."
            $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            node scripts\runInstaller.mjs -- --uninstall -branch $branch 2>&1 | Out-Null
            $ErrorActionPreference = $prev
            # If uninject no-ops too, restore the real asar directly so Discord at least boots vanilla.
            if ($asar -and (Test-Path (Join-Path $asar.Directory.FullName '_app.asar'))) {
                Remove-Item $asar.FullName -Force -ErrorAction SilentlyContinue
                Rename-Item (Join-Path $asar.Directory.FullName '_app.asar') 'app.asar' -ErrorAction SilentlyContinue
            }
            Fail "patching Discord failed. Discord was restored to its original state - just reopen it."
        }
        Good "  Discord patched (verified)."
        if ($flavor) {
            Start-Process (Join-Path $env:LOCALAPPDATA "$flavor\Update.exe") -ArgumentList '--processStart', "$flavor.exe" -ErrorAction SilentlyContinue
        } else {
            Warn "  Couldn't find Discord to reopen automatically - open it yourself."
        }
    }
} finally {
    Pop-Location
}

Write-Host ""
Good "Done."
if (-not $SkipInject) {
    Write-Host ""
    Write-Host " NEXT: in Discord, open Settings -> Plugins, search OrionQuests, enable it." -ForegroundColor Cyan
    Write-Host "       For achievement quests, also enable the 'achievementBypass' toggle." -ForegroundColor Cyan
    Write-Host "       Vencord auto-updates normally now, and the plugin rebuilds in on updates." -ForegroundColor Cyan
    Write-Host "       If it ever says 'Build failed' after an update, run UPDATE.cmd from this folder." -ForegroundColor Cyan
    Write-Host ""
    Write-Host " To remove it later: run UNINSTALL.cmd from this folder." -ForegroundColor DarkGray
}
Write-Host ""
Pause2 'Press Enter to close'
