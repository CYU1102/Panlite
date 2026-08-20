@echo off
setlocal
cd /d "%~dp0\.."

echo ========================================
echo   PanLite optimized production package
echo ========================================
echo.

call npm run pack
if errorlevel 1 exit /b 1

call npm run size:report
if errorlevel 1 exit /b 1

echo.
echo Package created in: release
endlocal
