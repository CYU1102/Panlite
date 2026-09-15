# PanLite

> 面向 Windows 的多网盘桌面管理器：统一管理百度网盘、夸克网盘、UC 网盘、迅雷网盘、阿里云盘、123 云盘和 WebDAV，并提供跨网盘迁移、资源搜索、安全归档和独立 AI 知识工作台。

[![License](https://img.shields.io/badge/license-MIT-2563eb.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-44-47848f.svg)](https://www.electronjs.org/)
[![Vue](https://img.shields.io/badge/Vue-3-42b883.svg)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)

PanLite 将文件管理、批量分享、分享链接转存、任务队列和跨平台迁移集中到一个桌面界面中。AI 工作台是独立栏目，只有用户主动选择或导入的文件才会参与解析，不介入分享、转存或迁移过程。

## 0.2.2 更新

- 增加网盘文件在线预览：文本、图片、PDF、Office 文档、压缩包及音视频可以直接在文件管理器中打开。
- 增加网盘视频流式播放，支持 Range 请求、拖动跳转、倍速播放、中断和重新打开，不需要先下载完整视频。
- 文件理解优先使用本地文本层、Office 结构解析、Tesseract、FFmpeg、字幕和 Whisper；只有本地能力不足且用户配置了服务商时才调用模型。
- 改进 PDF 版面、Office 表格、OCR 页面与键值结构识别，并保留页码、工作表、幻灯片等来源定位。
- 增加 WebDAV、阿里云盘开放平台、阿里云盘网页版和 123 云盘适配器，并完善大文件断点下载、任务恢复、备份版本、自动化规则及安全检查。

## 主要能力

### 多网盘与文件管理

- 同时管理多个百度、夸克、UC 和迅雷账号
- 展示账号健康状态、容量以及可获取的会员类型和有效期
- 浏览、搜索、上传、下载、新建目录、重命名、移动和删除
- 支持文件夹递归上传/下载，并保留原目录结构
- 支持批量重命名预览以及覆盖、跳过、自动改名冲突策略
- 支持文本、图片、PDF、Office、音视频等文件的安全预览

### 分享、转存与云端迁移

- 批量创建、管理和失效分享链接
- 解析带提取码的分享地址并转存到指定目录
- 同平台优先使用网盘侧复制或转存
- 跨平台通过受控的“下载 → 校验 → 上传”流水线迁移
- 支持文件和目录、进度更新、失败重试、暂停、恢复和真实取消
- 应用异常退出后会恢复被中断的任务，而不会永久滞留在运行中

### 资源搜索

- 内置按“网盘搜索、办公学习、软件资源、游戏资源”整理的资源站入口
- 支持跨账号全局文件搜索、筛选、历史和保存的搜索条件
- 外部页面运行在受限 WebView 中，并对导航、权限和外链进行约束

### 独立 AI 工作台

- 文本：TXT、Markdown、JSON、CSV、XML、YAML、日志等
- PDF：按页提取文本层；扫描型 PDF 可回退到配置的视觉模型
- Office：按段落、工作表、幻灯片标题和备注提取 DOCX、XLSX、PPTX
- 旧版 Office：可选调用 LibreOffice 转换 DOC、XLS、PPT
- 图片：优先使用可选的本地 Tesseract OCR，未配置时可使用视觉模型
- 音视频：外挂字幕 → FFmpeg 内嵌字幕 → 本地 Whisper → 云端转写
- 压缩包：安全解压 ZIP、RAR、7Z、TAR 后递归解析，限制路径、数量、体积和深度
- 检索：支持关键词检索，以及可选 Embedding 的关键词/向量混合检索
- 对话：流式回答、停止生成、引用定位、编辑重问、重新生成和复制
- 导出：单个会话或完整知识库可导出为 Markdown

### 安全与可靠性

- Cookie、Token 和密码通过系统安全存储及带认证的加密封装保存
- 日志自动隐藏 Authorization、Cookie、OAuth Token、API Key 和临时凭据
- 配置备份默认不包含账号凭据；恢复后的新增账号需要重新登录
- 压缩包防目录穿越，并限制解压文件数量、总大小和压缩比
- 本地工具使用绝对路径、受控参数、超时、中止和输出大小限制执行
- 数据库迁移使用事务；任务取消会中止正在进行的网络请求
- 支持应用锁、自动锁定、账号健康检查、托盘状态和系统通知

## 平台支持

| 平台 | 登录方式 | 文件管理 | 上传/下载 | 分享/转存 | 跨网盘迁移 |
| --- | --- | :---: | :---: | :---: | :---: |
| 百度网盘 | 当前页扫码登录、OAuth、手动 Cookie | ✅ | ✅ | ✅ | ✅ |
| 夸克网盘 | 当前页扫码登录、手动 Cookie | ✅ | ✅ | ✅ | ✅ |
| UC 网盘 | 当前页扫码登录、手动 Cookie | ✅ | ✅ | ✅ | ✅ |
| 迅雷网盘 | 官方网页登录授权、Refresh Token | ✅ | ✅ | ✅ | ✅ |
| WebDAV | 服务器地址、用户名和应用密码 | ✅ | ✅ | — | ✅ |
| 阿里云盘开放平台 | OAuth 授权码 | ✅ | ✅ | — | ✅ |
| 阿里云盘网页版 | 网页登录、Refresh Token | ✅ | 下载 ✅ / 上传暂不可用 | ✅ | ✅ |
| 123 云盘 | 开放平台 Client ID / Secret | ✅ | ✅ | — | ✅ |

> 网盘接口和登录页面可能随平台更新而变化。PanLite 会尽量给出明确错误并保留可重试任务，但不能保证第三方平台接口长期不变。

## 安装与运行

### 下载安装包

前往 [GitHub Releases](https://github.com/CYU1102/PanLite/releases/latest) 下载最新版本：

- Windows 10/11 x64：`PanLite-Setup-0.2.2.exe`
- 校验文件：`SHA256SUMS.txt`

0.2.2 安装包按开源软件方式提供，未使用 Windows 代码签名。首次运行时系统可能显示“未知发布者”，请确认文件来自本仓库，并使用 `SHA256SUMS.txt` 核对安装包。

0.2.2 安装包 SHA-256：

```text
810297db7e0bbe788e1fffe3f48e40be2d583c2b8f45bc860cd0a180575f41bc  PanLite-Setup-0.2.2.exe
```

### 环境要求

- Windows 10/11 x64
- Node.js 22.13.x，或 Node.js 24 及更高版本
- npm 10 或更高版本

### 从源码运行

```bash
git clone https://github.com/CYU1102/Panlite.git
cd Panlite
npm ci
npm run dev
```

### 检查与测试

```bash
# ESLint、类型检查、渲染端和主进程构建、Vitest
npm run check

# 分别运行
npm run lint
npm run typecheck
npm test
```

### 构建 Windows 安装包

```bash
npm run pack
```

正式发布构建也可以运行：

```bash
npm run pack:release
```

输出位于 `release/`。当前构建配置采用最高压缩等级，仅保留简体中文和英文回退语言，并排除原生依赖的编译源码与无关平台文件。0.2.2 安装包约 108 MB，解压目录约 360 MB；实际大小会随 Electron 和依赖版本变化。

0.2.2 发布前在 Electron 和独立 Node 运行时各通过 147 个测试文件、1480 项测试；安装、从 0.2.1 升级、数据保留、卸载、成品启动和生产依赖审计均通过。夸克只读实测覆盖真实 PDF、图片、Office、文本、字幕、压缩包和 47.6 MB 视频的流式播放，测试期间没有云端写入或模型调用。

查看打包体积明细：

```bash
npm run size:report
```

## 配置

### 百度 OAuth

可在应用设置中填写百度开放平台凭据，也可以在开发环境使用：

```env
BAIDU_CLIENT_ID=your_client_id
BAIDU_CLIENT_SECRET=your_client_secret
BAIDU_REDIRECT_URI=https://openapi.baidu.com/qrcode/1
```

不要提交真实的 `.env`、Cookie、Token 或数据库文件；这些文件已经由 `.gitignore` 排除。

### AI Provider

AI 工作台支持 OpenAI 兼容接口和 Ollama。模型配置、API Key、视觉模型、转写模型与 Embedding 模型均在应用内管理。只有需要云端识别或生成的内容才会发送到当前选择的服务商。

### 可选本地工具

为了控制安装包体积，以下工具不会随 PanLite 捆绑：

| 工具 | 用途 |
| --- | --- |
| Tesseract OCR | 图片离线文字识别 |
| FFmpeg / ffprobe | 内嵌字幕和音轨提取 |
| Whisper / whisper.cpp | 音视频离线语音转写 |
| LibreOffice | 旧版 Office 高精度转换 |

安装后可在“AI 工作台 → 本地能力”中选择可执行文件和模型路径。未配置本地工具时，基础文件管理不受影响，AI 解析会按能力链自动回退。

## 项目结构

```text
Panlite/
├─ src/
│  ├─ adapters/              # 百度、夸克、UC、迅雷适配器
│  ├─ main/                  # Electron 主进程、IPC、数据库与任务系统
│  │  └─ ai/                 # AI Provider、解析、索引与会话服务
│  ├─ renderer/              # Vue 页面、组件、服务与设计令牌
│  └─ shared/                # 共享类型、平台能力与纯函数
├─ scripts/                  # 主进程构建和包体积分析
├─ electron-builder.yml      # Windows 打包配置
├─ vite.config.ts            # 渲染进程构建配置
└─ vitest.config.ts          # 测试配置
```

## 隐私说明

- PanLite 没有自建的账号中转服务器，网盘请求直接发送到对应平台。
- 账号凭据和任务数据保存在本机 Electron 用户数据目录中。
- AI 工作台不会自动读取网盘文件；只有主动选择或导入的本地、网盘文件才会建立索引。
- 图片、扫描 PDF、音视频或文本是否发送到云端，取决于选择的解析链和 AI Provider。
- 内置资源站属于外部网站，PanLite 不存储、不背书其内容，使用时请遵守当地法律和站点规则。

## 开发说明

新增网盘平台时，需要实现 `DriveAdapter`，在适配器注册表中注册，并同步维护 `src/shared/capabilities.ts` 的能力声明。涉及网盘请求、压缩包、路径或凭据的修改应同时补充 Vitest 回归测试。

## 许可证

[MIT License](LICENSE)

## 免责声明

PanLite 是非官方开源项目，与百度、夸克、UC、迅雷及内置资源站无隶属或合作关系。请勿将本项目用于侵犯版权、绕过平台限制或违反服务条款的用途。
