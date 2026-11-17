# AppleCos

> **实验性项目。** 接口、目录结构与配置格式可能随时发生破坏性变更，不提供兼容性承诺。请自行备份数据。

AppleCos 是一个本地运行的 AI 角色扮演桌面应用，以世界设定、角色卡、世界书、长期记忆与会话存档为核心，界面为单一的对话窗口。

应用不运行在浏览器中，也不依赖 Electron。整体为 Go 单二进制（[MyGO](https://github.com/egoist/mygo) 框架），窗口由系统 WebView 承载；推理内核 [Pi](https://github.com/earendil-works/pi) 以前端依赖的形式打包进 bundle，因此无需在本机安装 Pi、Node 或浏览器。

## 功能

- 与任意 OpenAI / Anthropic 兼容端点流式对话，保留多轮上下文；模型请求由 Go 侧发出，页面不直接访问外部网络。
- 世界：首次启动生成可直接使用的默认世界「示例世界」，由世界意志（旁白）承担叙事，支持多角色同场与单一玩家身份。
- 多世界：通过侧栏世界抬头或「设置 → 世界」管理，支持新建、切换、编辑与导出；切换前先保存当前会话，再加载目标世界的会话列表。
- 资料库：世界、角色卡与世界书存放于 Go 侧资料库，编辑器直接读写。角色卡支持 JSON / PNG / CHARX 导入与导出，世界书支持 SillyTavern JSON 导入导出，世界可导出为 JSON。
- 世界书与记忆：世界书按关键词触发并注入上下文；记忆按重要度分层，由模型书写，也可在编辑器中整理。
- 叙事工具：回想、记下、换场、角色、节拍、检定。工具结果以中文卡片呈现，仅不可逆操作请求确认。
- 会话：写入应用数据目录，切换、重命名与删除均落盘；每轮结束保存状态与快照，支持回退。
- 开发者模式：通过设置开关、`Cmd+Shift+D` 或 `/神谕` 进入，额外挂载三个神力工具（改写世界、时光倒流、神谕），并在提示词中追加对应章节。
- 八套主题、世界钟、场次列表与世界状态面板。

## 数据位置

配置（含 API Key，权限 0600）与会话均位于应用数据目录：

```text
~/Library/Application Support/AppleCos/
├── config.json          端点、模型、主题、预算与功能开关
├── library/
│   ├── worlds/          世界 JSON（含内嵌角色卡与世界书）
│   ├── cards/           独立角色卡（V3 JSON）
│   └── lorebooks/       独立世界书（SillyTavern JSON）
├── sessions/<id>/
│   ├── session.json     世界状态、记忆、场景、运行时、每轮快照与逐行标题（正文只在转录里）
│   ├── messages.jsonl   一行一条 Pi AgentMessage，按原样追加
│   └── meta.json        宿主维护的列表索引：标题、创建时间与行数
├── inbox/、exports/     无文件弹窗时的固定导入导出目录（按需创建）
└── Trash/               删除的世界、角色卡、世界书与会话
```

首次启动时，旧版本存放在页面 localStorage 中的世界、角色卡与世界书会迁移至 `library/`，原始数据不予删除；仅主题选择仍写入一份 localStorage，作为首屏镜像。

## 架构

```text
AppleCos.app（Go 单二进制）
└── WKWebView：mygo://localhost
    ├── 前端：原生 TypeScript + Vite（构建产物嵌入二进制）
    │   ├── @earendil-works/pi-agent-core   agent 循环、工具执行、事件流
    │   ├── @earendil-works/pi-ai           provider、流式解析、模型接入
    │   └── src/world/                      世界引擎：卡牌、世界书、记忆、会话与提示词
    └── 页面 → Go：mygo.Bind 生成的类型化 IPC（src/mygo.ts）
```

三项设计要点：

1. **内核随应用分发。** Pi 仅以内核包形式引入，`@earendil-works/pi-coding-agent`（TUI、coding 工具、AGENTS.md 发现与 trust 机制）不参与构建。
2. **模型请求经 Go 的 fetch 插件发出。** 页面请求由 Go 侧执行，不受 CORS 限制，在 `mygo://` 自定义 scheme 下同样可用，`AbortController` 直通至 Go 侧请求。
3. **数据由 Go 侧持有。** 密钥、世界、角色卡、世界书、会话与转录均存于应用数据目录，页面仅保留运行期内存副本。

## 环境要求

- macOS（窗口使用系统 WKWebView），或 Windows 10 / 11 + WebView2 Runtime，见[在 Windows 上构建](#在-windows-上构建)
- Go 1.27.4 或更新版本
- [Bun](https://bun.sh)（前端依赖与 mygo CLI）

## 开发

```sh
bun install          # 安装前端依赖与 mygo-cli
bun run dev          # mygo dev：Vite 热更新与原生开发窗口
bun run typecheck    # tsc --noEmit
bun run build:web    # 仅构建前端 bundle
bun run build        # 构建并打包，产出 build/<os>-<arch>/AppleCos.app
```

`bun run build` 会依次生成 TypeScript 客户端、构建前端、编译 Go 二进制、做 ad hoc 签名，产出 app bundle（脚本带 `-skip-dmg`，不生成磁盘镜像）。没有 Apple Development 证书时使用 ad hoc 签名，系统会在每次重新构建后重新询问权限；正式分发需要开发者证书与公证。构建产物（`build/`、`dist/`、`.mygo/`）都在 `.gitignore` 中，不入版本库，详见[产物与资源](#产物与资源)。

## 在 Windows 上构建

Windows 与 macOS 共用同一套构建流程，差异只在系统 WebView、输出目录与安装包。以下命令在 PowerShell 中执行。

### 前置条件

- Windows 10 或 Windows 11（x64、arm64）
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)：Windows 11 自带，Windows 10 需要单独安装
- Go 1.27.4 或更新版本（见 `go.mod` 的 `go 1.27.4`）
- [Bun](https://bun.sh)
- mygo-cli：已列入 `devDependencies`，`bun install` 会装上对应平台的预编译二进制；也可以 `npm i -g mygo-cli` 或 `go install github.com/egoist/mygo/cmd/mygo@latest`
- 可选：NSIS（生成安装包）、代码签名证书

`bunx mygo doctor` 会检查 Go、Bun 与 WebView2 是否就绪。

### 在 Windows 上直接构建（首选）

```powershell
git clone <仓库地址> AppleCos
cd AppleCos
bun install
bun run build
```

产出：

```text
build\windows-amd64\AppleCos.exe                     应用本体
build\windows-amd64\applecos-setup-0.1.0-amd64.exe    安装包（需要 NSIS）
```

`bun run build` 即 `mygo build -skip-dmg`，`-skip-dmg` 只作用于 macOS，在 Windows 上被忽略。流程依次为：生成 `src/mygo.ts`、执行 `bun run build:web` 产出 `dist/`、编译 Go 并嵌入前端、打包与可选签名。

arm64 机器改用 `-platform windows/arm64`，产出在 `build\windows-arm64`。

### 从 macOS 或 Linux 交叉编译

MyGO 不依赖 cgo，官方明确支持在任意系统上为所有目标平台编译（[平台](https://mygo.run/docs/distribution)）。在 macOS 或 Linux 上：

```sh
bun install
bunx mygo build -platform windows/amd64,windows/arm64
# 或沿用 package.json 的脚本：bun run build -- -platform windows/amd64
```

产出路径与在 Windows 上构建相同，按架构分别落在 `build/windows-amd64/` 与 `build/windows-arm64/`。交叉编译的限制：

- 安装包需要 `makensis`：Windows 上缺失时 CLI 会自动下载 NSIS；macOS 与 Linux 上需自行安装（例如 `brew install makensis`），否则跳过安装包并给出提示，只产出 `.exe`。
- 签名需要在 `mygo.config.ts` 中配置 `windows.certificate`（配套环境变量 `MYGO_WINDOWS_CERTIFICATE_PASSWORD`）或 `windows.signCommand`；Windows 上走 `signtool`，其他系统走 `osslsigncode`。未签名的 `.exe` 在用户机器上会触发 SmartScreen 警告。
- 交叉编译产物无法在 macOS/Linux 上运行，验收仍需一台装有 WebView2 Runtime 的 Windows 机器。

### 调试

`bun run dev`（即 `mygo dev`）在 Windows 上会：

1. 生成 `src/mygo.ts`，运行 `bun run dev:web` 启动 Vite（`http://localhost:5173`）；
2. 把带图标、manifest 与版本信息的开发版可执行文件编译到 `.mygo\dev\windows-amd64\AppleCos Dev.exe`，并让它加载开发服务器；
3. 改动 Go 代码、配置、图标或资源时重建并重启，前端改动交给 Vite 热更新。

终端里按 `r` 回车重建重启、`c` 清屏、`q` 退出、`h` 查看帮助；`bunx mygo dev -background` 让开发窗口不抢焦点。

开发者工具：

- 开发构建带 Web 检查器：右键页面选「检查」，或调用 `win.Page().OpenDevTools()`；F5、Ctrl+R 重载，Ctrl+P 打印，Ctrl+F 查找，Ctrl+加号缩放。生产构建默认关闭。
- 通过 DevTools 协议远程调试，开发构建与生产构建都可用：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
bun run dev
```

随后用 Edge 打开 `edge://inspect`，或用 Playwright 的 `connectOverCDP` 连接 `http://127.0.0.1:9222`。`WEBVIEW2_USER_DATA_FOLDER` 可把 WebView2 的配置目录改到别处。

- 需要检查生产构建时用 `bunx mygo build -platform windows/amd64 -debug`，它保留检查器。
- 终端输出按来源加前缀：应用自己的输出为 `app │`，开发服务器为 `web │`。

### 数据目录（Windows）

配置与会话写在 `%AppData%\AppleCos`（开发版为 `%AppData%\AppleCos Dev`），目录结构与 macOS 的 `~/Library/Application Support/AppleCos` 一致。

### 已知限制

以下结论来自对 `main.go`、`src/style.css` 与 `src/theme.ts` 的检查，本次未改动相关代码。

- **右上角控件重叠**。`main.go` 使用 `mygo.TitleBarHiddenInset`；Windows 上它与 `mygo.TitleBarHidden` 等价，系统把最小化、最大化、关闭画在右上角，高度取 `TitleBarHeight`（默认 32px）。`src/style.css` 的 `.titlebar` 只消费左侧的 `--mygo-titlebar-inset-left`，右侧固定 `64px`，而 `.rail-toggle` 定位在 `top: 11px; right: 14px`（30×30），因此会盖住系统按钮的一部分。
- **左侧留白偏大**。同一处的 `max(92px, ...)` 是为 macOS 红绿灯预留的固定值，Windows 没有红绿灯，左侧会空出一块。
- **标题栏高度不一致**。页面标题栏为 52px，Windows 的系统按钮按 32px 绘制，两者不在同一视觉基线上。
- **标题栏拖拽可用**。`.titlebar` 声明了 `--app-region: drag`，mygo-runtime 的 bridge 负责拖动窗口；`.rail-toggle` 是 `no-drag`。
- **窗口背景同步可用**。`Shell.setWindowBackground` 在 Windows 后端有实现（`SetBackgroundColor`），主题切换不会闪白。
- **前端 origin 不同**。Windows 上 WebView2 把自定义 scheme 暴露为 `http://mygo.localhost`，macOS 与 Linux 上是 `mygo://localhost`。localStorage 按 origin 隔离，主题的首屏镜像不跨平台共享；正式数据都在 Go 侧，不受影响。
- **设置面板显示的路径不准确**。设置 →「关于」里硬编码了 `~/Library/Application Support/AppleCos`，在 Windows 上显示错误。
- **截图能力**。仓库内没有截图或画布导出的实现（`grep` 全仓库无 `screencapture`、`screenshot` 与画布导出相关代码），因此不存在「截图仅能由 macOS 提供」这类限制；以上各条才是实际的阻碍。

### 产物与资源

- `build/`、`dist/`、`.mygo/` 与 `mygo_windows_*.syso` 都已在 `.gitignore` 中。Windows 的 `.exe`、安装包与资源文件一律不入库，开发者自行编译。
- 仓库不需要存放任何 Windows 专用二进制。`mygo build` 会把图标、DPI 与通用控件 manifest、版本信息编译成 `mygo_windows_<arch>.syso`，临时写进主包目录并在构建结束后删除；被中断的构建留下的文件会在下次构建开始时清理，`.gitignore` 那条规则正为此准备。
- 若需要使用自备的 Windows 资源，把自己的 `.syso` 放进主包目录即可，CLI 会优先使用它。

## 配置

首次启动点右下角「设置」，填入端点、模型与 API Key。端点可以直接粘贴完整的 `/chat/completions`、`/responses` 或 `/messages` 地址，应用会自己还原成 base URL。配置写在：

```text
~/Library/Application Support/AppleCos/config.json
```

## 目录

```text
main.go          应用入口：窗口、Shell 绑定、fetch 插件
store.go         数据目录、原子写入与回收站
library.go       世界、角色卡与世界书的存取与导入导出
cards.go         角色卡 JSON / PNG / CHARX 解析与归一化
sessions.go      会话列表、状态、转录追加与重写
mygo.config.ts   应用名、标识、版本与构建配置
src/             前端（原生 TypeScript + Vite）
├── main.ts      页面入口：启动、会话、世界切换、工具与开发者模式的接线
├── agent.ts     Pi 内核装配（provider、Agent、fetch 注入）
├── settings.ts  设置面板、世界与库编辑器、世界列表、会话列表
├── library.ts   Go 资料库适配：编辑器读写、导入导出与旧数据迁移
├── ui.ts        台本视图
├── tools.ts     故事工具与神力工具
├── consent.ts   高风险动作的确认队列
├── devmode.ts   开发者模式状态机
├── theme.ts     八套主题
├── world/       世界引擎：卡牌、世界书、记忆、会话、提示词与存档
├── icons.ts     页面内图标
├── mygo.ts      生成的 Go 客户端（不手改）
└── style.css
dist/            前端构建产物，由 mygo build 嵌入二进制
build/           mygo build 的打包产物（macOS 为 .app，Windows 为 .exe）
RES/             上游参考资料（本地 dump，不入库）
```

## 上游与许可

本仓库以 [MIT](LICENSE) 发布。

- [Pi](https://github.com/earendil-works/pi)（Mario Zechner，MIT）：推理内核，以 npm 依赖引入。
- [MyGO](https://github.com/egoist/mygo)（egoist，MIT）：桌面框架，以 Go module 引入。

本项目与这两个上游没有隶属关系，也未获得官方背书。

---

## English

AppleCos is an experimental, local-first AI roleplay desktop app. It ships as a single Go binary (built with [MyGO](https://github.com/egoist/mygo)) whose window renders a TypeScript frontend in the system WebView. The [Pi](https://github.com/earendil-works/pi) agent core (`pi-ai`, `pi-agent-core`) is bundled into that frontend, so users never install Pi or Node.

The app now ships a small world engine: worlds, character cards, a keyword-triggered lorebook, layered memory, and persisted sessions with per-turn snapshots. The model runs as the world's narrator and may call six story tools; three more "divine" tools appear only in developer mode. Open developer mode from settings, with `Cmd+Shift+D`, or by sending `/神谕`.

Model requests leave through MyGO's fetch plugin, so they are not subject to CORS and work under the app's custom `mygo://` scheme. The API key lives in the app's Go-side config file, not in the page.

Requires macOS, or Windows 10/11 with the WebView2 Runtime; Go 1.27.4+ and Bun build it either way. `bun run dev` opens a live-reload development window; `bun run build` packages the app for the machine's platform. Windows builds are covered in the Chinese section above (`build/windows-<arch>/`).

License: [MIT](LICENSE).
