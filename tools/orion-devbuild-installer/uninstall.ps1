<#
  Uninstall the Orion Quests "auto-update edition".

  Robust because the friend may have already deleted the OrionVencord clone (which would
  brick Discord, since its app.asar stub require()s the clone's patcher.js). So we do NOT
  depend on the clone: we restore Discord's original app.asar directly, for every flavor,
  but only where the stub actually points at OUR OrionVencord install.
#>
$ErrorActionPreference = 'Continue'
$InstallDir = Join-Path $env:LOCALAPPDATA 'OrionVencord'

Write-Host "Orion Quests - uninstalling the auto-update edition..." -ForegroundColor Cyan

# 1. close every Discord flavor + Squirrel updater, wait for them to actually exit
Get-Process Discord, DiscordCanary, DiscordPTB, DiscordSystemHelper, Update -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(15)
while (((Get-Process Discord, DiscordCanary, DiscordPTB -ErrorAction SilentlyContinue) | Measure-Object).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }

# 2. best-effort proper uninject via the clone (may no-op if the clone is gone or the CLI fails)
if (Test-Path (Join-Path $InstallDir 'package.json')) {
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
    Push-Location $InstallDir
    try { corepack pnpm run uninject 2>&1 | Out-Null } catch {}
    Pop-Location
}

# 3. clone-independent restore: for every Discord flavor, if app.asar is a small stub that
#    points at OUR OrionVencord install and a real _app.asar sits beside it, restore it.
$restored = 0; $stuck = 0
foreach ($f in @('Discord', 'DiscordCanary', 'DiscordPTB')) {
    Get-ChildItem "$env:LOCALAPPDATA\$f\app-*\resources\app.asar" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Length -ge 10000) { return }  # multi-MB real asar = not patched, leave it
        try { $txt = [IO.File]::ReadAllText($_.FullName) } catch { $txt = '' }
        if ($txt -notlike '*OrionVencord*') { return }  # someone else's Vencord, not ours - leave it
        $real = Join-Path $_.Directory.FullName '_app.asar'
        if (Test-Path $real) {
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            Rename-Item $real 'app.asar' -ErrorAction SilentlyContinue
            $restored++
        } else {
            $stuck++
        }
    }
}

Write-Host ""
if ($stuck -gt 0) {
    Write-Host "Couldn't fully restore $stuck Discord install(s) (the backup app.asar was missing)." -ForegroundColor Red
    Write-Host "Run the official Vencord installer (vencord.dev/download) and pick Uninstall/Repair." -ForegroundColor Red
} elseif ($restored -gt 0) {
    Write-Host "Discord restored to its original state." -ForegroundColor Green
} else {
    Write-Host "Nothing of ours was patched into Discord (already clean)." -ForegroundColor Green
}

# 4. reopen whichever flavor is installed
foreach ($f in @('Discord', 'DiscordCanary', 'DiscordPTB')) {
    $u = Join-Path $env:LOCALAPPDATA "$f\Update.exe"
    if (Test-Path $u) { Start-Process $u -ArgumentList '--processStart', "$f.exe" -ErrorAction SilentlyContinue; break }
}

Write-Host ""
Write-Host "You can now delete this folder if you want: $InstallDir" -ForegroundColor DarkGray
Write-Host "Node.js and Git stay installed. To remove them too (optional):" -ForegroundColor DarkGray
Write-Host "  winget uninstall OpenJS.NodeJS.LTS   and   winget uninstall Git.Git" -ForegroundColor DarkGray
Write-Host ""
try { Read-Host 'Press Enter to close' } catch {}
