# PanLite

轻量级多平台网盘管理工具，基于 Electron + Vue 3 + TypeScript 构建。

## ✨ 功能特性

### 📁 文件管理
- 浏览和管理网盘文件
- 支持文件上传、下载
- 支持文件夹上传/递归下载，保留目录结构
- 支持同名文件自动重命名、跳过或覆盖
- 文件搜索功能
- 创建文件夹、重命名、移动、删除

### 🔗 批量分享
- 批量创建分享链接
- 支持设置提取码和有效期
- 分享链接统一管理

### 📦 批量转存
- 批量转存分享文件到自己的网盘
- 支持多个分享链接同时转存
- 自动解析提取码

### 🗜️ 压缩/解压
- 在线压缩文件为 ZIP/TAR
- 在线解压 ZIP/RAR/7Z/TAR 文件
- 支持加密压缩包

### 📋 任务管理
- 异步任务队列
- 实时进度跟踪
- 任务历史记录
- 任务暂停、恢复、取消和失败项重试
- 压缩/解压作为后台任务执行
- 在线失败时自动回退目录缓存

### 🔄 云端迁移
- 支持账号之间和不同网盘之间迁移文件或文件夹
- 同平台优先使用云端复制/转存，跨平台自动下载后上传
- 保留目录结构，支持自动重命名、跳过和覆盖同名文件
- 迁移结果持久化，失败任务可安全重试

### ✨ AI 工作台
- 独立于网盘分享、转存和迁移流程，只有主动导入的文件才会参与解析
- 本地解析 TXT/Markdown/JSON/CSV、PDF 文本层、DOCX/XLSX/PPTX、字幕和旧版 Office 兼容文本
- 安全解压 ZIP/RAR/7Z/TAR 后递归建立索引，限制文件数量、解压大小和递归深度
- 可使用已配置的视觉模型识别图片与扫描 PDF，使用转写模型处理音视频
- 支持多模型配置、流式回答、停止生成、会话搜索、Markdown 导出和引用定位
- 可配置 Embedding 模型，使用关键词与语义向量混合检索
- 支持编辑历史问题创建新分支、重新生成和复制回答，并可导出完整知识库
- 可选接入 Tesseract、FFmpeg、Whisper 与 LibreOffice，不捆绑重型运行时
- 文件内容未变化时复用已有索引；API Key 使用系统安全存储加密

> 图片、扫描 PDF 和音视频解析会把对应文件发送给当前选中的 AI 服务；普通文本、Office、字幕和压缩包基础解析在本地完成。

## 🚀 支持平台

| 平台 | 文件管理 | 上传 | 下载 | 分享 | 转存 |
|------|---------|------|------|------|------|
| 百度网盘 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 夸克网盘 | ✅ | ✅ | ✅ | ✅ | ✅ |
| UC网盘 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 迅雷网盘 | ✅ | ✅ | ✅ | ✅ | ✅ |

## 📦 安装

### 开发环境

```bash
# 克隆项目
git clone https://github.com/your-username/panlite.git
cd panlite

# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 运行代码检查和测试
npm run check
```

### 构建打包

```bash
# 构建生产版本
npm run build

# 打包为 Windows 安装程序
npm run pack
```

## 🛠️ 技术栈

- **前端框架**: Vue 3 + TypeScript
- **UI 组件库**: Element Plus
- **桌面框架**: Electron
- **构建工具**: Vite
- **数据库**: SQLite (better-sqlite3)
- **状态管理**: Pinia
- **路由**: Vue Router

## 📁 项目结构

```
panlite/
├── src/
│   ├── adapters/          # 网盘适配器
│   │   ├── baidu.ts       # 百度网盘
│   │   ├── quark.ts       # 夸克网盘
│   │   ├── uc.ts          # UC网盘
│   │   └── xunlei.ts      # 迅雷网盘
│   ├── main/              # Electron 主进程
│   │   ├── index.ts       # 入口文件
│   │   ├── ipc.ts         # IPC 通信
│   │   ├── db.ts          # 数据库
│   │   └── task-runner.ts # 任务执行器
│   ├── renderer/          # Vue 渲染进程
│   │   ├── pages/         # 页面组件
│   │   ├── components/    # 公共组件
│   │   └── stores/        # Pinia 状态
│   └── shared/            # 共享类型和工具
├── dist/                  # 构建输出
├── release/               # 打包输出
└── scripts/               # 构建脚本
```

## ⚙️ 配置

### 百度网盘 API 配置

在 `.env` 文件中配置百度 OAuth 凭据：

```env
BAIDU_CLIENT_ID=your_client_id
BAIDU_CLIENT_SECRET=your_client_secret
BAIDU_REDIRECT_URI=https://openapi.baidu.com/qrcode/1
```

### Cookie 登录

部分平台支持 Cookie 登录方式，可以在应用内通过浏览器获取 Cookie。

## 📝 开发说明

### 添加新平台支持

1. 在 `src/adapters/` 创建新的适配器文件
2. 实现 `DriveAdapter` 接口
3. 在 `src/adapters/registry.ts` 注册适配器

### 代码规范

- 使用 TypeScript 严格模式
- 遵循 Vue 3 Composition API 规范
- 使用 ESLint 进行代码检查
- 使用 Vitest 运行安全与单元测试

## 📄 许可证

MIT License

## 🙏 致谢

- [Electron](https://www.electronjs.org/)
- [Vue.js](https://vuejs.org/)
- [Element Plus](https://element-plus.org/)
- [Vite](https://vitejs.dev/)
