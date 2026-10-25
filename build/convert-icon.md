# 图标构建

`icon.svg` 是源图标。修改后运行 `npm run build:icons`，脚本会生成
`icon.png` 和包含 16、24、32、48、64、128、256 像素的 `icon.ico`。
Windows 安装包使用 `icon.ico`，应用窗口在运行时读取 `icon.png`。
两个文件都需要随源代码提交。

`mac-icon.png` 是 macOS 打包图标。修改源图标时也应更新它，
并在 macOS 构建中检查 Dock 和 DMG 中的显示效果。
