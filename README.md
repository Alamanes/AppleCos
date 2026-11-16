# AppleCos

> **本项目是一个不稳定的试验性项目（experimental / alpha）。** 接口、目录结构、配置格式和交互方式随时可能发生破坏性变更，没有兼容性承诺，也不建议用于任何严肃或长期用途。请自行备份数据，按自己的风险承受能力试用。

以 [chat-demo](https://github.com/deepseek-ai/chat-demo) 为前端、以 [Pi](https://github.com/earendil-works/pi) 为 Harness 核心的 AI 驱动角色扮演模拟器，目标形态是社区里常说的「傻酒馆」（SillyTavern）那一类工具：让角色卡、世界设定与长期记忆真正跑起来，而界面保持一个干净的聊天窗口。

## 设计目标

- **角色扮演优先**：角色卡、开场白、世界书、示例对话、作者注释这些酒馆里约定俗成的东西，全部作为一等公民，而不是塞进系统提示词里的字符串拼接。
- **Harness 与前端解耦**：角色扮演的推理流程交给 Pi 的 agent harness 负责，前端只处理会话展示、编辑与本地持久化。
- **本地优先**：对话与附件留在浏览器自己的存储里，只有发生推理的那一刻才把上下文发出去。
- **可扩展**：模型接入、记忆策略、后处理规则通过 Pi 的扩展（extensions）与 skills 落地，不 fork 上游核心。

## 现状

仓库目前处于骨架阶段：只有项目说明、许可证与上游参考资料，尚无可以构建运行的成品。任何「能用了」的说法，在出现第一个可运行的里程碑之前都不成立。

| 组件 | 角色 | 上游 | 当前锚定版本 |
| --- | --- | --- | --- |
| 前端 | React 18 + TypeScript + rspack + zustand 的静态单页应用；消息流、Markdown/KaTeX/Mermaid 渲染、附件与 IndexedDB 本地存储、中英文界面 | [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) | `v0.1.1`（`5d5dd75`） |
| Harness | 可扩展的 agent harness，通过 TypeScript SDK 或 RPC 接入；负责工具调用、会话压缩、扩展加载 | [earendil-works/pi](https://github.com/earendil-works/pi) | `main`（`22fc026`），`@earendil-works/pi-coding-agent` 1.5.2 |
| 胶水层 | AppleCos 自有适配：会话映射、提示词组装、角色状态同步 | 本仓库 | 待实现 |

两个上游项目都是 MIT 协议，与本项目兼容。本项目与它们没有隶属关系，也未获得官方背书。

## 参考资料（RES/）

开发时把上游源码 dump 到 `RES/` 作为只读参考。该目录不纳入版本控制，体积大且随时会被上游覆盖，克隆仓库后按需自行拉取：

```sh
mkdir -p RES && cd RES
git clone --depth 1 https://github.com/deepseek-ai/chat-demo.git
git clone --depth 1 https://github.com/earendil-works/pi.git
```

- `RES/chat-demo`：前端实现参考。入口在 `src/app`，模型请求在 `src/services/api`，会话与历史导入导出在 `src/services/chat`，构建配置在 `rspack.config.ts`。
- `RES/pi`：Harness 实现参考。核心包是 `packages/coding-agent`，文档在 `packages/coding-agent/docs`（`sdk.md`、`rpc.md`、`extensions.md`、`skills.md`、`session-format.md` 是最相关的几篇），`packages/agent` 与 `packages/ai` 分别承载 agent 循环与模型接入。

修改行为请落在本仓库的适配层与 Pi 扩展里，`RES/` 只读。

## 计划中的结构

```text
AppleCos/
├── apps/
│   ├── web/          # 前端，从 chat-demo 派生
│   └── harness/      # Pi 集成与 AppleCos 扩展
├── packages/
│   ├── protocol/     # 前端 ↔ harness 的消息与事件协议
│   └── roleplay/     # 角色卡、世界书、记忆等核心逻辑
└── RES/              # 上游参考资料（本地 dump，不入库）
```

## 环境要求

- Node.js 22.19 或更新版本（Pi 的下限高于 chat-demo 的 22.12）
- pnpm 9 或更新版本
- 一个可用的模型服务凭据，保存在本地环境变量或本地配置里，不要提交进仓库

## 路线图

- **M0 骨架**：仓库、文档、参考资料、许可证。← 当前
- **M1 打通链路**：前端跑起 chat-demo 的界面，与 Pi harness 完成一次端到端对话。
- **M2 角色扮演**：角色卡导入、开场白、世界书注入、多角色会话。
- **M3 长期记忆**：可检索的记忆条目、会话压缩策略、分支回溯。

## 参与开发

面向 AI 编码代理与人类贡献者的工作约定写在本地 `AGENTS.md` 里，该文件属于开发文件，不随仓库发布，动代码之前先读一遍。

## 许可证

[MIT](LICENSE)。上游代码的版权分别归 DeepSeek（chat-demo）与 Mario Zechner（Pi），均为 MIT 协议；本仓库的衍生部分同样以 MIT 发布。

---

## English

AppleCos is an experimental, unstable AI roleplay simulator (in the vein of SillyTavern), built with [chat-demo](https://github.com/deepseek-ai/chat-demo) as its front end and [Pi](https://github.com/earendil-works/pi) as its agent harness. Character cards, world books and long-term memory are first-class citizens; the harness owns the reasoning loop, the front end owns the conversation UI and local persistence.

The project is in its skeleton stage: documentation, license and upstream reference dumps only. Nothing here builds or runs yet, and every API may change without notice.

Both upstream projects are MIT licensed. AppleCos is not affiliated with or endorsed by either of them.

License: [MIT](LICENSE).
