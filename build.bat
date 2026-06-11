@echo off
cd /d d:\27199\Documents\PanLite
call node_modules\.bin\tsc.cmd -p tsconfig.node.json 2> build_errors.txt
echo EXIT_CODE=%ERRORLEVEL% >> build_errors.txt
