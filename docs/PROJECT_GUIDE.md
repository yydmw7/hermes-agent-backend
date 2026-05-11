# Hermes Agent 项目说明文档

## 项目定位

Hermes Agent 是一个本地 Hermes 管理器，目标是提供一个中文 UI，让用户通过 Web 或 Windows 桌面程序管理已经部署好的 Hermes 服务。

目标使用方式：

- Windows 用户：双击 exe 打开管理界面
- WSL / Linux 用户：在 Hermes 同一环境中运行 Web 管理面板
- 多主机用户：每台主机自动生成独立 profile，避免路径和服务名互相污染

## 技术栈

- 前端：React + TypeScript + Vite
- UI 图标：lucide-react
- 后端：Fastify
- 实时日志：Fastify WebSocket
- 配置：YAML
- 备份：tar/gzip
- 桌面壳：Electron
- 打包：electron-builder

## 目录结构

```text
config/
  default.yaml                 默认配置
  hermes-agent.yaml            本地覆盖配置
  hermes-agent.example.yaml    示例配置
  hosts/                       每台主机自动生成，不提交

electron/
  main.cjs                     Electron 主进程，启动内置后端并打开 UI

server/
  index.js                     Fastify API 入口
  cli/
    detect.js                  命令行环境检测
    setup-local.js             命令行生成本机 profile
  lib/
    config-store.js            配置合并和 host profile 读写
    environment.js             主机环境检测
    hermes-detect.js           Hermes 服务、路径、日志、备份自动发现

src/
  App.tsx                      中文管理界面
  App.css                      管理界面样式
  main.tsx                     前端入口
```

## 配置模型

配置合并顺序：

```text
config/default.yaml
config/hermes-agent.yaml
config/hosts/<current-host-id>.yaml
HERMES_AGENT_CONFIG 指定的配置文件
```

Electron 桌面版会把配置目录切换到 Windows 用户数据目录：

```text
%APPDATA%\hermes-agent\config
```

这样 exe 安装目录不可写时也能保存 profile。

## 后端 API

主要接口：

```http
GET  /api/status
GET  /api/config
PUT  /api/config
POST /api/control/:action
GET  /api/logs
GET  /ws/logs
GET  /api/backups
POST /api/backups
GET  /api/backups/:id/download
POST /api/backups/:id/verify
DELETE /api/backups/:id
GET  /api/environment
GET  /api/setup/state
GET  /api/setup/detect
POST /api/setup/detect
POST /api/setup/apply
```

控制命令只来自配置文件：

```yaml
hermes:
  commands:
    start: systemctl --user start hermes.service
    stop: systemctl --user stop hermes.service
    restart: systemctl --user restart hermes.service
    status: systemctl --user status hermes.service --no-pager
```

前端不能传任意 shell 命令。

## 运行方式

开发：

```bash
npm install
npm run dev
```

Web 生产：

```bash
npm run build
npm run start
```

检测：

```bash
npm run detect
npm run detect -- --json
npm run setup:local
```

桌面打包：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run desktop:build
```

检查：

```bash
npm run check
npm run lint
npm run build
```

## 自动检测逻辑

当前检测范围：

- 运行平台：Windows / Linux / WSL
- WSL 标记：`WSL_DISTRO_NAME`、`WSL_INTEROP`、`/proc/version`
- systemd 是否可用
- `/mnt/c`、`/mnt/d` 是否存在和可写
- systemd user/system 服务中包含 `hermes` 的条目
- `ps` 中包含 `hermes` 的进程
- 常见 Hermes 路径：
  - `/home/*/hermes`
  - `/opt/hermes`
  - `/srv/hermes`
  - `/mnt/d/Software/hermes`
- 日志候选：
  - `logs/app.log`
  - `logs/hermes.log`
  - `journalctl` 快照命令
- 健康检查候选：
  - `http://127.0.0.1:3000/health`
  - `http://127.0.0.1:3001/health`
  - `http://127.0.0.1:8080/health`
- 备份目录候选：
  - WSL 优先 `/mnt/d/HermesBackups`
  - 其次用户 Documents
  - 最后项目内 `backups`

## 桌面版行为

`electron/main.cjs` 会：

1. 启动 Electron 窗口
2. 设置 `HERMES_AGENT_EMBEDDED=1`
3. 设置 `HERMES_AGENT_CONFIG_DIR` 到用户数据目录
4. 调用 `server/index.js` 导出的 `startServer`
5. 使用随机空闲端口启动后端
6. 打开内置 UI

注意：桌面 exe 目前运行在 Windows 进程中，尚不能直接进入 WSL 执行 systemd。下一阶段需要 WSL 桥接。

## 下一阶段：WSL 桥接设计建议

建议新增：

```text
server/lib/runtimes/
  local-runtime.js
  wsl-runtime.js
```

runtime 接口建议：

```ts
detectEnvironment()
detectHermes()
execControl(action)
readLogs()
tailLogs()
createBackup(include)
healthCheck()
```

WSL 命令必须固定在后端：

```text
wsl.exe -d <distro> -- bash -lc "<fixed command>"
```

不要允许 UI 直接传 shell 字符串。

UI 建议：

- 初始化面板显示“当前为 Windows 桌面模式”
- 列出 `wsl.exe -l -v` 的 distro
- 用户选择 Hermes 所在 distro
- 点击“检测 WSL 内 Hermes”
- 应用后 profile 保存：

```yaml
runtime:
  mode: wsl-bridge
  distro: Ubuntu
```

然后所有状态、日志、控制、备份都通过 runtime 分发。

## 开源和发布

源码仓库：

```text
https://github.com/yydmw7/hermes-agent-backend
```

不要提交构建产物。发布 exe 时使用 GitHub Releases。

建议发布流程：

```bash
npm run check
npm run lint
npm run build
npm run desktop:build
```

然后把：

```text
release/Hermes-Agent-0.0.0-x64.exe
```

上传到 GitHub Release。

## 给接手 agent 的开发原则

- 先读 `docs/HANDOFF.md` 和本文档
- 以 `D:\Software\hermes-agent-backend` 为唯一工作区
- 不要修改旧目录 `D:\Software\hermes-agent`
- 修改前先看 `git status -sb`
- 保持中文 UI
- 不要提交主机私有配置和构建产物
- 做完功能至少跑：

```bash
npm run check
npm run lint
npm run build
```

涉及桌面功能时再跑：

```bash
npm run desktop:build
```

