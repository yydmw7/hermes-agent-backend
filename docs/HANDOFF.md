# Hermes Agent 上下文交接单

更新时间：2026-05-11  
主工作目录：`D:\Software\hermes-agent-backend`  
GitHub 仓库：`https://github.com/yydmw7/hermes-agent-backend`

## 当前状态

这是一个本地 Hermes 管理器项目，已开源并从 GitHub 重新 clone 到 `D:\Software\hermes-agent-backend`。后续开发应以这个目录为准，不再使用旧目录 `D:\Software\hermes-agent`。

当前远程状态：

```bash
git status -sb
# ## main...origin/main

git remote -v
# origin https://github.com/yydmw7/hermes-agent-backend.git
```

当前远程首个提交：

```text
95806b1 Initial open-source release
```

本地已执行并通过：

```bash
npm install
npm run check
npm run lint
```

## 已完成功能

- React + Vite 中文管理界面
- Fastify 后端 API
- Electron Windows 桌面壳
- Windows portable exe 打包配置
- 本机环境检测：Windows / Linux / WSL、hostname、systemd、挂载盘
- Hermes 自动发现：systemd 服务、进程、常见安装目录、日志、健康检查、备份目录
- 主机 profile 配置模型：每台电脑生成独立 YAML
- 服务控制：启动、停止、重启，命令来自 YAML 白名单
- 日志查看：文件日志优先，journalctl 快照作为 fallback
- 备份中心：创建、下载、删除、checksum 校验 `.tar.gz`
- 开源文件：`README.md`、`LICENSE`、`SECURITY.md`、`.gitattributes`

## 重要背景

用户希望最终体验是：复制一个 Windows exe 到另一台已经配置好 Hermes 的电脑上，双击运行，就能用中文 UI 管理 Hermes。

当前桌面版已经能双击打开 UI，但它运行在 Windows 环境中，所以自动检测到的是 Windows，不是 WSL。用户的 Hermes 实际可能安装在 WSL 中。因此下一阶段的核心任务是 **WSL 桥接检测和控制**。

当前 UI 已经提示：如果 Hermes 在 WSL 里，Windows exe 需要 WSL 桥接功能才能直接控制 WSL 内部的 `systemd`、日志和备份。

## 下一步建议

优先实现 WSL 桥接：

1. 后端新增 WSL distro 检测：
   - `wsl.exe -l -v`
   - 当前默认 distro
   - 每个 distro 的状态、版本、名称

2. 后端新增 WSL 命令执行层：
   - 不允许前端传任意命令
   - 后端只执行固定探测和控制命令
   - 命令格式类似：`wsl.exe -d <distro> -- bash -lc "<fixed command>"`

3. 自动检测流程增加模式：
   - `windows-local`
   - `linux-local`
   - `wsl-bridge`

4. UI 初始化面板增加 WSL 选择：
   - 显示可用 distro
   - 用户选择 Hermes 所在 distro
   - 点击“检测 WSL 内 Hermes”
   - 应用后生成 Windows host profile，但其中记录 `runtime.mode: wsl-bridge` 和 `runtime.distro`

5. 让现有功能走 runtime 抽象：
   - status/health
   - control start/stop/restart
   - logs
   - backups
   - setup detect/apply

## 当前架构入口

前端：

- `src/App.tsx`
- `src/App.css`

后端：

- `server/index.js`
- `server/lib/environment.js`
- `server/lib/hermes-detect.js`
- `server/lib/config-store.js`

Electron：

- `electron/main.cjs`

配置：

- `config/default.yaml`
- `config/hermes-agent.yaml`
- `config/hermes-agent.example.yaml`
- `config/hosts/*.yaml` 不提交

## 常用命令

```bash
npm install
npm run dev
npm run check
npm run lint
npm run build
npm run detect
npm run setup:local
```

桌面版：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run desktop:build
```

生成物：

```text
release/Hermes-Agent-0.0.0-x64.exe
release/win-unpacked/Hermes Agent.exe
```

`release/` 不进 git。如果要发布 exe，后续应使用 GitHub Releases。

## 注意事项

- 旧目录 `D:\Software\hermes-agent` 可以删除，但旧目录里可能有已打包的 `release/` exe。
- 当前目录 `D:\Software\hermes-agent-backend` 是后续唯一主工作区。
- Windows PowerShell 可能把 UTF-8 中文输出成乱码；文件本身是 UTF-8。
- GitHub 网络偶尔不稳定；之前通过 GitHub API 上传了首个提交，随后已 clone 对齐远程。
- 用户曾在聊天中暴露 GitHub token，必须提醒用户撤销该 token。
- 不要提交：
  - `node_modules/`
  - `dist/`
  - `release/`
  - `.env`
  - `config/hosts/*.yaml`
  - 备份包和日志

## 安全边界

Hermes Agent 是本地运维工具，会执行配置文件中的命令。必须保持：

- 前端不能提交任意 shell 命令
- 后端只能执行白名单命令或固定探测命令
- 备份功能不能把路径逃逸到 Hermes root 外部
- 公开仓库不能包含真实 token、主机 profile、日志、备份

