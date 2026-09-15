# 应用图标

`build/icon.svg` 是图标源文件。修改后运行 `npm run build:icons`，使用项目现有 Electron/Chromium 将 SVG 渲染为 PNG，并生成包含 16、24、32、48、64、128、256 像素图层的 ICO，无需在线转换或额外依赖。

将 `icon.svg`、`icon.png`、`icon.ico` 一并提交。Windows 应用、安装程序与卸载程序使用 ICO；主窗口使用 PNG。普通 smoke 构建也会写入图标和版本资源，只有代码签名保持关闭。

执行打包后检查 `PanLite.exe` 的图标及文件属性；正式构建还需验证签名。图标文件不是签名证书。
