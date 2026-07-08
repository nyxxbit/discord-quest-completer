@echo off
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

:: 2) Close Discord before copying
echo  [1/4] Closing Discord...
taskkill /F /IM Discord.exe >nul 2>&1
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
    echo  (the "dist" folder has to sit right next to this .cmd).
    pause
    exit /b 1
)

:: 4) Reopen Discord
echo  [3/4] Reopening Discord...
start "" "%LOCALAPPDATA%\Discord\Update.exe" --processStart Discord.exe
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
