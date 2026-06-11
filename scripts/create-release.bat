@echo off
echo ========================================
echo   PanLite Release 创建助手
echo ========================================
echo.

echo [1/3] 请先在 GitHub 上创建 Personal Access Token:
echo   1. 访问: https://github.com/settings/tokens
echo   2. 点击 "Generate new token (classic)"
echo   3. 勾选: repo (全部)
echo   4. 点击 "Generate token"
echo   5. 复制生成的 token
echo.

set /p TOKEN="请粘贴你的 GitHub Token: "

echo.
echo [2/3] 创建 Release v0.1.0...

curl -X POST ^
  -H "Authorization: token %TOKEN%" ^
  -H "Accept: application/vnd.github.v3+json" ^
  https://api.github.com/repos/CYU1102/Panlite/releases ^
  -d "{\"tag_name\":\"v0.1.0\",\"name\":\"PanLite v0.1.0\",\"body\":\"## 🎉 PanLite v0.1.0\\n\\n轻量级多平台网盘管理工具\\n\\n### ✨ 功能特性\\n- 📁 文件管理（浏览、上传、下载、搜索）\\n- 🔗 批量分享链接\\n- 📦 批量转存文件\\n- 🗜️ 在线压缩/解压\\n- 📋 异步任务队列\\n\\n### 🚀 支持平台\\n- 百度网盘\\n- 夸克网盘\\n- UC网盘\\n- 迅雷网盘\\n\\n### 📥 下载\\n下载 PanLite-v0.1.0-portable.zip，解压后运行 PanLite.exe 即可使用\",\"draft\":false,\"prerelease\":false}" > release_response.json

echo.
echo [3/3] 上传安装包...

REM 从响应中提取 upload_url (需要安装 jq 或手动提取)
echo 请手动完成上传:
echo   1. 访问: https://github.com/CYU1102/Panlite/releases
echo   2. 点击刚创建的 Release
echo   3. 点击 "Edit release"
echo   4. 拖拽上传 release\PanLite-v0.1.0-portable.zip
echo   5. 点击 "Update release"

pause
