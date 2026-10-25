# Windows 发布与回滚指南

本指南描述发布门禁和操作顺序。任何命令存在不代表本版本已通过；实际结果填入 [发布验收记录](RELEASE_ACCEPTANCE.md)。功能与真实账号范围见 [功能验收清单](FUNCTIONAL_AUDIT.md)。

## 1. 固定发布候选

1. 从明确的 Git 提交构建，记录版本、提交、Node/npm 版本及 `git status`。正式发布应使用干净工作树。
2. 对照 `package.json` 的 `engines` 使用受支持的 Node 与 npm，执行 `npm ci`。
3. 执行 `npm run check`、`npm run test:task-coverage`、`npm run security:audit`。任何失败都先处理并重跑对应门禁。
4. 确认 CI 的 Windows 构建、测试、打包与产物归档结果，并保存日志。仅有本地构建不能替代干净 runner 的结果。
5. 构建前运行 `node scripts/write-build-provenance.mjs release/build-provenance.json --require-clean`，构建与验收结束后用相同命令加 `--verify` 复核。报告包含提交、版本、锁文件哈希及正式源码文件哈希；不收录 `tmp/` 等用户临时文件。含未提交改动的本地构建只能作为候选验证，不满足干净提交发布门禁。

## 2. 构建与核对产物

1. 当前默认发行未签名 Windows 安装包，使用 `npm run pack`，输出到 `release/`；发布页面和验收记录注明未签名，不要求提供证书。
2. `npm run pack:release` 仅用于以后可选的签名更新渠道。选用该渠道时才需按 `electron-builder.release.cjs` 配置证书与发布者，并通过对应签名校验；它不是默认未签名发行的必经入口。
3. 检查包内主进程、渲染器、原生 SQLite 模块和启动日志；运行打包程序启动 smoke 与 `npm run size:report`，保留报告。
4. 运行 `npm run release:notes` 生成与 `package.json` 当前版本对应的发布说明及本指南副本；运行 `npm run checksums` 生成 `release/SHA256SUMS.txt`。
5. 对默认未签名包核对 SHA-256、包内依赖和原生模块，将签名验证记为“不适用（未签名发行）”，保持依赖签名校验的应用内更新关闭。只有选用签名渠道才运行 `npm run release:verify`，并要求 `PANLITE_PUBLISHER_NAME` 与实际证书发布者一致。
6. 发布前复核安装包、校验和、版本、发行说明及下载页面对应同一提交。macOS 使用独立 DMG 工作流，需另行完成平台验收、签名和公证。

## 3. 隔离 Windows 环境验收

在一次性 Windows VM 或专用测试机执行 `npm run test:install`，检查静默安装、隔离用户目录启动及卸载。脚本会拒绝普通本机环境，也不会覆盖已有 PanLite 安装。传入上一版本安装包、预期 SHA-256 和版本后，还会执行旧数据升级及离线回滚；缺少基线时，报告中的 `releaseUpgradeGatePassed` 明确为 `false`，不能用干净安装结果代替升级验收。

手动复现时，先在干净的一次性 Windows VM 中准备与候选提交一致的工作树、受支持的 Node/npm，并把**唯一一个**候选安装包放在 `release/`。确认 VM 中没有已安装的 PanLite，再在工作树根目录执行：

```powershell
git rev-parse HEAD
Get-ChildItem .\release\*Setup-*.exe | Get-FileHash -Algorithm SHA256
npm ci
npm run test:install -- -IsolatedMachine
Get-Content .\dist\reports\install-smoke.json
```

记录命令退出码、Windows 版本与架构、候选提交、安装包 SHA-256，并保留 `dist/reports/install-smoke.json`、`dist/reports/installed/` 下的启动 JSON 和截图。失败时一并保留日志及脚本留下的临时安装目录。

完整自动升级演练示例（只在上述一次性 VM 中执行，旧包放在 `release/` 之外，候选目录仍只能有一个安装包）：

```powershell
npm run test:install -- -IsolatedMachine -BaselineInstaller C:\isolated\baseline\PanLite-Setup-0.2.2.exe -BaselineSha256 810297db7e0bbe788e1fffe3f48e40be2d583c2b8f45bc860cd0a180575f41bc -BaselineVersion 0.2.2
```

脚本先安装并启动旧版，以旧版实际数据库结构植入合成账号、设置、暂停任务、AI 文档和中文附件；停机备份整个隔离用户目录并逐文件校验。安装候选版后核对原行字段与附件字节，再卸载候选版、重装旧版、恢复离线备份，先校验恢复字节再启动旧版复核。凭据是无效合成标记，仅证明存储字节保留，不验证解密或登录。交互安装、正常用户目录的卸载行为、真实测试账号及平台读写仍需分别验收。

Windows CI 默认从 `CYU1102/Panlite` 的 `v0.2.2` 读取上方固定 SHA-256 的旧包，每次执行自动升级/回滚；手动触发时可明确传入其他历史标签、精确 EXE 文件名及 SHA-256。基线下载、哈希、版本或数据核对失败均阻止通过，不能静默降级为只测试干净安装。

另行执行交互安装和真实账号升级演练：先安装上一版本，在测试账号中准备设置、任务、文件与 AI 数据；关闭应用，复制完整用户数据目录到安全的独立位置并记录哈希，再安装候选版。检查数据库迁移、账号登录、附件、任务状态和真实平台操作。该演练须使用可清理的测试数据。

应用内快照可帮助恢复其管理的数据库、密钥和 AI 附件，但有版本兼容与同机限制；它不能替代升级前对完整用户数据目录的离线备份。应用设置中的“配置备份”也不是完整用户数据备份，且默认不包含账号凭据。

## 4. 回滚演练

1. 停止应用与后台任务，确认进程完全退出。
2. 保存升级失败时的日志和用户数据副本，以便诊断。
3. 移除候选版程序并重新安装先前验证过的旧版。不要让旧版直接打开候选版迁移后的数据库。
4. 将升级前离线备份的用户数据目录恢复到原位置，再启动旧版并核对账号、设置、任务与附件。
5. 记录恢复耗时、数据核验、失败原因及回滚证据。只有安装、升级和回滚均达到 [验收表](RELEASE_ACCEPTANCE.md) 要求，才批准发布。

## 5. 发布后的记录

保存 `SHA256SUMS.txt`、安装包、CI 日志、体积报告和验收记录；签名渠道另存签名验证输出。若需要发布补丁，重新生成完整产物与校验和，不复用旧版本的验收结论。
