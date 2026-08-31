<#
  Build the release zips.

  This exists because the packaging steps are easy to get wrong in ways nothing catches
  until a user reports it:

    - the version lives in six places and they drift (index.js CONFIG.VERSION, which is the
      one read here, plus the README badge, index.tsx PLUGIN_VERSION, docs/ARCHITECTURE.md,
      docs/VENCORD-PLUGIN.md and the devbuild installer README)
    - the Tier 1 bundle MUST be built --standalone --disable-updater. A plain build drops a
      git-updater dist into the non-git %APPDATA%\Vencord and Vencord errors on every launch
      (issue #39); --standalone alone is worse, its HTTP updater silently reverts the dist to
      vanilla and deletes the plugin. Only both flags together are safe for a copy-in-place
      install, and the only way to tell is the banner at the top of dist/patcher.js.
    - the bundle must come from a clean Vencord source tree whose src/userplugins contains
      no userplugin source except orionQuests. This is deliberately stricter than trying to
      predict Vencord's target filtering: renderer plugin discovery and native discovery are
      separate build paths, so absence of foreign source is the simple provenance invariant.
    - the devbuild installer ships a copy of the plugin sources, which moved to the repo root
      in v4.9.7 so UserpluginInstaller can clone the repo directly (#42)

  Run from anywhere. For a bundle, -BundleDist must point at the dist directory inside the
  clean Vencord source tree that produced it. -BundleSource may name that source root
  explicitly; otherwise it is inferred as the parent of -BundleDist. Skip the bundle with
  -SkipBundle.
#>
[CmdletBinding()]
param(
    [string] $BundleDist,
    [string] $BundleSource,
    [switch] $SkipBundle
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Tools = Join-Path $Repo 'tools'

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Good($m) { Write-Host "  $m" -ForegroundColor Green }
function Die($m) { Write-Host ""; Write-Host "  ERROR: $m" -ForegroundColor Red; exit 1 }

# ---- 1. version, and every place that has to agree with it -----------------------
$indexJs = Join-Path $Repo 'index.js'
$m = [regex]::Match((Get-Content $indexJs -Raw), 'VERSION:\s*"(v[0-9]+\.[0-9]+\.[0-9]+)"')
if (-not $m.Success) { Die "couldn't read CONFIG.VERSION out of index.js" }
$Version = $m.Groups[1].Value
Info "Version from index.js: $Version"

$checks = @(
    # The README carries the version in its badge only. It used to repeat it in the headline
    # too, until that line went with the rewrite that pulled the marketing voice out.
    @{ File = 'README.md';                                Pattern = "badge/$Version-5865F2" }
    @{ File = 'docs/VENCORD-PLUGIN.md';                   Pattern = "in sync with userscript $Version" }
    @{ File = 'docs/ARCHITECTURE.md';                     Pattern = "Last reviewed against .index\.js. \*\*$Version\*\*" }
    @{ File = 'tools/orion-devbuild-installer/README.txt'; Pattern = "Version: $Version" }
    # The plugin carries its own version since v4.10.7. Before that a plugin user could not say
    # which build a bug report came from, and neither could anyone triaging it (issue #66).
    @{ File = 'index.tsx';                                Pattern = "PLUGIN_VERSION = ""$Version""" }
)
$drift = @()
foreach ($c in $checks) {
    $p = Join-Path $Repo $c.File
    if (-not (Test-Path $p)) { $drift += "$($c.File) is missing"; continue }
    if (-not (Select-String -Path $p -Pattern $c.Pattern -Quiet)) { $drift += "$($c.File) does not mention $Version" }
}
if ($drift) { $drift | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }; Die "version drift, fix these before packaging" }
Good "all version references agree"

# ---- 2. stage the plugin sources into the devbuild installer ---------------------
# They live at the repo ROOT (not vencord-plugin/) since v4.9.7 so UserpluginInstaller
# can clone the repo straight into src/userplugins. The installer scripts copy this
# staged folder into <clone>/src/userplugins/orionQuests.
Info "Staging plugin sources for the devbuild installer..."
$stage = Join-Path $Tools 'orion-devbuild-installer\plugin'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$entry = Join-Path $Repo 'index.tsx'
if (-not (Test-Path $entry)) { Die "index.tsx not found at the repo root. Did the plugin sources move again?" }
Get-ChildItem $Repo -File | Where-Object { $_.Extension -in '.ts', '.tsx' } | ForEach-Object {
    Copy-Item $_.FullName $stage
}
Copy-Item (Join-Path $Repo 'docs\VENCORD-PLUGIN.md') (Join-Path $stage 'README.md')
$staged = (Get-ChildItem $stage -File).Count
if ($staged -lt 9) { Die "only $staged plugin files staged, expected the full set" }
Good "$staged files staged"

# ---- 3. the Tier 1 bundle must be a clean standalone, updater-disabled build -----
if (-not $SkipBundle) {
    if ([string]::IsNullOrWhiteSpace($BundleDist)) {
        Die "bundle packaging requires -BundleDist <clean Vencord clone>\dist so the source userplugin set can be verified"
    }

    try { $bundleDistFull = (Resolve-Path -LiteralPath $BundleDist -ErrorAction Stop).Path }
    catch { Die "BundleDist '$BundleDist' does not exist" }

    if ($BundleSource) {
        try { $sourceRoot = (Resolve-Path -LiteralPath $BundleSource -ErrorAction Stop).Path }
        catch { Die "BundleSource '$BundleSource' does not exist" }
    } else {
        $sourceRoot = Split-Path -Parent $bundleDistFull
    }

    $expectedDist = [IO.Path]::GetFullPath((Join-Path $sourceRoot 'dist')).TrimEnd('\', '/')
    $actualDist = [IO.Path]::GetFullPath($bundleDistFull).TrimEnd('\', '/')
    if (-not $actualDist.Equals($expectedDist, [StringComparison]::OrdinalIgnoreCase)) {
        Die "BundleDist must be the dist directory inside BundleSource. Expected '$expectedDist', got '$actualDist'."
    }

    $userplugins = Join-Path $sourceRoot 'src\userplugins'
    $orionEntry = Join-Path $userplugins 'orionQuests\index.tsx'
    if (-not (Test-Path -LiteralPath $orionEntry -PathType Leaf)) {
        Die "clean bundle source is missing src\userplugins\orionQuests\index.tsx"
    }

    # This is a source-provenance rule, not a prediction that every extra entry would
    # necessarily reach every output. Renderer discovery skips some names, but Vencord's
    # native discovery scans every userplugin entry for native.ts. Therefore do not exempt
    # '_' or '.' names here: a hidden/disabled-looking directory can still affect patcher.js.
    # index.ts is the only non-plugin infrastructure file Vencord's renderer explicitly skips;
    # as a file it cannot itself contain <entry>/native.ts, so it is safe to permit.
    $extraUserPluginSources = @()
    if (Test-Path -LiteralPath $userplugins -PathType Container) {
        $extraUserPluginSources = @(Get-ChildItem -LiteralPath $userplugins -Force | Where-Object {
            if ($_.Name -eq 'orionQuests') { $false }
            elseif (-not $_.PSIsContainer -and $_.Name -eq 'index.ts') { $false }
            else { $true }
        })
    }
    if ($extraUserPluginSources.Count -gt 0) {
        $names = $extraUserPluginSources.Name -join ', '
        Die "bundle source is not clean; additional Vencord userplugin entries are present: $names. Use a clean clone containing only src\userplugins\orionQuests (plus an optional root index.ts infrastructure file) before building."
    }
    Good "bundle source provenance is clean: only orionQuests userplugin source is present"

    $bundleDir = Join-Path $Tools 'orion-vencord-bundle'
    $dist = Join-Path $bundleDir 'dist'
    $requiredDesktopFiles = @('patcher.js', 'preload.js', 'renderer.js', 'renderer.css')

    Info "Refreshing the bundle dist from $bundleDistFull ..."
    foreach ($name in $requiredDesktopFiles) {
        $candidate = Join-Path $bundleDistFull $name
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -or (Get-Item -LiteralPath $candidate).Length -le 0) {
            Die "$bundleDistFull is incomplete: required Discord Vencord runtime file '$name' is missing or empty"
        }
    }
    if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    Get-ChildItem $bundleDistFull -File | Where-Object { $_.Name -notlike '*.map' } | ForEach-Object { Copy-Item $_.FullName $dist }

    foreach ($name in $requiredDesktopFiles) {
        $candidate = Join-Path $dist $name
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -or (Get-Item -LiteralPath $candidate).Length -le 0) {
            Die "bundle dist is incomplete: '$name' is missing or empty. Build Vencord with 'pnpm build --standalone --disable-updater' and pass the complete dist with -BundleDist."
        }
    }

    # the banner is a few `//` lines and the order isn't fixed (Standalone, Platform,
    # Updater Disabled), so read past all of them rather than assuming a line count
    $banner = (Get-Content (Join-Path $dist 'patcher.js') -TotalCount 10) -join "`n"
    if ($banner -notmatch 'Standalone:\s*true')       { Die "bundle dist is NOT a --standalone build. It would break Vencord's updater (#39)." }
    if ($banner -notmatch 'Updater Disabled:\s*true') { Die "bundle dist is NOT --disable-updater. Its HTTP updater would revert the dist to vanilla and delete the plugin (#39)." }
    if (-not (Select-String -Path (Join-Path $dist 'renderer.js') -Pattern 'OrionQuests' -SimpleMatch -Quiet)) { Die "the plugin is not in the bundle dist" }
    Good "bundle dist is complete, standalone + updater-disabled, contains OrionQuests, and came from the required clean source tree"

    # The bundle is a compiled Vencord, which is GPL-3.0-or-later, so conveying it means
    # shipping the licence text and saying where the corresponding source is. That was missing
    # for every release before v4.10.3.
    $vencordLicence = Join-Path $bundleDir 'LICENSE-VENCORD.txt'
    if (-not (Test-Path $vencordLicence)) { Die "LICENSE-VENCORD.txt is missing from the bundle. The bundle conveys Vencord (GPL-3.0-or-later) and must carry its licence text." }
    if (-not (Select-String -Path $vencordLicence -Pattern 'GNU GENERAL PUBLIC LICENSE' -SimpleMatch -Quiet)) { Die "LICENSE-VENCORD.txt does not contain the GPL text." }
    $bundleReadme = Join-Path $bundleDir 'README.txt'
    foreach ($needle in @('GPL-3.0-or-later', 'github.com/Vendicated/Vencord', 'LICENSE-VENCORD.txt')) {
        if (-not (Select-String -Path $bundleReadme -Pattern $needle -SimpleMatch -Quiet)) { Die "the bundle README is missing '$needle'; it must state the licence and where the corresponding source is." }
    }
    Good "bundle carries Vencord's licence text and a source pointer"
}

# ---- 4. zip ---------------------------------------------------------------------
$targets = @('orion-vencord-bundle', 'orion-relay', 'orion-devbuild-installer')
if ($SkipBundle) { $targets = $targets | Where-Object { $_ -ne 'orion-vencord-bundle' } }

Info "Building zips..."
$results = foreach ($n in $targets) {
    $zip = Join-Path $Tools "$n-$Version.zip"
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $Tools "$n\*") -DestinationPath $zip -CompressionLevel Optimal
    [pscustomobject]@{ Name = Split-Path $zip -Leaf; Bytes = (Get-Item $zip).Length; SHA256 = (Get-FileHash $zip -Algorithm SHA256).Hash }
}
$results += [pscustomobject]@{ Name = 'index.js'; Bytes = (Get-Item $indexJs).Length; SHA256 = (Get-FileHash $indexJs -Algorithm SHA256).Hash }

Write-Host ""
$results | Format-Table -AutoSize
Write-Host "Release assets for $Version are ready in tools\." -ForegroundColor Green