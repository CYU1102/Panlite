@echo off
setlocal
cd /d "%~dp0"
call npm run build
exit /b %ERRORLEVEL%
