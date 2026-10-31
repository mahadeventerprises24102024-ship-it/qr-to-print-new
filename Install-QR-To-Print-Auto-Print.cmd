@echo off
setlocal
rem Explicit per-shop photo Auto Print agent setup. Run as standard Windows user.
rem Defaults OFF until shop owner opts in on dashboard.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows-agent-autostart.ps1" -PhotoAutoPrint
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Setup failed. Read the error and check printer driver and Node.js 20+.
echo Press any key to close.
pause >nul
exit /b %EXIT_CODE%
