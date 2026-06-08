@echo off
title Orion Relay
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0orion-relay.ps1"
pause
