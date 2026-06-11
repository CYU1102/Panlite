# PanLite

轻量级多平台网盘管理工具，基于 Electron + Vue 3 + TypeScript 构建。

## ✨ 功能特性

### 📁 文件管理
- 浏览和管理网盘文件
- 支持文件上传、下载
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

## 📄 许可证

MIT License

## 🙏 致谢

- [Electron](https://www.electronjs.org/)
- [Vue.js](https://vuejs.org/)
- [Element Plus](https://element-plus.org/)
- [Vite](https://vitejs.dev/)
