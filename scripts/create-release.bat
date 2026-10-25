@echo off
setlocal
cd /d "%~dp0.."
echo Preparing release notes and checksums for the current package version.
call npm run release:notes
if errorlevel 1 exit /b %ERRORLEVEL%
call npm run checksums
if errorlevel 1 exit /b %ERRORLEVEL%
echo Preparation complete. Review docs\RELEASE.md and complete acceptance before publishing.
exit /b 0
