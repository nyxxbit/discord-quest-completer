<#
  Orion Quests - Vencord "auto-update edition" installer.

  Builds Vencord from source with the OrionQuests plugin baked in, as a real git
  clone. Because the plugin lives in src/userplugins (gitignored upstream) and the
  install is a git checkout, Vencord's own updater keeps working: it git-pulls and
  rebuilds, and the plugin is recompiled back in every time. This is the heavier,
  correct alternative to the prebuilt bundle (which freezes Vencord).

  Flow: ensure Node + Git (winget if missing) -> clone/pull Vencord into
  %LOCALAPPDATA%\OrionVencord -> drop the plugin -> pnpm install -> build -> verify
  the plugin is in the build -> patch Discord (inject). Build happens BEFORE inject,
  and inject only runs if the build actually contains the plugin, so a failure never
  leaves Discord half-patched.

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

# Run a native command (git/corepack/winget). Native tools write progress to stderr,
# which PowerShell would otherwise treat as a fatal error under -Stop. Drop to Continue
# for the call and judge success by the real exit code instead.
function Step([string]$what, [scriptblock]$run) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $run } finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE). See the output above." }
}

Write-Host "==============================================================" -ForegroundColor Magenta
Write-Host "   Orion Quests - Vencord auto-update edition installer" -ForegroundColor Magenta
Write-Host "==============================================================" -ForegroundColor Magenta
Write-Host ""
Write-Host " This builds Vencord from source with the plugin included, so"
Write-Host " Vencord keeps auto-updating (unlike the simple bundle, which"
Write-Host " freezes it). It's a bigger install (downloads Node deps, a few"
Write-Host " hundred MB, and takes a couple minutes)."
Write-Host ""
Write-Host " It installs into:" -NoNewline; Write-Host " $InstallDir" -ForegroundColor Yellow
Write-Host " Do NOT move or delete that folder afterwards - Discord loads" -ForegroundColor Yellow
Write-Host " Vencord from it." -ForegroundColor Yellow
Write-Host ""
if (-not (Test-Path $PluginSrc)) { Fail "plugin source folder not found next to this script ($PluginSrc). Extract the whole zip and keep the files together." }

# ---- 1. prerequisites: Node 18+ and Git ----------------------------------------
Info "[1/6] Checking Node.js and Git..."
if (-not (Have node)) {
    if (Have winget) {
        Warn "  Node.js not found - installing via winget (accept any prompts)..."
        Step 'winget (Node.js)' { winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements }
        RefreshPath
    }
    if (-not (Have node)) { Fail "Node.js is still not available. Install Node LTS from https://nodejs.org , then close this window and run the installer again." }
}
if (-not (Have git)) {
    if (Have winget) {
        Warn "  Git not found - installing via winget (accept any prompts)..."
        Step 'winget (Git)' { winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements }
        RefreshPath
    }
    if (-not (Have git)) { Fail "Git is still not available. Install Git from https://git-scm.com , then close this window and run the installer again." }
}
$nodeMajor = 0; try { $nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0]) } catch {}
if ($nodeMajor -lt 18) { Fail "Node $nodeMajor is too old; Vencord needs Node 18 or newer. Update Node and re-run." }
if (-not (Have corepack)) { Fail "corepack is missing (it ships with Node 16.9+). Reinstall Node LTS and re-run." }
Good "  Node $(node -v), $(git --version)"

# ---- 2. clone or update Vencord ------------------------------------------------
Info "[2/6] Getting Vencord source into $InstallDir ..."
if (Test-Path (Join-Path $InstallDir '.git')) {
    Warn "  Existing clone found - updating it (git pull)..."
    Step 'git pull' { git -C $InstallDir pull --ff-only --quiet }
} else {
    if (Test-Path $InstallDir) { Fail "$InstallDir exists but isn't a git clone. Move or delete it, then re-run." }
    Step 'git clone' { git clone --depth 1 --quiet $RepoUrl $InstallDir }
}

# ---- 3. drop the plugin into src/userplugins -----------------------------------
Info "[3/6] Adding the OrionQuests plugin..."
$dest = Join-Path $InstallDir 'src\userplugins\orionQuests'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $PluginSrc '*') $dest -Recurse -Force

# ---- 4. install deps + 5. build ------------------------------------------------
Push-Location $InstallDir
try {
    Info "[4/6] Installing dependencies (this is the slow part)..."
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
        Write-Host "  Windows may ask to allow this (it edits Discord's app files)." -ForegroundColor Yellow
        Write-Host "  If SmartScreen/antivirus prompts, choose Allow/Run." -ForegroundColor Yellow
        Get-Process Discord, DiscordSystemHelper, DiscordCanary, DiscordPTB -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 2
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        corepack pnpm run inject
        $injectCode = $LASTEXITCODE
        $ErrorActionPreference = $prev
        if ($injectCode -ne 0) {
            Warn "  Inject failed (exit $injectCode) - reverting so Discord isn't left half-patched..."
            $ErrorActionPreference = 'Continue'; corepack pnpm run uninject 2>&1 | Out-Null; $ErrorActionPreference = $prev
            Fail "patching Discord failed and was rolled back. Discord is untouched."
        }
        Good "  Discord patched."
        Start-Process "$env:LOCALAPPDATA\Discord\Update.exe" -ArgumentList '--processStart', 'Discord.exe' -ErrorAction SilentlyContinue
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
    Write-Host "       Vencord will now auto-update normally, and the plugin is rebuilt in" -ForegroundColor Cyan
    Write-Host "       on every update." -ForegroundColor Cyan
    Write-Host ""
    Write-Host " To remove it later: run UNINSTALL.cmd from this folder." -ForegroundColor DarkGray
}
Write-Host ""
Pause2 'Press Enter to close'
