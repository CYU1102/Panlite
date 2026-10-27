# PanLite

> 面向 Windows 的多网盘桌面管理器：接入百度、夸克、UC、迅雷、WebDAV、阿里云盘和 123 云盘，提供文件管理、跨网盘迁移、资源搜索、安全归档和 AI 知识工作台。

[![License](https://img.shields.io/badge/license-MIT-2563eb.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-44-47848f.svg)](https://www.electronjs.org/)
[![Vue](https://img.shields.io/badge/Vue-3-42b883.svg)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)

PanLite 将文件管理、批量分享、分享链接转存、任务队列和跨平台迁移集中到一个浅色桌面界面中。AI 工作台是独立栏目，只有用户主动导入的文件才会参与解析，不介入分享、转存或迁移过程。

## 主要能力

### 多网盘与文件管理

- 同时管理多个网盘账号；各平台能力与登录方式见下表
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

默认优先本地解析。模型补充识别、云端转写及语义向量按处理策略显式启用；填写模型配置不代表自动启用这些能力。

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

| 平台 | 接入方式 | 文件管理 | 上传 | 下载 | 创建分享/链接转存 |
| --- | --- | :---: | :---: | :---: | :---: |
| 百度网盘 | 网页登录、OAuth 或手动 Cookie | ✅ | ✅ | ✅ | ✅ |
| 夸克网盘 | 页内官方登录、官方窗口或手动 Cookie | ✅ | ✅ | ✅ | ✅ |
| UC 网盘 | 页内官方登录、官方窗口或手动 Cookie | ✅ | ✅ | ✅ | ✅ |
| 迅雷网盘 | 网页授权或 Refresh Token | ✅ | ✅ | ✅ | ✅ |
| WebDAV | 服务器地址与账号密码 | ✅ | ✅ | ✅ | — |
| 阿里云盘（开放平台） | 自有应用授权码或 Refresh Token | ✅ | ✅ | ✅ | — |
| 123 云盘 | 开放平台 Client ID / Secret | ✅ | ✅ | ✅ | — |
| 阿里云盘（网页版） | 网页版 Refresh Token | ✅ | — | ✅ | ✅ |

此表依据 [平台能力声明](src/shared/capabilities.ts) 与账号入口整理，表示代码已接入，不代表所有平台都经过真实账号端到端验收。跨网盘文件迁移要求来源支持下载、目标支持上传，因此网页版阿里云盘不能作为上传目标；其余限制与验收范围见 [功能验收清单](docs/FUNCTIONAL_AUDIT.md)。第三方接口和登录页面可能随平台更新而变化。

添加夸克或 UC 账号时可在当前弹窗加载官方登录页，在官方页面选择扫码等可用方式；刷新会创建新会话，取消会清理临时登录数据。官方页面无法加载或受平台限制时，可明确选择官方登录窗口。二维码是否可用、有效期及验证码要求由平台决定；当前候选尚需真实扫码验收。

## 安装与运行

### 下载安装包

如 [GitHub Releases](https://github.com/CYU1102/Panlite/releases) 已发布经验证的版本，可下载对应安装包。当前 Windows 验证目标为 Windows 10/11 x64，NSIS 安装包产物名为 `PanLite-Setup-<版本>.exe`。仓库另有 macOS DMG 配置，但 macOS 构建、签名、公证和安装验收需要在独立发布流程中确认；不要据此推断每个版本都有 macOS 下载项。

当前发行方式为未签名 Windows 安装包，使用 `npm run pack` 构建；不要求提供签名证书。发布前仍须完成 SHA-256、包内原生模块、隔离环境安装及升级/回滚验收，步骤见 [发布指南](docs/RELEASE.md)。当前需要签名验证的应用内更新保持关闭；以后采用签名更新渠道时再单独验收。

### 环境要求

- 运行已发布的 Windows 包：Windows 10/11 x64；无需单独安装 Node.js 或 npm。
- 从源码开发或打包：Node.js `^22.22.2`、`^24.15.0` 或 `^26.0.0`，npm `>=10`（以 `package.json` 的 `engines` 为准）。当前锁定的依赖仅声明支持这些范围，不支持更早的 Node 22/24 或 Node 25。
- macOS：仓库保留 arm64/x64 DMG 构建配置；具体版本是否提供安装包与支持范围以该版本发布记录和验收结果为准。

### 从源码运行

```bash
git clone https://github.com/CYU1102/Panlite.git
cd Panlite
npm ci
npm run dev
```

开发启动会先构建当前主进程，并核对 Vite 的项目身份，构建或服务检查失败时停止启动。`VITE_PORT` 同时控制服务与启动器，端口占用时直接报错。渲染页面支持热更新；修改主进程后重新执行 `npm run dev`。后续路线与完成标准见 [升级计划](UPGRADE_PLAN.md)。

本轮 `0.2.3` 候选的实现、测试和待验收范围见 [升级执行记录](docs/UPGRADE_20261025.md)。

干净提交 `4bea49e` 的 [Windows CI](https://github.com/CYU1102/Panlite/actions/runs/40173073147) 已通过 167 个测试文件（1791 项通过、1 项可选集成跳过）、未签名打包、从 `0.2.2` 合成数据升级/离线回滚/卸载，以及非静默向导控件和快捷方式检查。启动采样的尾延迟仍需复核，真人扫码与真实平台读写未验收；此候选尚未正式发布。

### 检查与测试

```bash
# ESLint、类型检查、渲染器/主进程构建和 Vitest
npm run check

# 分别运行
npm run lint
npm run typecheck
npm test

# 已为 Electron 构建 SQLite 时，直接使用应用运行时测试，不切换 ABI
npm run test:electron

# 发布前还需执行
npm run security:audit
```

固定样本基准使用 `npm run benchmark:workflows -- --output output/workflows.json`；通过 `--baseline` 指定同机、同配置的上一候选报告。目录持久化另用 `scripts/benchmark-catalog.mjs`，SQLite 必须与所用 Node/Electron 运行时匹配。报告分别记录耗时、内存、样本和源码指纹；没有兼容基线时不宣称提速。

真实任务队列取消基准使用 `npm run benchmark:tasks -- --output output/tasks.json`，自动选择 Electron Node 运行时；只使用合成账号、隔离 SQLite 和本地 HTTP，不访问真实网盘。

受控采样加 `--controlled`，每场景 2 次预热、30 次正式测量，在单个进程中交替执行。输出必须是新文件，避免覆盖旧证据；新增编译输入和实际依赖指纹后，默认五次协议也使用新的夹具版本，旧报告不会被误判为同配置可比。

### 构建 Windows 安装包

```bash
npm run pack
```

输出位于 `release/`。构建配置使用最高压缩等级，并仅保留简体中文和英文回退语言。安装包大小以本次构建的体积报告为准。

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

不要提交真实的 `.env`、Cookie、Token、数据库或本机构建产物；提交前检查 `git status` 和 `.gitignore` 的实际覆盖范围。

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
├─ electron-builder.mac.yml  # macOS DMG 配置
├─ vite.config.ts            # 渲染进程构建配置
└─ vitest.config.ts          # 测试配置
```

## 隐私说明

- PanLite 没有自建的账号中转服务器，网盘请求直接发送到对应平台。
- 账号凭据和任务数据保存在本机 Electron 用户数据目录中。
- AI 工作台只处理用户主动导入的本地文件或主动选取的网盘文件；导入后可建立本地索引。
- 图片、扫描 PDF、音视频或文本是否发送到云端，取决于选择的解析链和 AI Provider。
- 内置资源站属于外部网站，PanLite 不存储、不背书其内容，使用时请遵守当地法律和站点规则。

## 开发说明

新增网盘平台时，需要实现 `DriveAdapter`，在适配器注册表中注册，并同步维护 `src/shared/capabilities.ts` 的能力声明。涉及网盘请求、压缩包、路径或凭据的修改应同时补充 Vitest 回归测试。

## 许可证

项目在 `package.json` 中声明 MIT；许可证全文见 [LICENSE](LICENSE)。

## 免责声明

PanLite 是非官方开源项目，与上述网盘平台及内置资源站无隶属或合作关系。请勿将本项目用于侵犯版权、绕过平台限制或违反服务条款的用途。
