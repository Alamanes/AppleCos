# AppleCos 跨层审查报告 — MyGO 接驳层与 Go/TypeScript 边界

- 审查人：专项对抗性审查员（子代理 deepseek-ipc-review）
- 审查对象：`mygo.config.ts`、`src/mygo.ts` 生成契约及其调用方、`main.go` 绑定、`@mygo-plugins/fetch` 网络出口、`AbortController` 与流式取消、会话切换与窗口生命周期
- 仓库状态：只读审查，未修改任何源码，未改动 `RES/`，未提交 Git，未安装依赖，未执行破坏性操作
- 代码基线：`github.com/egoist/mygo v0.9.1`、`@mygo-plugins/fetch ^0.9.1`、`mygo-runtime ^0.9.1`、`@earendil-works/pi-agent-core 1.5.2`、`@earendil-works/pi-ai 1.5.2`

## 一、审查范围与方法

按任务分配的领域，本次审查覆盖以下链路：

1. **生成契约**：`mygo.config.ts` 的 `bindings`/`frontendDist`/`devUrl` 配置与 `src/mygo.ts`（`mygo generate` 产物）是否与 Go 侧 `mygo.Bind` 暴露的四个服务逐方法对齐；参数个数、顺序、可空性、返回类型。
2. **调用方**：`src/world/store.ts`（`Library`/`Sessions` 适配）、`src/library.ts`（资料库编辑器适配）、`src/settings.ts`（`Settings.save`/`load`、模型列表拉取）、`src/theme.ts`（`Shell.setWindowBackground`）。
3. **宿主绑定**：`main.go` 的 `Settings`/`Library`/`Sessions`/`Shell` 绑定、`mainWindow` 生命周期、`mygo.Use(fetch.Plugin)`、`WindowOptions`。
4. **网络出口与取消**：`agent.ts` 注入 `goFetch` 的 `streamFn`、`@mygo-plugins/fetch` 的 URL 白名单/AbortSignal/Channel 关闭行为、pi-ai 是否把 `signal`/`fetch` 透传到实际请求。
5. **会话切换与流式事件**：`main.ts` 的 `send`/`halt`/`finishTurn`/`switchSession`/`openSession`/`switchWorld` 与 `persistMessage`，以及 pi-agent-core 的 `subscribe`/`waitForIdle`/`prompt` 语义。
6. **持久化契约**：`sessions.go` 的摘要读取与 `store.saveSession` 写入的镜像字段是否闭合。

**方法**：以真实代码追踪为主。凡结论依赖上游依赖的内部实现，均打开 `node_modules` 中的实际产物核对（`pi-agent-core/dist/agent.js`、`dist/agent-loop.js`、`pi-ai/dist/api/*.js`、`@mygo-plugins/fetch/dist/index.js`、`mygo-cli/index.d.ts`）。运行过 `bun run typecheck`（`tsc --noEmit`）一次，结果通过（exit 0），据此排除类型层面的契约破裂，不再重复验证。Go 侧依赖 `github.com/egoist/mygo` 的源码不在本机模块缓存中（`GOMODCACHE` 无 `egoist/mygo`，亦无 vendor），因此**涉及 MyGO 插件自身行为的判断一律标注为“待运行验证”**，不冒充代码确认。

## 二、总体结论

生成契约本身是**对齐**的：四个服务共 33 个导出方法在 `src/mygo.ts` 中一一对应，参数顺序与 `Config`/`Features`/`Artifact`/`CardSummary`/`SessionData`/`SessionSummary` 字段与 Go 结构体标签一致，`bun run typecheck` 通过。真正的风险不在“名字对不上”，而在**状态与语义的错位**：

- 页面把 `running` 当作“内核是否空闲”的唯一信号，而这个信号比一次运行真正结束早了一步（P1-1）；
- 会话切换/新建缺少互斥与世代号，两个并发的 `openSession` 可以让 `handle` 与 `activeId` 指向不同场次（P1-2）；
- `session.json` 的摘要镜像只写了 `title`/`worldId`，创建时间永久丢失，且 Go 侧用强类型 `string` 读取时间戳，任何一次“顺手把页面数字时间戳写到顶层”的修复都会让标题与 worldId 一并解析失败（P2-1）；
- 网络出口无协议/主机约束、无 CSP 兜底，模型密钥会随用户随手填的 `baseUrl` 发往任意主机，包括明文 `http`（P2-3）；
- 页面上下文持有两条未被任何调用方使用的任意路径读写能力（P2-4）。

**发现统计：共 15 项 —— P0 0 项、P1 2 项、P2 7 项、P3 6 项。** 其中 13 项为代码确认，2 项依赖 MyGO Go 侧插件行为，标注为待运行验证。重复根因已合并（见“根因归并说明”）。

## 三、详细发现

### P1-1（代码确认）忙闲信号早于运行结束，回车文本被丢弃，并在切换场次时打穿该轮收尾

**位置**：`src/main.ts:768-808`（`finishTurn`）、`src/main.ts:1661-1679`（`syncSend`/`setRunning`）、`src/main.ts:1699-1729`（`send`）、`src/main.ts:605-634`（`rebuildAgent`）

**严重度**：P1

**触发或攻击场景**：
回复刚落幕、状态胶囊已经回到“待机”的几十到几百毫秒内按一次回车（或点击另一个场次、或改动模型设置）。用户看到输入框被清空、台词没有发出，并弹出英文报错 `发送失败：Error: Agent is already processing a prompt. Use steer() or followUp() ...`。

**代码依据**：
1. `finishTurn` 第一行就 `setRunning(false)`（`main.ts:769`），本次运行此时并未结束；
2. 该监听器由 `Agent.processEvents` 逐个 `await`（`node_modules/@earendil-works/pi-agent-core/dist/agent.js:436-438`），运行要等监听器全部结算后由 `finishRun()` 收尾并清空 `activeRun`（`agent.js:385-391`）。也就是说 `running === false && activeRun !== undefined` 是真实存在的一个稳定区间，跨度等于 `finishTurn` 中后续 IPC 往返的时间（`await saveStateNow()` `main.ts:796`、`await refreshSessions()` `main.ts:798`，后者在非活跃场次上还会逐个 `loadSession`，见 `main.ts:994-1025`）；
3. `send()` 只检查 `running`（`main.ts:1709`），随后先清空输入框（`main.ts:1717-1719`）再 `await handle.agent.prompt(text)`（`main.ts:1724`）；
4. `Agent.prompt` 在 `activeRun` 存在时直接抛错（`agent.js:246-251`），异常被 `main.ts:1725-1728` 捕获并把原始英文异常字符串交给 `view.error`，输入内容不再恢复。

**次生风险（同一根因）**：如果这一轮同时存在 `pendingRebuild`（流式中改过端点，`main.ts:1559-1563`），`finishTurn` 会先 `await rebuildAgent(...)`（`main.ts:780`）再落盘；在此窗口内切换场次，`openSession` 的 `commitSession(next)` 会覆盖共享的 `session` 对象并改写 `activeId`（`main.ts:867-869`），导致该轮已经算出的 `advanceTurn`/`snapshotTurn`（`main.ts:772-774`）落到新场次的文件名下、旧场次的回合数与快照静默丢失。该路径需要“流式中改端点 + 收尾瞬间切换”两个条件，故列为次生而非主症状。

**修复建议**：
- 增加一个真正反映内核状态的判据，例如 `const busy = () => running || Boolean(handle?.agent.signal)`（`agent.js:216-223` 暴露了 `signal`），在 `send()`、`syncSend()`、`switchSession`、`createNewSession`、`applyConfig` 中统一使用；
- `send()` 改为先 `if (handle) await handle.agent.waitForIdle()`，或在 `prompt` 失败时回滚输入框（把 `text` 写回 `input` 并 `syncSend()`），并对“already processing”给出中文可读提示；
- `finishTurn` 把 `setRunning(false)` 移到所有收尾动作之后（或改为在 `finally` 里于 `await` 完成后置位），使“待机”与“可再次发送”同义。

### P1-2（代码确认）会话切换/新建无互斥与世代号，并发切换会让 `handle` 与 `activeId` 分属两个场次

**位置**：`src/main.ts:884-889`（`switchSession`）、`src/main.ts:891-921`（`createNewSession`）、`src/main.ts:846-882`（`openSession`）、`src/main.ts:605-634`（`rebuildAgent`）、`src/main.ts:748-755`（`persistMessage`）

**严重度**：P1

**触发或攻击场景**：在场次列表上快速连点两个不同场次（或连点“＋”两次）。两次 `switchSession` 都会通过 `id === activeId` 判空与 `running` 判空，然后各自 `flush()` 与 `openSession()` 并行执行。

**代码依据**：
1. `replaceAll` 级别的互斥只存在于世界切换：`switchWorld` 有 `switchingWorld` 闭锁（`main.ts:1228-1257`），而 `switchSession`/`createNewSession` 没有同类保护；
2. `openSession` 在进入耗时操作前就把 `activeId = id`（`main.ts:869`）、`commitSession(next)`（`main.ts:867`），然后才 `await rebuildAgent(...)`（`main.ts:876`）；
3. `rebuildAgent` 内部 `await createAgent(...)`（`main.ts:615`）之后才写 `handle = next` 与 `transcript`（`main.ts:625-626`）。两次 `createAgent` 的完成顺序不受调用顺序约束，因此存在 `handle = 场次 A 的 agent`、`session/activeId = 场次 B` 的交错；
4. 此后 `send()` 会用 A 的 transcript 发请求（`main.ts:1724`），而 `persistMessage` 把消息写进 `activeId` 指向的 B（`main.ts:751`），两份转录互相污染；视图上显示 A 的台词、侧栏高亮 B。

**修复建议**：
- 引入与 `switchingWorld` 同形的 `switching` 闭锁，或给每次切换分配单调递增的世代号 `openGeneration`，在 `openSession`/`rebuildAgent` 的每个 `await` 之后校验 `if (generation !== openGeneration) return;`，不一致就丢弃本次结果；
- `rebuildAgent` 不要直接写全局 `handle`，改为返回结果由调用方在世代校验通过后再赋值；
- `activeId` 的赋值与 `handle` 的赋值放在同一处、同一世代内完成，避免中途可见的半切换状态。

### P2-1（代码确认）`session.json` 摘要镜像不闭合：创建时间永久丢失；且 Go 侧强类型时间戳字段遇数字会整段解析失败

**位置**：`src/world/store.ts:157-167`（`saveSession` 镜像）、`sessions.go:132-145`（SaveState）、`sessions.go:230-275`（`loadSessionSummary`，尤其 `239-251`）、`sessions.go:68-97`（`Create` 写入的顶层字段）、`src/main.ts:1036-1038`（按 createdAt 排序）

**严重度**：P2

**触发或攻击场景**：正常使用即触发。任意一次回合保存后，该场次的创建时间就从磁盘上消失。

**代码依据**：
1. `Sessions.Create` 在 `session.json` 顶层写入 `id/title/worldId/createdAt/updatedAt/messages`（`sessions.go:79-86`）；
2. 页面第一次保存时，`store.saveSession` 只镜像了 `title` 与 `worldId`（`world/store.ts:161-165`），`createdAt`/`updatedAt` 只存在于嵌套的 `meta` 里（`src/world/session.ts:560-572`），因此被整体覆盖丢失；
3. `loadSessionSummary` 从顶层读 `createdAt`/`updatedAt`（`sessions.go:239-244`），读不到就回退到 `os.Stat(...).ModTime()`（`sessions.go:246-251`）。由于 `SaveState` 每回合重写该文件（`sessions.go:141`），`createdAt` 实际上等于“最后一次写入时间”，侧栏按 `createdAt` 升序编号（`main.ts:1036-1043`）因此会随使用漂移；
4. **放大陷阱**：`loadSessionSummary` 的探针结构体把时间字段声明为 `string`，而页面 `meta.createdAt` 是毫秒数字（`src/world/session.ts:570`）。任何人按直觉把 `meta.createdAt` 镜像到顶层（数字），`json.Unmarshal` 都会因类型不匹配整段失败，而错误被 `_ = json.Unmarshal(state, &meta)` 吞掉（`sessions.go:245`），结果 `title` 与 `worldId` 同时变空：标题退化为“未命名会话”（`sessions.go:263-266`），`worldId` 为空后该场次被 `refreshSessions` 的世界过滤掉（`main.ts:1034`），从所有世界的侧栏消失（文件仍在磁盘，界面上不可达）。

**修复建议**：
- 先改 Go：把摘要探针的时间字段改为 `json.RawMessage` 并用 `parseMetaTime(string(raw), ...)` 兼容 RFC3339 与 epoch 秒/毫秒（`store.go:183-198` 已具备该能力），且 `json.Unmarshal` 失败要显式回退而不是静默吞掉；
- 再改页面：在 `store.saveSession` 中镜像 `createdAt`/`updatedAt`（建议 ISO 字符串，与 `Create` 一致），并在 `SaveState` 返回的 summary 上校验 `worldId` 非空，为空即视为契约破裂并报错；
- 加一条回归校验：新建场次 → 连续两轮保存 → `Sessions.List` 返回的 `createdAt` 保持不变。

### P2-2（代码确认）中止/失败的消息被写进转录，重载后呈现为一条“正常回复”

**位置**：`src/main.ts:695-710`（`message_end`）、`src/main.ts:748-766`（`persistMessage`）、`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:146-159`、`node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js:172-180`

**严重度**：P2

**触发或攻击场景**：生成中途按停止键（或切换场次、打开神域导致 `halt()`），随后重开会话。界面上会出现一条被截断的“回复”，实际那一轮并未完成。

**代码依据**：
1. 中止时并不抛异常，流式函数返回一条 `stopReason: "aborted"` 的 assistant 消息，循环照常 `emit` `message_end` 后以 `turn_end`/`agent_end` 收尾（`agent-loop.js:146-159`；`stopReason` 由 `pi-ai/dist/api/openai-completions.js:486` 一类实现置位）；
2. `handleAgentEvent` 的 `message_end` 分支**无条件**先 `await persistMessage(message)`（`main.ts:698`），再判断 `stopReason`（`main.ts:705`）。于是每次中止都会向 `messages.jsonl` 追加一行（内容为已收到的残句，或空文本）；
3. 好消息（已验证，不是问题）：请求路径会主动丢弃这类消息——`transformMessages` 对 `stopReason === "error" | "aborted"` 的 assistant 消息 `continue`（`transform-messages.js:172-180`），所以不会出现“空 text 块把接口打挂”的后果；
4. 剩下的问题是**呈现与体积**：`openSession` 会把磁盘上的这类消息原样作为 `transcript` 交给 `renderTranscript`（`main.ts:860-874`），没有“本轮未完成”的标记；`scanMessages` 还会把它投影进世界视图的消息列表。长期使用会持续堆积无人清理的行。

**修复建议**：
- 在 `message_end` 中按 `stopReason` 决定是否落盘：`aborted`/`error` 只更新视图并打“本轮中断”标记，不写 `messages.jsonl`（或写入时附加 `aborted: true` 并在加载时过滤）；
- 若保留残句，重载时必须显式渲染为中断态，不能让玩家误以为是完成的一轮。

### P2-3（代码确认 + 部分待运行验证）网络出口对协议/主机零约束，密钥可被发往任意主机（含明文 http），且无 CSP 兜底

**位置**：`main.go:252-255`（`mygo.Use(fetch.Plugin)`）、`src/agent.ts:20`/`239`（注入 `goFetch`）、`src/settings.ts:562-595`（`listModels` 把密钥发到用户填的任意 `baseUrl`）、`node_modules/@mygo-plugins/fetch/dist/index.js:5-40`（无白名单、无主机策略）、`index.html:1-40`（无 CSP）、`node_modules/mygo-cli/index.d.ts:48-143`（`Config` 无 CSP/security 项，配置层无法兜底）

**严重度**：P2

**触发或攻击场景**：
- 用户把 `baseUrl` 填成 `http://` 开头的镜像站或打字错误（少一个字母的域名），`listModels` 会立刻把 `Authorization: Bearer <key>` 明文发过去（`settings.ts:577-582`）；
- 页面内任意脚本一旦获得执行机会（例如未来接入任何把模型/世界文本塞进 HTML 的渲染路径），即可通过 `goFetch` 读取任意 `http(s)` 资源——包括 `http://127.0.0.1:*` 的内网服务与云元数据地址——并把内存中的 `apiKey`（`Settings.load` 返回，`main.go:118-145`）外发，因为该出口由 Go 发起、不受 CORS 与同源策略约束（`main.go:253` 注释即为此设计）。本次审查未在该仓库找到把不受信文本写入 HTML 的汇（`innerHTML` 仅出现于 `src/icons.ts:90`、`src/ui.ts:213/252/266`，写入的都是常量图标），因此当前不具备可用的注入链，属纵深防御缺口。

**代码依据**：
- 插件入口只区分协议：`http:`/`https:` 走 Go，其余协议回落到 `globalThis.fetch`（`fetch/dist/index.js:9-10`），没有任何主机、端口、方法或响应大小限制；
- 调用方把用户输入的 `baseUrl` 直接交给它（`settings.ts:582`、`agent.ts:239`）；
- WebView 页面无 CSP：`index.html` 的 `<head>`（第 3-39 行）没有 `http-equiv`，配置层也不提供 CSP 选项（`mygo-cli/index.d.ts:48-143`），唯一可用的手段是 HTML meta。

**修复建议**：
- 在 Go 侧再包一层出口：仅允许 `https:`（或明确允许的内网主机清单），拒绝环回/私网/链路本地地址，限制重定向跨主机，并把策略失败作为 `CallError` 返回；
- `listModels` 对 `http:` 明文给出显式警告并要求确认后才携带密钥；
- 在 `index.html` 增加 `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'">`：MyGO 的 IPC 不经网络栈，`connect-src 'none'` 不会破坏 `mygo.call`，却能堵住 WebView 原生 fetch 与插件非 http 分支的回落。

**待运行验证**：插件对“页面侧关闭 Channel”是否等价于“取消 Go 侧请求”，取决于 `github.com/egoist/mygo/plugins/fetch`（本机模块缓存缺该模块）。验证方式：发起长流式请求后中途 `abort()`，在系统层观察该 TCP 连接是否立即关闭，以及 Go 进程 goroutine 数是否回落。

### P2-4（代码确认）页面上下文持有两条任意本地路径读写能力，且仓库内无任何调用方

**位置**：`library.go:334-362`（`ImportCardFile(path)`）、`library.go:393-413`（`ExportCardTo(id, path)`）、绑定处 `main.go:255`、生成侧 `src/mygo.ts:166-169`/`191-194`

**严重度**：P2

**触发或攻击场景**：任何获得页面执行权的一方（未来的模板注入、第三方脚本、调试器）可直接：
- `Library.ImportCardFile("/Users/<user>/.ssh/id_ed25519")` 之类的任意路径读取（`os.Stat` + `readLimited(path, 64MiB)`，`library.go:336-346`），权限错误之外的失败会把文件内容特征带回页面；
- `Library.ExportCardTo(cardId, "任意路径")` 任意路径写入，并会 `os.MkdirAll(filepath.Dir(target), 0o755)` 创建上级目录（`library.go:406-411`），形成稳定的“往任意位置落一个 JSON 文件”的落地点。

**代码依据**：两条方法都不校验路径是否在应用数据目录内，也不经过 `mygo.Dialog`。而页面侧只使用带系统弹窗的 `importCard()`/`exportCard()`（`src/library.ts:477-499`），`ImportCardFile`/`ExportCardTo` 的唯一调用者是 Go 内部的弹窗方法（`library.go:331`、`390`）。也就是说这两条是**为了内部复用而让渡给页面**的能力，收益为零、暴露面为正。

**修复建议**：把 `ImportCardFile`/`ExportCardTo` 从绑定面改为未导出（Go 内部小写方法或独立函数），`mygo generate` 后确认 `src/mygo.ts` 不再出现这两项；若业务确需“无弹窗导入”，则限定根目录并加入确认步骤。

### P2-5（代码确认）错误传播只有自由文本，调用方按中文子串判断，UI 直接展示宿主异常前缀

**位置**：`src/library.ts:416-430`（`String(error).includes("找不到")`）、`sessions.go:108`/`158`、`library.go:523`（中文错误文案）、`src/main.ts:1580-1582`（`reportFailure`）、`src/main.ts:1726`/`753`

**严重度**：P2

**触发或攻击场景**：一旦 Go 侧文案调整（例如把“找不到”改成“不存在”），`loadLoreDocumentById` 会把“世界书不存在”当成硬失败抛出，编辑器打开新世界书直接报错；反过来，任何真正的失败只要消息里恰好包含“找不到”，会被静默降级为“新建空书”（`library.ts:394-397` 与 `401-408` 分支）。

**代码依据**：`mygo-runtime` 的 `call` 只提供 `CallError`（`mygo-runtime/dist/index.js:11-17`、`43-45`），没有错误码；`library.ts:424` 因此只能用 `String(error)` 做子串匹配。UI 侧同样把异常原样拼接展示（`main.ts:1581`），玩家会看到 `CallError: 找不到会话：s-...` 这类中英混杂文本；`send` 的失败路径还会向玩家展示 pi-agent-core 的英文原文（P1-1）。

**修复建议**：
- Go 侧为可预期失败定义稳定标识并随错误返回（`fmt.Errorf` 前置哨兵值，或用 `errors.Is` 可判定的包装），例如 `ErrNotFound`；
- 页面侧新增一个窄适配层把哨兵值映射为 `{kind: "notfound" | "io" | "invalid"}`，`library.ts:424` 改为按 `kind` 判断；
- `reportFailure`/`view.error` 在展示前剥离 `CallError:` 前缀，并把已知英文异常映射为中文提示。

### P2-6（代码确认）体积上限与静默吞错叠加：转录超限后整场对话“变成空的”且无提示

**位置**：`store.go:28-34`（`maxArtifactBytes = 8<<20`、`maxSessionBytes = 64<<20`）、`sessions.go:117-127`（读转录吞错）、`sessions.go:132-136`（`SaveState` 的 8 MiB 上限）、`sessions.go:253-262`（摘要计数同样吞错）

**严重度**：P2

**触发或攻击场景**：长期使用的高频场次，`messages.jsonl` 超过 64 MiB，或 `session.json`（含 50 份回合快照，`main.ts:774`/`pruneSnapshots(..., 50)`）超过 8 MiB。表现分别为：
- 转录：`Sessions.Load` 的 `readLimited` 失败被 `if ... readErr == nil` 吞掉（`sessions.go:119-126`），返回空切片，界面显示一场没有台词的戏，而文件仍在磁盘上；
- 状态：`SaveState` 直接返回“文件过大”（`store.go:125-127`），`saveStateNow` 只弹一次 `保存会话失败`（`main.ts:261-263`），此后每回合都失败，进度静默停更。

**代码依据**：见上述行；两处都会把“文件过大/读失败”与“文件不存在/内容为空”混为一谈。

**修复建议**：`Sessions.Load` 区分“不存在”和“读取失败”，后者必须向上返回错误，由 `openSession` 明确提示“场次过大/损坏”并给出导出或截断入口；`SaveState` 超限时在返回值里带上当前大小，UI 提示并允许玩家清理快照；为 `messages.jsonl` 增补容量告警阈值（例如 48 MiB 提示、64 MiB 明确拒绝继续写入而不是静默截断显示）。

### P2-7（代码确认）窗口生命周期缺口：⌘Q/关窗不等待流式与状态落盘

**位置**：`src/settings.ts:2633-2637`（`beforeunload` 只 `saveConfig`）、`src/main.ts:1765-1786`（`useQuitHandler`/`quitApp` 只在应用内“退出”按钮路径生效）

**严重度**：P2

**触发或攻击场景**：生成到一半（或刚好收到 `message_end` 但 `saveStateNow` 尚未完成）时用 ⌘Q 或关闭窗口退出。Go 进程随窗口结束，页面侧的 `halt()`/`flush()`/`saveStateNow()` 都没有机会执行：最后一次状态、世界写入、配置防抖都可能丢失，转录可能出现写了一半的 JSONL 行（`sessions.go:160-169` 的单次 `Write`+`Sync` 降低了但未消除该风险）。

**代码依据**：`beforeunload` 回调是同步的，且只处理 `configTimer`（`settings.ts:2635-2637`），注释自己承认系统菜单退出绕过了 `performQuit`；`useQuitHandler` 的完整收尾链（`consent.clear` → `halt` → `flush` → `saveStateNow` → `saveWorldNow`，`main.ts:1765-1777`）没有暴露给关窗路径。

**修复建议**：在 `beforeunload` 中调用一个同步可触发的收尾（`abort()` + `navigator.sendBeacon` 不可用，改为在 Go 侧拦截窗口关闭事件并在关闭前回调页面 `mygo:window-close` 事件，等待页面的 `halt()`/`flush()` 完成或超时 300ms 后强制退出）；至少要先 `handle?.agent.abort()`，避免关窗后仍有请求在 Go 侧读流。

### P3-1（代码确认）`Sessions.Create` 的 id 同秒碰撞会截断既有场次

**位置**：`sessions.go:68-97`

id 形如 `s-20060102-150405-XXXX`，随机段只有 4 个十六进制字符（`sessions.go:69`）。同一秒内两次创建若碰撞（1/65536），`os.WriteFile(filepath.Join(dir, "messages.jsonl"), nil, ...)`（`sessions.go:94`）会把既有场次的转录清空，且不返回任何错误。建议把随机段提升到 8 字符（`randomHex(8)` 已在 `store.go:79-81` 提供）并在写 `messages.jsonl` 前用 `O_EXCL` 建 `session.json` 判重。

### P3-2（代码确认）跨场次残留的全局标志

**位置**：`src/main.ts:180-191`（`rewindPending` 等）、`src/main.ts:782-795`

`rewindPending` 只在 `finishTurn` 里被消费；玩家回退后不继续发送而是直接切走，该标志会保留到下一个场次的第一次收尾，届时对新场次执行一次整份 `Sessions.replaceMessages`（内容取自当前 `handle`，通常等价于重写自身，但会给非预期写入和错误提示创造机会）。建议在 `openSession` 里重置 `rewindPending/needsRerender/pendingRebuild/blockSeen`，并清空 `blockStream`。

### P3-3（代码确认）保存后的归一化不回读，运行时与磁盘配置可能不一致

**位置**：`src/settings.ts:530-545`（`saveConfig` 广播的是未归一化的 `payload`）、`src/main.ts:1542-1564`、`main.go:149-184`

`Settings.save` 返回 `void`（`src/mygo.ts:136-138`），页面于是把原始表单值广播给运行时；而 Go 侧 `normalizeConfig` 会把 `contextWindow/budgetPct/triggerBudget/reasoning/kind/shape` 夹到合法区间（`main.go:167-184`）。越界输入因此在本次运行内生效、下次启动被改回去，形成“设置自己变了”的现象。建议 `Save` 返回归一化后的 `Config`，页面用它广播。

### P3-4（代码确认）跨端版本以 caret 漂移，通道协议无版本号

**位置**：`package.json:17-22`（`^0.9.1`）、`go.mod`（`v0.9.1` 精确）

`@mygo-plugins/fetch`、`mygo-runtime`、`mygo-cli` 使用 caret，而 Go 依赖是精确版本。插件侧的传输细节（通道名 `plugin:fetch.Fetch`、`headers` 以二维数组 `[...headers]` 传、body 以 base64 传、chunk 字段名，见 `fetch/dist/index.js:33-40`、`71-95`）属未版本化的隐式契约：只要有一次 caret 升级把 npm 侧协议推到新版本而 Go 侧仍是 0.9.1，表现为每个请求都报 `fetch failed`。建议三者改成精确版本（与 pi 包一致），并在升级时同批更新 `go.mod`。

### P3-5（代码确认）`Shell.SetWindowBackground` 把页面字符串原样交给原生层

**位置**：`main.go:244-250`、`src/mygo.ts:301-307`、`src/theme.ts:149-166`

参数没有格式校验，直接 `window.SetBackgroundColor(color)`。当前唯一调用方传的是主题常量（`theme.ts:30-95`），失败也被 `.catch` 吞掉，风险有限。建议 Go 侧用正则接受 `#rrggbb`/`#rrggbbaa` 或 `light-dark(...)` 两种语法，其余返回 `errors.New`。

### P3-6（代码确认）死代码：`createLocalStore` 永远不会被选中，`vite dev` 下启动链路只会连续报错

**位置**：`src/world/store.ts:404-415`（`getStore` 恒返回 Go 后端）、`src/world/store.ts:244-402`、`src/main.ts:1817-1836`

`getStore()` 不判断 `mygo` 运行时是否存在，`useStore(createLocalStore())` 没有任何调用点。于是纯 `vite dev`（没有 Go 宿主）下 `Settings.load` 走 catch 回落默认值、`loadOrCreateWorld` 静默失败、`createNewSession` 弹“新建场次失败”，页面停在半初始化状态。建议在 `getStore` 中 `isMyGo() ? createGoStore() : createLocalStore()`（`mygo-runtime` 已导出 `isMyGo`，见 `mygo-runtime/dist/index.js:2-4`），让本地后端名副其实。

## 四、跨层接口风险（依赖契约，非本仓库代码缺陷）

1. **`halt()` 的正确性完全依赖 pi-agent-core 的“await 监听器”语义**。`halt()` 只做 `abort()` + `waitForIdle()`（`src/main.ts:1692-1697`），其有效性来自 `waitForIdle` 返回的 promise 在 `agent_end` 监听器全部结算后才 resolve（`agent.js:153-158`、`229-231`、`384-391`）。`package.json` 对 pi 两个包使用精确版本 `1.5.2`，这一点必须保持；任何放宽为 caret 或被间接升级，`halt()` 会退化为“立刻返回”，AGENTS.md 要求的“先 abort 再 waitForIdle”名存实亡。
2. **`signal` 透传链已核对成立**：`streamFn` 用 `...options` 保留 `signal` 并注入 `fetch: goFetch`（`agent.ts:227-240`），pi-ai 把 `options.signal` 放进请求（`openai-completions.js:194/201`、`anthropic-messages.js:609/616`、`openai-responses.js:146/153`），`simple-options` 把 `fetch` 一并下传（`simple-options.js:37-40`）。断点在 Go 侧如何把“Channel 关闭”翻译成“取消请求”，属待运行验证（见 P2-3）。
3. **"任意端点" 的 route 猜解会覆盖用户显式选择**：`detectRoute`（`agent.ts:76-111`）按 URL 后缀强制改写 `kind/shape`，而持久化的 `config.kind/shape` 仍是用户点的那个（`settings.ts:494-518`）。URL 与选择冲突时，设置面板显示与实际请求协议不一致，排查成本高。建议 UI 在检测到冲突时明确提示“已按地址识别为 X 协议”。
4. **双层 id 规则重复实现**：页面 `ID_PATTERN`（`src/library.ts:34`）与 Go `idPattern`（`store.go:40`）是同一规则的两份拷贝，都是 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`。当前一致，改一处就会让 `safeId` 生成的 id 被 Go 拒绝（表现为“标识不合法”）。建议把该约束写进生成物或单独常量文件，并加一条对比测试。
5. **`Artifact.UpdatedAt` 依赖文件 mtime**（`library.go:451-455`、`sessions.go:246-257`）：导出/导入/体检类工具若 `cp -p` 或 `rsync` 保留 mtime，列表排序会错乱；`bytes` 取 `info.Size()` 与实际内容一致，无风险。
6. **`mygo.config.ts` 与 `vite.config.ts` 的端口靠约定对齐**：`devUrl: "http://localhost:5173"`（`mygo.config.ts:9`）与 `server.port/strictPort`（`vite.config.ts:4-7`）一致，`strictPort: true` 保证端口被占时直接失败而不是静默切到 5174。该约定无自动校验，改动一侧需人工同步；`vite.config.ts:5` 的注释仍写 `mygo.json`，实际配置已迁移到 `mygo.config.ts`（`mygo-cli/index.d.ts:17-34`）。

## 五、修复顺序

1. **P1-1、P1-2（先做）**：忙闲判据与切换互斥是所有其它时序修复的地基；不先修，后面的收尾逻辑都会在错误的“空闲”假设上继续丢数据。
2. **P2-1**：先改 Go 侧时间字段的宽容解析，再改页面镜像，顺序反了会把场次摘要打成空标题/空 worldId（这正是本条的放大陷阱）。
3. **P2-2、P3-2**：中止消息与跨场次标志都属“收尾路径”清理，建议与第 1 步同批提交，避免二次改动同一函数。
4. **P2-3、P2-4**：出口收敛与绑定面收敛，一次 `mygo generate` 后统一验证生成物。
5. **P2-5、P3-3**：错误契约与配置回读，会改到 `src/mygo.ts` 的签名（`Settings.Save` 返回值），需在生成物更新后一次跑通。
6. **P2-6、P2-7、P3-1、P3-4、P3-5、P3-6**：防御性与稳定性尾项，可并行。

## 六、供修复代理执行的清单（文件 + 验收标准）

| # | 文件与位置 | 改动要点 | 验收标准 |
| --- | --- | --- | --- |
| 1 | `src/main.ts:768-808`、`1661-1679`、`1699-1729` | 引入 `busy()` 判据（`running \|\| handle?.agent.signal`），`send` 先 `waitForIdle`，失败回滚输入框；`setRunning(false)` 移到收尾之后 | 回复结束后立即连按回车两次：第二次要么正常排队发送，要么保留输入并给出中文提示；不出现 `already processing` 英文报错；不丢字 |
| 2 | `src/main.ts:846-921`、`605-634` | 切换/新建加闭锁或世代号；`rebuildAgent` 不再直接赋 `handle`，由调用方校验世代后赋值 | 快速连点两个场次：`handle.agent.state.messages` 与侧栏高亮、`activeId` 始终同属一个场次；`messages.jsonl` 不出现别场台词 |
| 3 | `sessions.go:230-275`、`src/world/store.ts:157-167` | Go 摘要探针时间字段改宽容解析并去掉吞错；页面镜像 `createdAt`/`updatedAt` | 新建场次后连做两轮：`Sessions.List()` 的 `createdAt` 不变；把顶层 `createdAt` 写成数字或 ISO 字符串，`title`/`worldId` 均正确 |
| 4 | `src/main.ts:695-710`、`748-766` | `aborted`/`error` 不写转录，或写 `aborted: true` 并在加载时过滤/标记 | 中止一次后 `wc -l messages.jsonl` 不增加；重开会话看不到伪正常回复 |
| 5 | `main.go:252-255`（或新增 Go 出口包装）、`src/settings.ts:562-595`、`index.html:3-40` | 出口协议/主机策略；明文 http 警告；加 CSP meta | `goFetch("http://127.0.0.1:1/", {})` 被拒绝且返回中文错误；CSP 生效后 `fetch("https://example.com")` 在页面直接被拦（IPC 不受影响） |
| 6 | `library.go:334-362`、`393-413` | 两条任意路径方法退出绑定面（改未导出） | `src/mygo.ts` 中不再出现 `importCardFile`/`exportCardTo` 调用名；导入导出仍只能经系统弹窗 |
| 7 | `sessions.go:101-129`、`132-145` | 区分“不存在”与“读取失败”；超限给出明确错误 | 把 `messages.jsonl` 人为扩到 65 MiB：`openSession` 报“场次过大”而非展示空场次 |
| 8 | `src/settings.ts:2633-2637`、`src/main.ts:1765-1786` | 关窗路径先 `abort()` 并触发收尾 | 流式中 ⌘Q：无残留请求；重开应用后该轮台词与状态与退出前一致（或明确标注中断） |
| 9 | `src/world/store.ts:404-415` | `getStore` 按 `isMyGo()` 选择后端 | 纯 `bun run dev:web` 打开页面可直接新建场次、保存世界，不再弹“新建场次失败” |
| 10 | `package.json:17-22`、`go.mod` | mygo 三包改精确版本 | `bun install && go build ./... && bun run typecheck` 通过；`src/mygo.ts` 未变化 |

## 七、根因归并说明

- **P1-1 与 P1-2 同源不同因**：前者是“忙闲信号定义错误”，后者是“切换路径缺少互斥/世代”。两者会在同一时间窗内同时触发，修复 1 后修复 2 的窗口显著收窄，但仍必须独立修（闭锁与世代号不能由忙闲判据代替）。
- **P2-2 与 P3-2** 都是“收尾路径没有按场次边界清理”，建议同批改。
- **P2-5、P2-6** 都是“错误被降级为沉默”：P2-5 是错误语义靠文案，P2-6 是读失败被当空内容吞掉。修复时应统一在适配层落一处映射。
- 已在审查过程中排除的非问题（避免后续误报）：`src/mygo.ts` 与 Go 绑定逐方法对齐、`Config`/`Features` 字段与 JSON 标签一致、`apiFor` 的类型断言可通过 `tsc --noEmit`、pi-ai 会在请求路径丢弃 `aborted`/`error` 的 assistant 消息、页面内不存在把模型/世界文本写入 HTML 的汇。
