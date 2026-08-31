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

:: 1) Vencord must be installed first
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

:: 2) Close Discord before copying. Vencord keeps one shared dist folder for every
::    branch, so a running Canary or PTB locks the same files Stable would - close
::    all three, and remember which ones were open so we reopen exactly those.
echo  [1/4] Closing Discord...
call :stopFlavor Discord
call :stopFlavor DiscordCanary
call :stopFlavor DiscordPTB
taskkill /F /IM DiscordSystemHelper.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul

:: 3) Back up the current Vencord build once (so this is undoable), then copy ours in
echo  [2/4] Copying files into Vencord...
if not exist "%APPDATA%\Vencord\dist.orion-backup\" (
    xcopy /Y /Q /E /I "%APPDATA%\Vencord\dist" "%APPDATA%\Vencord\dist.orion-backup" >nul
)
xcopy /Y /Q "dist\*" "%APPDATA%\Vencord\dist\" >nul
if errorlevel 1 (
    color 0C
    echo.
    echo  ERROR copying the files. Make sure you extracted the whole zip
    echo  ^(the "dist" folder has to sit right next to this .cmd^).
    pause
    exit /b 1
)

:: 4) Reopen whatever we closed
echo  [3/4] Reopening Discord...
call :startFlavor Discord
call :startFlavor DiscordCanary
call :startFlavor DiscordPTB
if not defined ORION_STARTED call :startFallback
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


:: ── helpers ───────────────────────────────────────────────────

:: Close one Discord build if it is running, and remember that it was.
:stopFlavor
tasklist /FI "IMAGENAME eq %~1.exe" 2>nul | find /I "%~1.exe" >nul
if errorlevel 1 goto :eof
set "ORION_WASRUNNING_%~1=1"
taskkill /F /IM %~1.exe >nul 2>&1
goto :eof

:: Reopen one build, but only the ones we closed ourselves - a Stable-only user
:: should not end up with Canary launched at them.
:startFlavor
if not defined ORION_WASRUNNING_%~1 goto :eof
if not exist "%LOCALAPPDATA%\%~1\Update.exe" goto :eof
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
