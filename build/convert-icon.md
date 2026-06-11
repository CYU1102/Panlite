# 图标转换说明

PanLite 使用 `icon.svg` 作为源图标文件。

## 转换为 ICO 格式

### 方法 1：在线转换（推荐）

1. 访问 https://convertio.co/svg-ico/
2. 上传 `icon.svg`
3. 选择输出尺寸：256x256
4. 下载转换后的 `icon.ico`
5. 将 `icon.ico` 放到 `build/` 目录

### 方法 2：使用 ImageMagick

```bash
# 安装 ImageMagick
# Windows: https://imagemagick.org/script/download.php

# 转换命令
convert icon.svg -resize 256x256 icon.ico
```

### 方法 3：使用 Node.js

```bash
npm install --save-dev sharp ico-endcoder

# 创建转换脚本 convert-icon.js
```

## 图标规格

- 格式：ICO
- 尺寸：256x256 像素
- 颜色：RGBA（支持透明度）

## 注意事项

- electron-builder 支持 PNG 和 ICO 格式
- 建议同时提供 16x16、32x32、48x48、256x256 多种尺寸
- macOS 需要 ICNS 格式（可使用 iconutil 转换）
