@echo off
rem =========================================================================
rem  Bake every .vox in this folder into the game. Double-click to run.
rem  Artist guide: ..\..\添加摆件资产.md (project root).
rem
rem  This file is PURE ASCII on purpose. cmd.exe parses a .bat using the OEM
rem  codepage (936 on a Chinese Windows), so UTF-8 text here - even inside a
rem  rem comment - gets mis-decoded into bytes cmd tries to execute, which
rem  prints garbage errors before the script runs. All Chinese messaging lives
rem  in scripts\bake-assets.js and is printed by node after chcp 65001.
rem =========================================================================
chcp 65001 >nul
cd /d "%~dp0..\.."

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found.
  echo.
  echo   Install the LTS build from https://nodejs.org/
  echo   then close this window and run this file again.
  echo.
  pause
  exit /b 1
)

node scripts\bake-assets.js
set RC=%ERRORLEVEL%

echo.
pause
exit /b %RC%
