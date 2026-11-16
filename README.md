# AppleCos

> **实验性项目。** 接口、目录结构与配置格式会随时发生破坏性变更，没有兼容性承诺。请自行备份数据。

AppleCos 是一个本地运行的 AI 角色扮演桌面应用，目标是社区里常说的「傻酒馆」那一类工具：角色卡、世界设定与长期记忆作为一等公民，界面保持一个干净的聊天窗口。

它不是一个网页应用，也不依赖 Electron：整个应用是一个 Go 单二进制（[MyGO](https://github.com/egoist/mygo) 框架），窗口内容是 macOS 系统自带的 WebView；推理内核 [Pi](https://github.com/earendil-works/pi) 以 npm 依赖的形式打包进前端 bundle。用户机器上不需要安装 Pi、不需要安装 Node，也不需要浏览器。

## 现在能用什么

- 与 DeepSeek 流式对话，多轮上下文保留
- 右上角「设置」里填写 API Key 与模型，保存到应用数据目录（文件权限 0600）
- 请求从 Go 侧发出，页面不直接连外网

还没有：角色卡、世界书、示例对话、长期记忆、会话持久化、多会话、导出、Windows/Linux 构建。

## 架构

```text
AppleCos.app（Go 单二进制，约 11 MB）
└── WKWebView：mygo://localhost
    ├── 前端：原生 TypeScript + Vite（构建产物嵌入二进制）
    │   ├── @earendil-works/pi-agent-core   agent 循环、工具执行、事件流
    │   └── @earendil-works/pi-ai           provider、流式解析、DeepSeek 接入
    └── 页面 → Go：mygo.Bind 生成的类型化 IPC（src/mygo.ts）
```

三个关键点：

1. **内核随应用分发**。Pi 只以内核包出现，`@earendil-works/pi-coding-agent`（TUI、coding 工具、AGENTS.md 发现、trust 机制）不参与构建。
2. **请求走 Go 的 fetch 插件**。页面的模型请求经 `@mygo-plugins/fetch` 由 Go 发出：不受 CORS 限制，`mygo://` 自定义 scheme 下照常工作，`AbortController` 直通到 Go 侧的请求。
3. **密钥在 Go 侧**。API Key 存在 `~/Library/Application Support/AppleCos/config.json`，页面只在启动时读入内存。

## 环境要求

- macOS（窗口使用系统 WKWebView）
- Go 1.27 或更新版本
- [Bun](https://bun.sh)（前端依赖与 mygo CLI）

## 开发

```sh
bun install          # 安装前端依赖与 mygo-cli
bun run dev          # mygo dev：Vite 热更新 + 原生开发窗口
bun run typecheck    # tsc --noEmit
bun run build        # 构建并打包，产出 build/darwin-arm64/
```

`bun run build` 会依次生成 TypeScript 客户端、构建前端、编译 Go 二进制、做 ad hoc 签名，产出 app bundle（脚本带 `-skip-dmg`，不生成磁盘镜像）：

```text
build/darwin-arm64/AppleCos.app
```

没有 Apple Development 证书时使用 ad hoc 签名，系统会在每次重新构建后重新询问权限；正式分发需要开发者证书与公证。

## 配置

首次启动点右上角「设置」，填入 DeepSeek API Key，模型默认 `deepseek-flash`（另一个可选值是 `deepseek-v4-pro`）。配置写在：

```text
~/Library/Application Support/AppleCos/config.json
```

## 目录

```text
main.go          应用入口：窗口、绑定的 Go 服务、fetch 插件
mygo.config.ts   应用名、标识、版本与构建配置
src/             前端（原生 TypeScript + Vite）
dist/            前端构建产物，由 mygo build 嵌入二进制
build/           .app 与 dmg
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

Model requests leave through MyGO's fetch plugin, so they are not subject to CORS and work under the app's custom `mygo://` scheme. The API key lives in the app's Go-side config file, not in the page.

Requires macOS, Go 1.27+, and Bun. `bun run dev` opens a live-reload development window; `bun run build` produces the app bundle alone.

License: [MIT](LICENSE).
