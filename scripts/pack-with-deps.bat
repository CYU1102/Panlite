@echo off
echo ========================================
echo   PanLite 打包脚本（含完整依赖）
echo ========================================
echo.

echo [1/5] 清理旧文件...
cd /d d:\27199\Documents\PanLite
taskkill /F /IM PanLite.exe 2>nul
rmdir /s /q release 2>nul

echo [2/5] 构建项目...
call npm run build
if %ERRORLEVEL% neq 0 (
    echo 构建失败！
    pause
    exit /b 1
)

echo [3/5] Electron 打包...
call npx electron-builder --win --dir
if %ERRORLEVEL% neq 0 (
    echo Electron 打包失败！
    pause
    exit /b 1
)

echo [4/5] 复制依赖到 resources...
cd release\win-unpacked\resources
mkdir node_modules 2>nul

:: 复制所有生产依赖
xcopy /E /I /Y ..\..\..\node_modules\better-sqlite3 node_modules\better-sqlite3
xcopy /E /I /Y ..\..\..\node_modules\cheerio node_modules\cheerio
xcopy /E /I /Y ..\..\..\node_modules\electron-log node_modules\electron-log
xcopy /E /I /Y ..\..\..\node_modules\p-queue node_modules\p-queue
xcopy /E /I /Y ..\..\..\node_modules\uuid node_modules\uuid

:: 复制子依赖
xcopy /E /I /Y ..\..\..\node_modules\parse5 node_modules\parse5 2>nul
xcopy /E /I /Y ..\..\..\node_modules\parse5-htmlparser2-tree-adapter node_modules\parse5-htmlparser2-tree-adapter 2>nul
xcopy /E /I /Y ..\..\..\node_modules\htmlparser2 node_modules\htmlparser2 2>nul
xcopy /E /I /Y ..\..\..\node_modules\dom-serializer node_modules\dom-serializer 2>nul
xcopy /E /I /Y ..\..\..\node_modules\domelementtype node_modules\domelementtype 2>nul
xcopy /E /I /Y ..\..\..\node_modules\domhandler node_modules\domhandler 2>nul
xcopy /E /I /Y ..\..\..\node_modules\domutils node_modules\domutils 2>nul
xcopy /E /I /Y ..\..\..\node_modules\entities node_modules\entities 2>nul
xcopy /E /I /Y ..\..\..\node_modules\css-select node_modules\css-select 2>nul
xcopy /E /I /Y ..\..\..\node_modules\css-what node_modules\css-what 2>nul
xcopy /E /I /Y ..\..\..\node_modules\boolbase node_modules\boolbase 2>nul
xcopy /E /I /Y ..\..\..\node_modules\nth-check node_modules\nth-check 2>nul

echo [5/5] 重新打包 asar...
del /f app.asar 2>nul
rmdir /s /q app.asar.unpacked 2>nul
call npx asar pack . app.asar --unpack-dir "node_modules/better-sqlite3"

cd ..\..
echo.
echo ========================================
echo   打包完成！
echo   输出目录: release\win-unpacked
echo ========================================
pause
