# Hermes Agent / Hermes 管理器

Hermes Agent 是一个面向 Hermes 服务的本地管理面板。它提供桌面版和 Web 版两种运行方式，用来查看运行状态、执行白名单控制命令、读取日志、编辑配置，并对 Hermes 数据进行一键打包备份。

> 当前桌面版会检测 Windows 主机环境。若 Hermes 安装在 WSL 内，下一阶段需要加入 WSL 桥接能力，才能从 Windows exe 直接控制 WSL 内的 `systemd`、日志和备份。

## 功能

- 中文管理界面和首页使用教学
- 主机自动检测：Windows / Linux / WSL、主机名、systemd、挂载盘
- Hermes 自动发现：systemd 服务、进程、常见安装目录、日志、健康检查地址
- 状态面板：健康检查、Hermes 目录、内存、备份数量
- 服务控制：启动、停止、重启，命令只来自配置文件白名单
- 日志查看：文件日志优先，支持 journalctl 快照 fallback
- 备份中心：一键生成 `.tar.gz`，支持下载、删除、checksum 校验
- 配置编辑：在界面中查看和保存 YAML 配置
- 多主机 profile：每台电脑生成独立配置，避免路径互相污染

## 交接与开发文档

如果你是接手开发的 agent 或工程师，请先阅读：

- `docs/HANDOFF.md`：当前状态、已完成内容、下一步建议、注意事项
- `docs/PROJECT_GUIDE.md`：项目结构、配置模型、API、运行方式、WSL 桥接设计建议

## 快速使用

### Windows 桌面版

构建单文件 exe：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run desktop:build
```

生成文件：

```text
release/Hermes-Agent-0.0.0-x64.exe
```

如果单文件版在目标电脑上无法运行，可以使用解包版：

```text
release/win-unpacked/Hermes Agent.exe
```

### Web / WSL 本地版

如果你在 Hermes 所在的同一个 WSL distro 里运行：

```bash
cd /mnt/d/Software/hermes-agent
npm install
npm run detect
npm run setup:local
npm run build
npm run start
```

然后打开：

```text
http://127.0.0.1:8787
```

## 换电脑使用时带哪些文件

普通使用只需要带：

```text
release/Hermes-Agent-0.0.0-x64.exe
```

兼容备用时带整个文件夹：

```text
release/win-unpacked/
```

不需要带：

```text
node_modules
src
server
config/hosts
```

不要复制旧电脑的 `config/hosts/*.yaml`。每台电脑的 WSL 名称、路径、服务名可能不同，应该首次运行后重新检测生成。

## 配置模型

配置按以下顺序合并：

```text
config/default.yaml
config/hermes-agent.yaml
config/hosts/<current-host-id>.yaml
HERMES_AGENT_CONFIG 指定的配置文件
```

说明：

- `config/default.yaml`：项目默认值
- `config/hermes-agent.yaml`：本地覆盖配置
- `config/hosts/*.yaml`：每台主机自动生成的 profile，默认不提交
- `HERMES_AGENT_CONFIG`：用于高级场景的显式配置路径

## 常用命令

```bash
npm install
npm run detect
npm run detect -- --json
npm run setup:local
npm run check
npm run lint
npm run build
npm run start
npm run desktop:build
```

## 开发

开发模式：

```bash
npm run dev
```

桌面调试：

```bash
npm run desktop:dev
```

生成解包桌面程序：

```bash
npm run desktop:pack
```

## 安全说明

Hermes Agent 是本地管理工具，会执行配置文件中的控制命令。请只在可信机器上运行，并确保：

- 不要把 `security.adminToken`、真实 `.env`、主机 profile 或备份文件提交到公开仓库
- 前端不能传任意 shell 命令，服务控制只能来自 YAML 白名单
- 公开部署前必须设置访问控制；当前更适合作为本机工具使用

## 当前限制

- Windows 桌面版目前只检测 Windows 环境；直接控制 WSL 内 Hermes 需要后续实现 WSL 桥接
- 恢复备份功能尚未实现，当前只支持创建、下载、删除和校验备份
- 默认未提供正式图标和签名证书

## License

MIT
