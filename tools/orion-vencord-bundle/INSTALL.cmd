@echo off
setlocal
title Orion Quests - Installer
color 0B
echo.
echo  ==============================================================
echo                 Orion Quests - Automatic installer
echo  ==============================================================
echo.

cd /d "%~dp0"

:: Validate the extracted release before stopping Discord or touching Vencord.
call :check_dist_complete "%~dp0dist"
if errorlevel 1 goto :package_incomplete
if not exist "%~dp0verify-vencord-target.ps1" goto :package_incomplete
:: %~dp0 always ends in a backslash. Use the normalized current directory when
:: passing the bundle root through native Windows argv parsing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-vencord-target.ps1" -Action IsOrionDist -VencordRoot "%CD%" >nul 2>&1
if errorlevel 1 goto :package_not_orion

:: 1) Vencord must be installed first, and its desktop runtime must be complete.
if not exist "%APPDATA%\Vencord\dist\" (
    color 0C
    echo  ERROR: You need to install Vencord FIRST.
    echo.
    echo  1. Open https://vencord.dev/download in your browser
    echo  2. Download and run the Windows installer
    echo  3. Then come back here and double-click INSTALL.cmd again
    echo.
    pause
    exit /b 1
)
call :check_dist_complete "%APPDATA%\Vencord\dist"
if errorlevel 1 goto :vencord_incomplete

:: Verify that the client(s) this installer may operate on actually point at the
:: shared %APPDATA%\Vencord build. Merely having a Discord folder is not enough.
set "HAS_STABLE=0"
set "HAS_CANARY=0"
set "HAS_PTB=0"
if exist "%LOCALAPPDATA%\Discord\Update.exe" set "HAS_STABLE=1"
if exist "%LOCALAPPDATA%\DiscordCanary\Update.exe" set "HAS_CANARY=1"
if exist "%LOCALAPPDATA%\DiscordPTB\Update.exe" set "HAS_PTB=1"
set /a INSTALLED_COUNT=HAS_STABLE+HAS_CANARY+HAS_PTB

set "PATCHED_STABLE=0"
set "PATCHED_CANARY=0"
set "PATCHED_PTB=0"
if "%HAS_STABLE%"=="1" call :detect_patched Discord PATCHED_STABLE
if "%HAS_CANARY%"=="1" call :detect_patched DiscordCanary PATCHED_CANARY
if "%HAS_PTB%"=="1" call :detect_patched DiscordPTB PATCHED_PTB
set /a PATCHED_COUNT=PATCHED_STABLE+PATCHED_CANARY+PATCHED_PTB
if %PATCHED_COUNT% EQU 0 goto :no_patched_client

:: Validation only. The flavor helpers below own stop/reopen tracking; these
:: variables just prevent replacing the shared dist when a running client points
:: at some other Vencord checkout (or is not patched at all).
set "WAS_STABLE=0"
set "WAS_CANARY=0"
set "WAS_PTB=0"
tasklist /FI "IMAGENAME eq Discord.exe" /NH 2>nul | find /I "Discord.exe" >nul
if not errorlevel 1 set "WAS_STABLE=1"
tasklist /FI "IMAGENAME eq DiscordCanary.exe" /NH 2>nul | find /I "DiscordCanary.exe" >nul
if not errorlevel 1 set "WAS_CANARY=1"
tasklist /FI "IMAGENAME eq DiscordPTB.exe" /NH 2>nul | find /I "DiscordPTB.exe" >nul
if not errorlevel 1 set "WAS_PTB=1"
set /a RUNNING_COUNT=WAS_STABLE+WAS_CANARY+WAS_PTB
if "%WAS_STABLE%"=="1" if not "%PATCHED_STABLE%"=="1" goto :stable_not_patched
if "%WAS_CANARY%"=="1" if not "%PATCHED_CANARY%"=="1" goto :canary_not_patched
if "%WAS_PTB%"=="1" if not "%PATCHED_PTB%"=="1" goto :ptb_not_patched

:: When Discord was initially closed, the flavor helper starts the only installed
:: client if the choice is unambiguous. Validate that fallback target first.
if %RUNNING_COUNT% EQU 0 if %INSTALLED_COUNT% EQU 1 (
    if "%HAS_STABLE%"=="1" if not "%PATCHED_STABLE%"=="1" goto :stable_not_patched
    if "%HAS_CANARY%"=="1" if not "%PATCHED_CANARY%"=="1" goto :canary_not_patched
    if "%HAS_PTB%"=="1" if not "%PATCHED_PTB%"=="1" goto :ptb_not_patched
)

:: A saved recovery copy is reusable only while the current dist is still the
:: Orion standalone bundle. After official Vencord Repair/update, refresh the
:: backup from that new normal Vencord before replacing the live dist again.
set "CURRENT_IS_ORION=0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-vencord-target.ps1" -Action IsOrionDist -VencordRoot "%APPDATA%\Vencord" >nul 2>&1
if not errorlevel 1 set "CURRENT_IS_ORION=1"
set "REFRESH_BACKUP=1"
if "%CURRENT_IS_ORION%"=="1" set "REFRESH_BACKUP=0"
if "%REFRESH_BACKUP%"=="0" (
    if not exist "%APPDATA%\Vencord\dist.orion-backup\" goto :missing_backup
    call :check_dist_complete "%APPDATA%\Vencord\dist.orion-backup"
    if errorlevel 1 goto :invalid_backup
)

:: 2) Close Discord before copying. The flavor helpers own client tracking; the
:: additional updater/liveness checks here protect the shared Vencord filesystem.
echo  [1/4] Closing Discord...
call :stopFlavor Discord
call :stopFlavor DiscordCanary
call :stopFlavor DiscordPTB
taskkill /F /IM DiscordSystemHelper.exe >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-vencord-target.ps1" -Action StopDiscordUpdaters >nul 2>&1
if errorlevel 1 goto :discord_still_running
ping -n 3 127.0.0.1 >nul

tasklist /FI "IMAGENAME eq Discord.exe" /NH 2>nul | find /I "Discord.exe" >nul
if not errorlevel 1 goto :discord_still_running
tasklist /FI "IMAGENAME eq DiscordCanary.exe" /NH 2>nul | find /I "DiscordCanary.exe" >nul
if not errorlevel 1 goto :discord_still_running
tasklist /FI "IMAGENAME eq DiscordPTB.exe" /NH 2>nul | find /I "DiscordPTB.exe" >nul
if not errorlevel 1 goto :discord_still_running
tasklist /FI "IMAGENAME eq DiscordSystemHelper.exe" /NH 2>nul | find /I "DiscordSystemHelper.exe" >nul
if not errorlevel 1 goto :discord_still_running

:: 3) Build/refresh the recovery copy beside the current one, verify it, then swap
:: it into place. A failed refresh must never destroy the only usable backup.
echo  [2/4] Copying files into Vencord...
if "%REFRESH_BACKUP%"=="0" goto :backup_ready
set "NEW_BACKUP=%APPDATA%\Vencord\dist.orion-backup.new"
set "OLD_BACKUP=%APPDATA%\Vencord\dist.orion-backup.old"
if exist "%NEW_BACKUP%\" rmdir /S /Q "%NEW_BACKUP%" >nul 2>&1
if exist "%OLD_BACKUP%\" rmdir /S /Q "%OLD_BACKUP%" >nul 2>&1
xcopy /Y /Q /E /I "%APPDATA%\Vencord\dist" "%NEW_BACKUP%" >nul
if errorlevel 1 goto :backup_failed
call :check_dist_complete "%NEW_BACKUP%"
if errorlevel 1 goto :backup_failed
if exist "%APPDATA%\Vencord\dist.orion-backup\" move /Y "%APPDATA%\Vencord\dist.orion-backup" "%OLD_BACKUP%" >nul
if errorlevel 1 if exist "%APPDATA%\Vencord\dist.orion-backup\" goto :backup_failed
move /Y "%NEW_BACKUP%" "%APPDATA%\Vencord\dist.orion-backup" >nul
if errorlevel 1 goto :backup_swap_failed
call :check_dist_complete "%APPDATA%\Vencord\dist.orion-backup"
if errorlevel 1 goto :backup_swap_failed
if exist "%OLD_BACKUP%\" rmdir /S /Q "%OLD_BACKUP%" >nul 2>&1

:backup_ready
:: Replace the whole dist instead of overlaying files from two builds. Any copy or
:: semantic verification failure restores the checked recovery copy before reopen.
rmdir /S /Q "%APPDATA%\Vencord\dist" >nul 2>&1
if exist "%APPDATA%\Vencord\dist\" goto :copy_failed
mkdir "%APPDATA%\Vencord\dist" >nul 2>&1
if errorlevel 1 goto :copy_failed
xcopy /Y /Q /E /I "%~dp0dist\*" "%APPDATA%\Vencord\dist\" >nul
if errorlevel 1 goto :copy_failed
call :check_dist_complete "%APPDATA%\Vencord\dist"
if errorlevel 1 goto :copy_failed
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-vencord-target.ps1" -Action IsOrionDist -VencordRoot "%APPDATA%\Vencord" >nul 2>&1
if errorlevel 1 goto :copy_failed

:: 4) Reopen whatever the flavor helpers recorded, or their single-install fallback.
echo  [3/4] Reopening Discord...
call :startFlavor Discord
call :startFlavor DiscordCanary
call :startFlavor DiscordPTB
if defined ORION_REOPEN_BLOCKED echo        A Discord build we closed could not be reopened - open it yourself.
if not defined ORION_STARTED if not defined ORION_REOPEN_BLOCKED call :startFallback
ping -n 5 127.0.0.1 >nul

echo  [4/4] Done!
echo.
echo  ==============================================================
echo   NOW ENABLE THE PLUGIN IN DISCORD:
echo  ==============================================================
echo.
echo   1. Open Discord Settings (the gear at the bottom left)
echo   2. In the left menu, scroll down to the "Vencord" section
echo   3. Click "Plugins"
echo   4. Search for: OrionQuests
echo   5. Click the blue toggle to ENABLE it
echo   6. If it asks, click "Restart" / "Reload"
echo.
echo   HOW TO USE:
echo     /orion start    -- start auto-completing quests
echo     /orion stop     -- stop
echo     /orion status   -- see progress
echo.
pause
exit /b 0

:: ── hardening helpers ──────────────────────────────────────────

:check_dist_complete
if not exist "%~1\patcher.js" exit /b 1
if not exist "%~1\preload.js" exit /b 1
if not exist "%~1\renderer.js" exit /b 1
if not exist "%~1\renderer.css" exit /b 1
for %%F in ("%~1\patcher.js") do if %%~zF LEQ 0 exit /b 1
for %%F in ("%~1\preload.js") do if %%~zF LEQ 0 exit /b 1
for %%F in ("%~1\renderer.js") do if %%~zF LEQ 0 exit /b 1
for %%F in ("%~1\renderer.css") do if %%~zF LEQ 0 exit /b 1
exit /b 0

:check_vencord_target
set "%~2=0"
if not exist "%~1" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-vencord-target.ps1" -AppAsar "%~1" -VencordRoot "%APPDATA%\Vencord" >nul 2>&1
if not errorlevel 1 set "%~2=1"
exit /b 0

:detect_patched
set "%~2=0"
set "ORION_ACTIVE_APP="
for /f "delims=" %%D in ('dir /b /ad /o:n "%LOCALAPPDATA%\%~1\app-*" 2^>nul') do if exist "%LOCALAPPDATA%\%~1\%%D\resources\" set "ORION_ACTIVE_APP=%%D"
if not defined ORION_ACTIVE_APP exit /b 0
call :check_vencord_target "%LOCALAPPDATA%\%~1\%ORION_ACTIVE_APP%\resources\app.asar" %~2
exit /b 0

:: ── flavor helpers ──────────────────────────────────────────────

:: Close one Discord build if it is running, and remember that it was.
:stopFlavor
tasklist /FI "IMAGENAME eq %~1.exe" 2>nul | find /I "%~1.exe" >nul
if errorlevel 1 goto :eof
set "ORION_WASRUNNING_%~1=1"
taskkill /F /IM %~1.exe >nul 2>&1
goto :eof

:: Reopen one build, but only the ones we closed ourselves - a Stable-only user
:: should not end up with Canary launched at them. If its updater disappeared
:: after preflight, remember that this flavor cannot be put back and suppress any
:: fallback that would open a different Discord build instead.
:startFlavor
if not defined ORION_WASRUNNING_%~1 goto :eof
if not exist "%LOCALAPPDATA%\%~1\Update.exe" (
    set "ORION_REOPEN_BLOCKED=1"
    goto :eof
)
start "" "%LOCALAPPDATA%\%~1\Update.exe" --processStart %~1.exe
set "ORION_STARTED=1"
goto :eof

:: Discord was already closed before this ran, so there is nothing to put back.
:: Start it anyway when only one build is installed and the choice is obvious.
:startFallback
set "ORION_ONLY="
set "ORION_COUNT=0"
for %%F in (Discord DiscordCanary DiscordPTB) do (
    if exist "%LOCALAPPDATA%\%%F\Update.exe" (
        set /a ORION_COUNT+=1
        set "ORION_ONLY=%%F"
    )
)
if "%ORION_COUNT%"=="1" (
    start "" "%LOCALAPPDATA%\%ORION_ONLY%\Update.exe" --processStart %ORION_ONLY%.exe
    goto :eof
)
echo        Discord was not running, so it was not reopened - open it yourself.
goto :eof

:: ── failure paths ───────────────────────────────────────────────

:package_incomplete
color 0C
echo  ERROR: The installer package is incomplete.
echo  Extract the complete release zip. The dist folder must contain non-empty:
echo    patcher.js, preload.js, renderer.js, renderer.css
echo  and verify-vencord-target.ps1 must be next to INSTALL.cmd.
echo.
pause
exit /b 1

:package_not_orion
color 0C
echo  ERROR: The bundled dist is not a valid Orion standalone Vencord build.
echo  Re-extract the official release zip instead of mixing files from builds.
echo.
pause
exit /b 1

:vencord_incomplete
color 0C
echo  ERROR: Your current Vencord installation is incomplete.
echo  Run the official Vencord installer and choose Repair, then retry.
echo.
pause
exit /b 1

:no_patched_client
color 0C
echo  ERROR: No installed Discord client points at %%APPDATA%%\Vencord.
echo  Install/Repair Vencord for the Discord client you use, then retry.
echo.
pause
exit /b 1

:stable_not_patched
color 0C
echo  ERROR: Running/fallback Discord Stable is not a launchable client patched to %%APPDATA%%\Vencord.
goto :patch_help

:canary_not_patched
color 0C
echo  ERROR: Running/fallback Discord Canary is not a launchable client patched to %%APPDATA%%\Vencord.
goto :patch_help

:ptb_not_patched
color 0C
echo  ERROR: Running/fallback Discord PTB is not a launchable client patched to %%APPDATA%%\Vencord.

:patch_help
echo  Make sure that Discord build still has Update.exe and is patched to %%APPDATA%%\Vencord, then retry.
echo.
pause
exit /b 1

:missing_backup
color 0C
echo  ERROR: The Orion bundle is active, but its original Vencord backup is missing.
echo  Run the official Vencord installer and choose Repair before reinstalling Orion.
echo.
pause
exit /b 1

:invalid_backup
color 0C
echo  ERROR: The Orion bundle is active, but dist.orion-backup is incomplete.
echo  Run the official Vencord installer and choose Repair before reinstalling Orion.
echo.
pause
exit /b 1

:discord_still_running
call :startFlavor Discord
call :startFlavor DiscordCanary
call :startFlavor DiscordPTB
color 0C
echo.
echo  ERROR: Discord or its updater did not fully close. No Vencord files were changed.
echo  Close Discord manually, wait for any client update to finish, and retry.
echo.
pause
exit /b 1

:backup_failed
if defined NEW_BACKUP if exist "%NEW_BACKUP%\" rmdir /S /Q "%NEW_BACKUP%" >nul 2>&1
if defined OLD_BACKUP if exist "%OLD_BACKUP%\" if not exist "%APPDATA%\Vencord\dist.orion-backup\" move /Y "%OLD_BACKUP%" "%APPDATA%\Vencord\dist.orion-backup" >nul
call :startFlavor Discord
call :startFlavor DiscordCanary
call :startFlavor DiscordPTB
color 0C
echo.
echo  ERROR: Could not create a complete Vencord backup. No Orion files were copied.
echo  Check free disk space and permissions, then retry.
echo.
pause
exit /b 1

:backup_swap_failed
if exist "%APPDATA%\Vencord\dist.orion-backup\" rmdir /S /Q "%APPDATA%\Vencord\dist.orion-backup" >nul 2>&1
if defined OLD_BACKUP if exist "%OLD_BACKUP%\" move /Y "%OLD_BACKUP%" "%APPDATA%\Vencord\dist.orion-backup" >nul
if not exist "%APPDATA%\Vencord\dist.orion-backup\" goto :restore_failed
call :check_dist_complete "%APPDATA%\Vencord\dist.orion-backup"
if errorlevel 1 goto :restore_failed
goto :backup_failed

:copy_failed
color 0C
echo.
echo  ERROR: Copying the Orion Vencord build failed. Restoring previous Vencord...
rmdir /S /Q "%APPDATA%\Vencord\dist" >nul 2>&1
mkdir "%APPDATA%\Vencord\dist" >nul 2>&1
xcopy /Y /Q /E /I "%APPDATA%\Vencord\dist.orion-backup\*" "%APPDATA%\Vencord\dist\" >nul
if errorlevel 1 goto :restore_failed
call :check_dist_complete "%APPDATA%\Vencord\dist"
if errorlevel 1 goto :restore_failed
call :startFlavor Discord
call :startFlavor DiscordCanary
call :startFlavor DiscordPTB
if defined ORION_REOPEN_BLOCKED echo  A Discord build we closed could not be reopened - open it yourself.
if not defined ORION_STARTED if not defined ORION_REOPEN_BLOCKED call :startFallback
echo  Previous Vencord restored. Check disk space/permissions and retry.
echo.
pause
exit /b 1

:restore_failed
color 0C
echo.
echo  ERROR: Automatic rollback also failed.
echo  Leave Discord closed. Your recovery copy remains at:
echo    %%APPDATA%%\Vencord\dist.orion-backup
echo  Run the official Vencord installer and choose Repair before reopening Discord.
echo.
pause
exit /b 1
