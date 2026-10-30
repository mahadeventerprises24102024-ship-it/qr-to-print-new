@echo off
setlocal
rem Removes only this Windows user's installed QR-To-Print Agent + encrypted local key.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows-agent-autostart.ps1" -Uninstall
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Uninstall failed. Read the message above.
echo Remember to Revoke connection in the Shop Dashboard.
echo Press any key to close this window.
pause >nul
exit /b %EXIT_CODE%
