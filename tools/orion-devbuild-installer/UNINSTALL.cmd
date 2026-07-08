@echo off
title Orion Quests - Uninstall (auto-update edition)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d = Join-Path $env:LOCALAPPDATA 'OrionVencord';" ^
  "if (-not (Test-Path $d)) { Write-Host 'OrionVencord install not found - nothing to do.' -ForegroundColor Yellow; Read-Host 'Press Enter'; exit }" ^
  "Write-Host 'Closing Discord...';" ^
  "Get-Process Discord,DiscordSystemHelper -ErrorAction SilentlyContinue | Stop-Process -Force;" ^
  "Start-Sleep -Seconds 2;" ^
  "Push-Location $d;" ^
  "try { corepack pnpm run uninject; Write-Host 'Discord unpatched.' -ForegroundColor Green } catch { Write-Host 'Uninject failed - run the official Vencord installer and pick Uninstall/Repair.' -ForegroundColor Red }" ^
  "Pop-Location;" ^
  "Start-Process \"$env:LOCALAPPDATA\Discord\Update.exe\" -ArgumentList '--processStart','Discord.exe' -ErrorAction SilentlyContinue;" ^
  "Write-Host ''; Write-Host ('You can now delete the folder ' + $d + ' if you want.') -ForegroundColor DarkGray;" ^
  "Read-Host 'Press Enter'"
