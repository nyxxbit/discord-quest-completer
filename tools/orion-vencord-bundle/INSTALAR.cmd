@echo off
title Orion Quests - Instalador
color 0B
echo.
echo  ==============================================================
echo                Orion Quests - Instalador automatico
echo  ==============================================================
echo.

cd /d "%~dp0"

:: 1) Vencord precisa estar instalado primeiro
if not exist "%APPDATA%\Vencord\dist\" (
    color 0C
    echo  ERRO: Voce precisa instalar o Vencord PRIMEIRO.
    echo.
    echo  1. Abra https://vencord.dev/download no navegador
    echo  2. Baixe e rode o instalador do Windows
    echo  3. Depois volte aqui e clique de novo em INSTALAR.cmd
    echo.
    pause
    exit /b 1
)

:: 2) Fechar Discord antes de copiar
echo  [1/4] Fechando o Discord...
taskkill /F /IM Discord.exe >nul 2>&1
taskkill /F /IM DiscordSystemHelper.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: 3) Copiar os arquivos
echo  [2/4] Copiando arquivos para o Vencord...
xcopy /Y /Q "dist\*" "%APPDATA%\Vencord\dist\" >nul
if errorlevel 1 (
    color 0C
    echo.
    echo  ERRO ao copiar os arquivos. Verifique se voce extraiu o zip
    echo  completo (a pasta "dist" precisa estar do lado deste .cmd).
    pause
    exit /b 1
)

:: 4) Reabrir Discord
echo  [3/4] Reabrindo o Discord...
start "" "%LOCALAPPDATA%\Discord\Update.exe" --processStart Discord.exe
timeout /t 4 /nobreak >nul

echo  [4/4] Pronto!
echo.
echo  ==============================================================
echo   AGORA ATIVE O PLUGIN NO DISCORD:
echo  ==============================================================
echo.
echo   1. Abra as Configuracoes do Discord (a engrenagem em baixo)
echo   2. No menu da esquerda, role ate a secao "Vencord"
echo   3. Clique em "Plugins"
echo   4. Na busca, digite: OrionQuests
echo   5. Clique no botao azul pra ATIVAR
echo   6. Se pedir, clica em "Restart" / "Reload"
echo.
echo   PRA USAR:
echo     /orion start    -- comecar a auto-completar quests
echo     /orion stop     -- parar
echo     /orion status   -- ver progresso
echo.
pause
