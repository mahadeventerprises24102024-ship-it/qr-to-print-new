@echo off
setlocal
rem Run normally, NOT as Administrator. Trusted QR-To-Print GitHub ZIP only.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows-agent-autostart.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Setup failed. Read the message above, then contact your shop administrator.
echo Press any key to close this window.
pause >nul
exit /b %EXIT_CODE%
