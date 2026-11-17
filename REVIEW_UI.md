# AppleCos 对抗性审查报告 · UI、DOM 与交互实现

审查员：deepseek-ui-review（UI / DOM / 交互专项）
方法：静态代码审查，逐行追踪真实代码与 DOM 接线，未启动 `bun run dev`、未截图、未改动任何源码与 `RES/`。
结论中的「代码确认」表示可由行号直接证明；「待运行验证」表示静态可推但需在应用里点一次才能定论。

## 一、范围

| 文件 | 行数 | 审查重点 |
| --- | --- | --- |
| `src/ui.ts` | 594 | 台本渲染、工具气泡、确认卡片、重放 |
| `src/settings.ts` | 2816 | 设置面板、编辑器、世界列表、场次列表、侧栏 |
| `src/style.css` | 4741 | 主题令牌、对比度、焦点、溢出、响应式、flag 布局 |
| `src/theme.ts` | 224 | 主题解析、系统跟随、窗口底色 |
| `src/icons.ts` | 92 | 图标注入、Phosphor 原始 SVG |
| `src/main.ts` | 1847 | 页面接线、事件出口、工具卡片、会话/世界切换 |
| `index.html` | 885 | 全部元素 id、角色/ARIA、对话框结构 |
| `src/lorebook-ui.ts` | 1770 | 世界书管理器（编辑器的 DOM 主体） |
| `src/consent.ts` | 245 | 确认队列与 UI 的契约 |

相邻支撑：`src/devmode.ts`（无 DOM 引用，仅经 `main.ts` 的 flag 镜像）、`src/tools.ts` 的 `consent.request` 调用点（仅用于确认哪些动作确实不可逆）。

未覆盖：Go 内部（`store.go`、`library.go`、`sessions.go`）、Pi 内核算法、`src/world/` 引擎语义。凡涉及这些层的结论只写到「UI 传给它们的入参是否正确」。

**已确认安全的部分（不凑清单）**：全仓库只有 4 处 `innerHTML`（`ui.ts:213/252/266`、`icons.ts:90`），写入的都是常量 SVG 字符串；模型输出、用户输入、角色卡、世界书正文一律走 `textContent`，因此「模板插值导致长文本/模型内容 XSS」这一路在本项目**不成立**。同样，`overflow-wrap: anywhere` 已覆盖台本正文、思想、确认卡正文、工具参数，长文本撑破版面的风险只剩一处（P3-6）。

## 二、总体结论

界面层没有注入类漏洞，也没有「按钮完全没接线」的功能缺失；问题集中在**状态所有权**与**破坏性操作的界面把关**两处：

- 2 个 P1：确认卡片与确认队列之间没有身份绑定，旧卡片能批准队列里的另一条不可逆神力；改玩家名字会静默清空全部关系数据且不询问。
- 11 个 P2：中文输入法回车误发送、世界书未保存改动静默丢弃、合并导入先删源文件、场次行非法嵌套且键盘不可达、`aria-live` 逐 token 播报、设置面板用磁盘配置覆盖运行时 flag、四个工具开关不落盘、场次切换未串行化、cast 卡点击退化为列表、工具调用重放重复、世界书试算取错场次。
- 10 个 P3：对话框缺可访问名、开场引导对读屏器隐藏、原型链判断、焦点丢失、hover 对比度、横向溢出、时钟面板不会失焦关闭、窄窗口默认抽屉遮罩、localStorage 镜像失效、静态占位与重复实现。

## 三、详细发现

### P1-1 已超时的确认卡片仍可点击，批准的是队列里的另一条不可逆动作

- 位置：`src/ui.ts:280-337`（`confirm`）、`src/main.ts:1623-1648`（`bindConsent`）、`src/consent.ts:201-240`（`pump`/`settle`）
- 严重度：P1（安全：可能误批准不可逆神力）
- 状态：代码确认

**现象与触发**

`ChatView.confirm` 只把 `request.id` 写进 `card.dataset.request`（`main.ts:1635`），此后没有任何代码读取它。点「批准」时 `settle()` 派发的是无 id 的全局事件（`ui.ts:313-321`，detail 里只有 name），监听端也不用 detail，直接取当前请求：

```ts
document.addEventListener("applecos:tool-approve", () => {
  const active = consent.current();
  if (active) consent.allow(active.id);
});
```

`ConsentQueue` 的超时是 120 秒（`main.ts:167`），由 `consent.ts:211` 的定时器结算，随后 `pump()` 立刻呈现下一条等待中的请求。**超时不会移除界面上那张卡片**，它的两个按钮仍然可点。于是：

1. 模型发出两条不可逆神力（抹掉记忆 / 抹掉世界书 / 抹掉角色，`tools.ts:1729/1772/1803` 均为 `irreversible: true`）。
2. 玩家离开 2 分钟，第一条超时被静默拒绝，第二张卡片出现。
3. 玩家回来点第一张（旧）卡片的「批准」→ `applecos:tool-approve` → `consent.current()` 返回的是**第二条**请求 → 第二条被放行。旧卡片随后显示成已批准的样子（`settle` 移除了自己的按钮），界面上看不出批准对象错位。

同一根因的第二种形态：任何残留按钮被再次派发事件（键盘 Tab 到旧卡按钮再回车）都可能命中的是已经翻页的「当前请求」。

**修复建议**

1. `ConfirmOptions` 增加必填 `requestId`，`settle()` 的 detail 改为 `{ id: options.requestId, decision }`。
2. 监听端改为 `consent.allow(detail.id)`，用 `allow/deny` 的返回值（`consent.ts:187-198` 已实现「id 不是当前请求返回 false」）判断并丢弃过期点击。
3. `main.ts` 订阅 `consent.subscribe`，在请求被 allow/deny/timeout/cancelled 结算时定位 `[data-request=id]` 的卡片并置为终态（按钮 disabled + 文案「已超时」），不要只依赖点击回调。
4. 卡片内给出剩余时间（`ConsentRequest.timeoutMs` 已存在），让玩家知道 120 秒后会自动拒绝。

### P1-2 修改玩家名字会清空全部关系数据，编辑器没有任何确认或警告

- 位置：`src/main.ts:1260-1263`（`identityChanged`）、`1323-1349`（`retirePlayerIdentity`）、`1355-1372`（`applyPlayerEdit`，关键行 1364）；`src/settings.ts:1703-1748`（`openPlayerEditor`）、`2083`（提示文案）
- 严重度：P1（数据丢失，且与「危险操作前确认」开关无关）
- 状态：代码确认

**现象与触发**

玩家角色编辑器的说明是「保存后立即生效」。实际保存路径在 `applyPlayerEdit` 里判断 `identityChanged`（旧名字非空且与新名字不同）后调用 `retirePlayerIdentity`：

```ts
world.relations = {};
for (const overlay of Object.values(session.overlays)) {
  overlay.affinity = 0; overlay.tags = []; overlay.notes = []; overlay.relationship = "";
}
```

也就是说，把名字改一个字（哪怕只是补一个姓），全世界的 `relations` 好感表与每个角色的过场记录（tags/notes/relationship）全部清零，并新建一张「前玩家身份」卡。旧卡描述里只归档了名字、设定、好感数字与关系记录（`identityArchive`，`1284-1309`），世界表本身**不可恢复**。

触发只需三步：打开「我的角色」→ 改名字 →「保存并返回」。全程没有二次确认，也不读 `flags.confirm`（`settings.ts:1832-1847` 的二次点击机制只服务于删除按钮）。

**修复建议**

1. `settings.ts` 保存玩家卡时若检测到名字变化（把 `identityChanged` 的判断前移到界面层，或在 `#editor-save` 流程里比对 `library.player` 的旧值），先弹确认：「改名为 X 会退休当前身份：世界好感表与全部关系记录将清零，旧身份会作为独立角色保留。继续？」。
2. 该确认受 `flags.confirm` 控制，与「危险操作前确认」语义一致。
3. 编辑器说明文案补一句真实后果，避免「立即生效」被理解成只换署名。
4. 若要进一步降损，退休前把 `world.relations` 与全部 overlay 完整快照进世界对象，供界面提供「撤销改名」。

### P2-1 中文输入法输入时按回车直接发送，未判断 composition

- 位置：`src/main.ts:1740-1745`；对照 `index.html:90` 的提示「回车发送　Shift 回车换行」
- 严重度：P2（中文母语用户的日常误操作）
- 状态：代码确认

```ts
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
});
```

全仓库没有 `isComposing`、`compositionstart`、`keyCode === 229` 的处理（grep 无命中）。用拼音输入时回车是「选词/上屏」，这里会把它当发送：消息带着未上屏的拼音或半截句子发出去，同时 preventDefault 让输入法无法上屏。

**修复**：`if (event.isComposing || event.keyCode === 229) return;`，并用 `compositionstart/compositionend` 维护标记兜底（WebKit 个别版本 `isComposing` 不稳）。`settings.ts:1137-1147` 的场次重命名输入框同类，可一并修。

### P2-2 世界书编辑器的未保存改动在关闭/返回时静默丢弃

- 位置：`src/settings.ts:2431-2436`（close / back）、`2439-2441`（backdrop 点击）、`1655-1666`（`teardownLoreManager`）、`1680`（`onDirty`）；`src/lorebook-ui.ts:79`、`1759`（`isDirty`）
- 严重度：P2（数据丢失）
- 状态：代码确认

`mountLorebookManager` 暴露了 `isDirty()`，**全仓库没有任何调用点**（grep 只有声明与实现）。`onDirty` 只往状态栏写一句「有未保存的改动」。因此：编辑十条世界书条目 → 点右上角 ✕ / 按 Esc / 点「返回列表」/ 点 backdrop → `dialog.close()` 或 `openEditorList` → `teardownLoreManager` → `destroy()` 清空 DOM，`doc` 引用丢弃，改动全部消失，没有任何提示。

**修复**：close、back、backdrop、dialog 的 cancel 事件统一走一个 `requestCloseEditor()`：先问 `loreManager?.isDirty()`（以及 form 态下表单值是否偏离 `findEntry` 快照），有改动则弹「保存后返回 / 放弃改动 / 取消」三选一（同样受 `flags.confirm` 约束）。

### P2-3 「合并导入」在未保存时先删除来源世界书文件

- 位置：`src/lorebook-ui.ts:1678-1712`（`mergeImport`），关键行 1704
- 严重度：P2（数据丢失，破坏性动作无确认）
- 状态：代码确认

流程是：导入文件 → 读成 `temp` → `moveEntriesToBook` 把条目搬进当前 `doc`（仅内存，`markDirty`）→ **立刻** `await deleteLibraryEntry("lore", imported.id)` 删除刚导入的那本书。若玩家随后关闭编辑器（见 P2-2，连提示都没有），当前 `doc` 未写盘，被删的源文件也已不在书架，导入内容彻底不存在。

**修复**：把 `deleteLibraryEntry` 挪到 `save()` 成功之后（`lorebook-ui.ts:1626-1638` 已是落盘路径），或保留源文件并提示「已合并，保存后可删除原书」；删除前走与 `requestDelete` 一致的二次确认。

### P2-4 场次行的重命名/删除按钮嵌在外层 button 内，且键盘不可达

- 位置：`src/settings.ts:1068-1123`（`sessionItem`，`1118-1119` 的 `tools.append(...)` 与 `button.append(...)`）；`src/style.css:2213-2224`
- 严重度：P2（非法标记 + 可访问性 + 误点风险）
- 状态：代码确认

```ts
tools.append(rename, remove);
button.append(scene, time, preview, tools);   // button 是一个 <button>
```

产出的结构是 `<button><span class="session-tools"><button/><button/></span></button>`：交互元素嵌套交互元素，HTML 规范禁止。屏幕阅读器会把「重命名场次」「删除场次」并进外层按钮的可访问名；外层按钮的点击区域也包含这两个小按钮（靠 stopPropagation 才没误切换）。再加上 `.session-tools { display: none }` 只在 `:hover` 或 `.selected` 时显示：未选中的行上这两个按钮被移出 tab 序列，纯键盘用户必须先用回车选中该行才能摸到它们。

**修复**：行改成 `<li><div class="session-row">`（标题为不含按钮的容器或普通 button）+ 并列的 `<div class="session-tools">` 两个按钮，兄弟而非嵌套；工具条默认用 `opacity: 0` 而非 `display: none`，配合 `.session-row:focus-within .session-tools { opacity: 1 }` 保证始终可 Tab。

### P2-5 #chat 整体是 aria-live="polite"，打字机模式逐 token 播报

- 位置：`index.html:74`；`src/ui.ts:102-110`（`delta`）、`163-177`（`updatePreview`）
- 严重度：P2（可访问性：流式体验对读屏器不可用）
- 状态：代码确认

`<div id="chat" class="script" aria-live="polite">`，而 `delta()` 每收到一个 token 就重写同一个 `<p class="speech streaming">` 的 `textContent`，`updatePreview` 同样逐字更新。live region 的默认 `aria-relevant` 包含 text，文本节点每次改写都会触发播报，实际效果是读屏器持续朗读被打断的碎片。工具气泡的状态图标（`ui.ts:249-275` 反复改 `innerHTML` 与 `aria-label`）也在该区域内。

**修复**：#chat 改 `role="log" aria-live="off"`（或保留 polite 但加 `aria-relevant="additions"`），另设视觉隐藏的 `<p id="sr-announcer" aria-live="polite">`，只在块落地时（`appendBlocks`/`finishAssistant`）写入整句；工具状态只写「工具完成/失败」；打字机预览块设 `aria-hidden="true"`。

### P2-6 打开设置面板会用磁盘配置覆盖运行时 flags，且不广播

- 位置：`src/settings.ts:2294-2334`（`openSettings`，`2322-2323` 的 `adoptConfig(config); applyFlags();`）、`452-474`（`adoptConfig`）；`src/main.ts:1566-1578`（`onFlagsChanged`）
- 严重度：P2（UI 与底层状态不一致，可静默回退用户刚做的修改）
- 状态：代码确认

`openSettings` 每次都重新 `Settings.load()`，然后 `adoptConfig` 把 features 里的 worldPanel/worldClock/scriptMode/typewriter/autoTitle/reduceMotion/showLatency/worldbook/memory/devMode 与 confirm、budget **直接写回活着的 flags**，接着只调 `applyFlags()`（改 `documentElement.dataset`），**不派发 `applecos:flags`**。运行时（`main.ts` 的 `readFlags()`、`mountedTools`、`buildTransform`）与界面显示因此脱钩。

可复现路径（代码确认）：关掉「世界书触发」→ `persistFlags` 立即广播，但配置保存是 300 ms 防抖（`settings.ts:722-727`）→ 在 300 ms 内再开一次设置 → 读到旧文件 worldbook: true → 开关被画回「开」，而 `buildTransform` 仍按 false 不注入世界书；此后任何一次 `saveConfig`（`readConfigForm` 读 flags）都会把 true 写回磁盘，用户的关闭彻底丢失。保存失败（`setSaveState("error")`）时同一套回退也会发生。

**修复**：`openSettings` 只在首次加载时把磁盘配置灌进 flags；每次打开只重建控件显示，显示值一律取当前 flags（`syncSwitches` 已具备该能力）。若确需为外部改动重载，必须 `announce("applecos:flags", ...)` 并把 devMode 交给 `devMode` 状态机（`main.ts:1570-1576`），而不是直接改数组。

### P2-7 四个工具开关不落盘，重启后全部恢复为「开」

- 位置：`src/settings.ts:435-449`（`featuresFromFlags`，446 行把四个布尔压成一个 tools）、`452-474`（`adoptConfig` 不回填 tools）、98 行（`DEFAULT_FLAGS.tools` 全 true）；`src/main.ts:320-329`（`mountedTools` 依赖 flags.tools.*）
- 严重度：P2（设置项形同虚设）
- 状态：代码确认

Features 只有一个 `tools: boolean`，写盘时取四者的 OR；`adoptConfig` 恢复时既没有 tools 子字段可读，也没从 tools 反推四个子开关。结果：关掉「骰子」「场景查询」「世界书检索」→ 保存 → 重启 → `mergeFlags` 用 `DEFAULT_FLAGS` 填回 `{dice:true,time:true,scene:true,lore:true}` → 四个工具重新挂载，界面显示为「开」，玩家以为工具已禁用。

**修复**：在 Features 增加四个独立字段（Go 侧结构体需同步，属跨层改动），或在 UI 侧用允许的首屏镜像恢复子开关（主题已有先例）。不要再用 OR 压缩。

### P2-8 场次切换未串行化，快速连点会并发写 handle/transcript/activeId

- 位置：`src/main.ts:884-889`（`switchSession`）、`846-882`（`openSession`）；对照 `1228-1257` 的 `switchingWorld` 已有互斥
- 严重度：P2（状态串场）
- 状态：并发窗口代码确认；错乱的具体形态待运行验证

`switchSession` 只判 `id === activeId`，没有 switching 标志；`openSession` 内部有多次 await（`store.loadSession`、`rebuildAgent`、`refreshSessions`）。第一次未完成时点第二个场次，两次调用会交错：后一次先写 `commitSession(next)` 与 `activeId`，前一次随后继续写 `transcript` 并 `renderTranscript`、`rebuildAgent`，最终 `handle` 与界面可能分属两场。

**修复**：加 switching 标志 + 末次请求队列（做法同 `switchWorld`）；等待期间 `#status` 显示「切换中」、场次行设 `aria-busy="true"`。

### P2-9 从侧栏 cast 卡点开角色编辑器时，缓存未命中会静默退化成列表

- 位置：`src/settings.ts:1703-1721`（`openEditor`）、`1642-1650`（`renderEditorIfOpen`）、`2005-2010`（`openEditorForm` 的回落）
- 严重度：P2（点击目标丢失）
- 状态：代码确认

`castCard` 的点击（`settings.ts:956-960`）把 `member.id` 传给 `openEditor("character", id)`。`openEditor` 先 `openEditorForm(kind, id)`，若 `findEntry` 未命中（启动后 `refreshLibrary` 未跑完、或切换世界后 `library.character` 为空）就 `openEditorList`；随后才在函数末尾 `if (library[kind].length === 0) void refreshLibrary()`。于是玩家点某个具体角色，看到的是「还没有角色」的空列表，刷新完成后列表出现，但**目标卡没有打开**。冷启动点「世界设定」同样落到列表。

**修复**：`openEditor` 改 async，先 `if (!library[kind].some(e => e.id === id)) await refreshLibrary()` 再决定开表单还是列表；加载中显示「正在读取资料库…」占位，不要把「还没加载」显示成「没有数据」。

### P2-10 工具调用在重放时渲染两次，顺序也与实时不同

- 位置：`src/ui.ts:363-384`（`render` 的 assistant 分支与 toolResult 分支）
- 严重度：P2（重开会话后的台本与实时不一致，结果被当参数解析）
- 状态：代码确认

`render()` 对一条 assistant 消息先 `replayAssistant(text)` 渲染正文，再遍历 content 里的 `toolCall` 块各画一个 `tool(name, args, "done")` 气泡；紧随其后的 `toolResult` 消息又被画成**第二个**气泡（`ui.ts:380-384`，把结果文本当 args 传入）。N 次工具调用在重放后出现 2N 个气泡，顺序变成「正文 → 全部调用 → 全部结果」，实时流则是「正文 → 调用气泡内完成」。`messageText` 对 toolResult 返回纯文本，`parseToolArgs` 必然失败，气泡走 `toolNarrativeLine(key, 结果文本)` 这条为「存下来的结果行」准备的分支，读起来像参数而非结论。

**修复**：重放时按 `toolCallId` 合并——先收集 assistant 消息的 toolCall，遇到 toolResult 时更新对应 `ToolHandle`（`handle.update("done"|"error", resultText)`），不为结果单独建卡；倒流后残留的孤立结果才单独成一条 notice。

### P2-11 世界书「试算」取的是 Sessions.list()[0]，不是当前场次

- 位置：`src/lorebook-ui.ts:1560-1588`（`loadPreviewInput`）
- 严重度：P2（结论误导，玩家据此调参）
- 状态：代码确认

```ts
const list = await Sessions.list();
const first = list[0];
```

`Sessions.list()` 是全部世界、全部场次的列表，`[0]` 的顺序由宿主决定。管理器没有拿到当前场次的通道（`LorebookManagerOptions` 里没有 session 字段），试算可能跑在另一个世界/另一场戏的转录上，「检索 N 条消息 / 结果：未命中」与玩家眼前这场无关。

**修复**：`mountLorebookManager` 增加 `currentSession?: () => string` 选项，由 `settings.ts:1677-1682` 从运行时取 `activeId` 传入；取不到时报告首行明确写「当前无场次，试算基于最近一场」，不要静默取 [0]。

### P3-1 三个对话框没有可访问名，设置导航不使用选中语义

- 位置：`index.html:389`（#settings）、816（#editor）、863（#worlds）；`src/settings.ts:660-676`（`showPane`）
- 说明：三个 `<dialog>` 均无 `aria-labelledby`，读屏器只报「对话框」。`showPane` 只切 `.selected` 类，`.nav-item` 没有 `aria-current`/`aria-selected`，右侧 pane 也没有 `aria-labelledby`。
- 修复：#settings 用 `aria-labelledby="pane-title"`，#editor 用 `aria-labelledby="editor-title"`，#worlds 用 `aria-labelledby="worlds-title"`；导航改成 role=tablist + role=tab aria-selected（或至少 aria-current="page"）。

### P3-2 开场引导对读屏器永久隐藏

- 位置：`index.html:66` `<div id="empty" ... aria-hidden="true">`
- 说明：`data-visible` 只控制视觉，`aria-hidden` 恒为 true，全应用唯一的「回车就开演」引导对辅助技术不可见。
- 修复：去掉静态 aria-hidden，由 `setEmpty()`（`ui.ts:427-429`）同时维护它。

### P3-3 in 判断走原型链，非法主题/图标名会取到函数值

- 位置：`src/theme.ts:120-125`（`if (value in LEGACY)`）、`src/icons.ts:87-91`（`name in ICONS`）
- 说明：`LEGACY["constructor"]` 命中 `Object.prototype`，`normalizeChoice` 会返回函数，`resolvePalette` 再把它当 palette，最终落到 `THEMES[0]`；`mountIcons` 会把函数源码写进 innerHTML。当前触发源只有本地 localStorage 与自带 HTML，风险低，但两处都该改用 `Object.hasOwn`。
- 修复：`Object.hasOwn(LEGACY, value)` / `Object.hasOwn(ICONS, name)`。

### P3-4 世界书条目详情改一个复选框就重建整个表单，焦点丢失

- 位置：`src/lorebook-ui.ts:942-959`（`updateEntry` 的 refreshDetail 参数）、`1256-1260`、1317、1324-1326、1357、1424、1447-1466
- 说明：所有 `refreshDetail = true` 的提交都会 `renderDetail()` → `detailHost.replaceChildren()`，刚被操作的控件连同焦点一起销毁，焦点回到 body；纯键盘改十个参数要重新 Tab 十次。`renderBulk()` 同样每次重建整条批量栏（1036-1059），在互斥组输入框里打字被打断时焦点也会丢。
- 修复：勾选/下拉只就地更新对应节点与「本条效果」摘要（`refreshSummary` 已有），整表重建限制在「切换条目」时；批量栏复用节点，只更新 disabled 与计数。

### P3-5 nocturne 主题 hover 态按钮文字对比度不足

- 位置：`src/style.css:1366-1368`（`--accent-fill-hover: #7a74d9`、`--on-accent: #ffffff`）、599-601、638-641、3704-3706
- 说明：静态态白字在 `#6d67ce` 上是 4.69:1（合格），hover 变亮到 `#7a74d9` 后降到 **3.94:1**，低于正文 4.5:1 要求（按钮字号 0.73–0.82rem）。其余七个主题该组合均 ≥5.4。另有 `--muted` 在 `--surface-2` 上 4.33:1（nocturne）。
- 修复：nocturne 的 `--accent-fill-hover` 改为变暗（如 #6058c2），或 hover 只改阴影；surface-2 上的次要文字改用 `--text-dim`。

### P3-6 工具结果行可能横向溢出

- 位置：`src/style.css:4313-4317`（`.tool-result`）
- 说明：`white-space: pre-wrap` 但没有 `overflow-wrap: anywhere`，模型返回无空格长串（URL、base64、长 JSON 键）时撑开气泡；`.script` 只有 `overflow-y: auto`，横向溢出被裁掉且无法滚动。
- 修复：补 `overflow-wrap: anywhere`（与 `.tool-args`、`.speech` 一致）。

### P3-7 时钟面板只能再点按钮关闭

- 位置：`src/settings.ts:2665-2680`
- 说明：#clock-panel 只有 #world-clock 切换与点四个快捷项两条关闭路径，没有 Escape、没有点击外部关闭，也不归还焦点。用量面板在 2703-2712 已有 Esc + pointerdown 的完整处理。
- 修复：照搬用量面板的两条监听，关闭时 `clockButton.focus()`。

### P3-8 窄窗口下默认「抽屉 + 遮罩」盖住舞台

- 位置：`index.html:42`（`data-rail="open"` 硬编码）、`src/style.css:3774-3819`
- 说明：`max-width: 720px` 时侧栏变 fixed 抽屉且 `.rail-scrim` 在 `[data-rail="open"]` 下显示；应用启动即 open，窄窗口首屏被 88vw 抽屉加全屏遮罩挡住，要先手动收起。被遮住的舞台也没有 `inert`/`aria-hidden`，键盘与读屏器仍会走进看不见的区域。
- 修复：启动时按 `matchMedia("(max-width: 720px)").matches` 初始化 data-rail；抽屉打开时给 `.stage` 设 inert，关闭时移除。

### P3-9 首屏 flag 镜像读取一个从未写入的键

- 位置：`index.html:27`（`JSON.parse(localStorage.getItem("applecos.flags") || "{}")`）
- 说明：全仓库没有任何 `localStorage.setItem("applecos.flags", ...)`（`settings.ts:46` 明确写了不写业务数据到 localStorage）。这段预置脚本永远读到 {}，flagScript/flagWorld/flagClock/flagMotion/flagDev 的首屏值与真实设置无关：关掉「世界状态面板」或「台本排版」的玩家每次启动都会看到一次布局回弹。
- 修复：要么在 `persistFlags` 里同步写这个镜像（只放纯展示 flag，符合 AGENTS.md 的首屏镜像例外），要么删掉这几行避免误导。

### P3-10 静态占位与重复实现

- `index.html:580` 的 `#player-count` 永远是 1，`refreshLibraryCounts`（`settings.ts:2271-2282`）不更新它；`#worlds-title`（`index.html:867`）恒为「世界」，`renderWorldList` 不更新。
- `setRail` 在 `main.ts:1686-1690` 与 `settings.ts:2594-2602` 各实现一次，改一处容易漂移。
- `main.ts:397` 的 `speaker: VOICE`（「旁白」）对 `replayAssistant` 无效（`ui.ts:432-438` 完全不用 speaker），属已失效接线，建议删除或真正接入。

## 四、跨层接口风险

1. **确认队列 ↔ 确认卡片（P1-1 的根因）**：`applecos:tool-approve / tool-deny` 是无载荷的全局事件，队列靠「当前请求」而非 id 应答，卡片生命周期也不与队列状态绑定。修复必须同时改 `ui.ts`（带 id 派发）、`main.ts`（按 id 应答 + subscribe 收尸）；`consent.ts` 的 `answer(id)` 已够用，无需改逻辑。这是本项目唯一「安全语义横跨三层」的接缝。
2. **flags 的双写（P2-6 / P2-7）**：flags（界面内存）→ Features（Go 配置）→ 磁盘 → `adoptConfig` 回灌 flags。中间被 OR 压缩（tools）与 300 ms 防抖窗口切掉信息，回灌又是静默的，同一次修改可能在 UI、运行时、磁盘三处取三种值。建议把 Flags 定为运行时唯一权威，磁盘只做持久化，`openSettings` 不得回灌。
3. **`applecos:world` 的双向使用**：`persistWorld()`（`settings.ts:977`）也会派发同名事件，只是 `main.ts` 不监听，目前不成环；一旦有人给 main 加上该监听立刻变成回环。建议拆成 `applecos:world-state`（runtime → UI）与 `applecos:world-edit`（UI → runtime）。
4. **ChatView ↔ 转录重放（P2-10）**：界面层独自决定「toolCall 块开卡、toolResult 消息再开卡」，而实时路径由 `main.ts` 用 `toolCallId` 配对。两条路径的产物必须一致，否则同一场戏刷新前后长得不一样。
5. **世界书管理器的会话上下文缺失（P2-11）**：管理器只能通过 `Sessions.list()` 间接摸对话，属 UI 层缺少必要的只读通道，不是管理器算错。
6. **破坏性动作的界面把关不统一**：已有四种强度——`requestDelete` 二次点击（`settings.ts:1832-1847`）、`startDelete` 行内确认（1154-1182）、`requestQuit` 确认框（2604-2612），以及完全无确认的玩家改名（P1-2）与合并导入删源（P2-3）。建议收敛到一个 `confirmDanger()`，让 `flags.confirm` 只有一处判定。

## 五、修复顺序

1. **先止血安全面**：P1-1（确认卡片身份绑定）→ P1-2（玩家改名确认）。
2. **止血数据丢失**：P2-2（编辑器未保存守卫）→ P2-3（合并导入删除时机）。
3. **日常可用性**：P2-1（输入法回车）→ P2-8（场次切换互斥）→ P2-9（编辑器缓存竞态）。
4. **状态一致性收敛**：P2-6（设置回灌）→ P2-7（工具开关落盘，需 Go 侧配合）。
5. **台本一致性**：P2-10（重放去重）→ P2-11（试算场次）。
6. **可访问性与版面**：P2-4、P2-5，然后 P3 全部（P3-9 可先删掉死代码）。

同一提交只做一件事；P2-6 / P2-7 涉及 Features 结构变化时必须与 Go 侧同步并单独提交。

## 六、供修复代理执行的清单

| # | 文件 | 动作 | 验收标准 |
| --- | --- | --- | --- |
| 1 | `src/ui.ts`, `src/main.ts` | ConfirmOptions 增 requestId；settle 派发 `{id, decision}`；bindConsent 用 `consent.allow/deny(detail.id)` 并订阅 `consent.subscribe` 给卡片收尸 | 连续制造两条神力删除并让第一条超时，点旧卡「批准」：第二条**不**执行，旧卡显示「已超时」且按钮 disabled |
| 2 | `src/main.ts`, `src/settings.ts` | 玩家改名检测前移到保存流程，弹确认并受 flags.confirm 控制；提示文案改为真实后果 | 改名字保存时出现确认；取消则名字、world.relations、overlay 全不变；确认后旧身份卡存在且关系按现有逻辑清零 |
| 3 | `src/main.ts` | #input 的 keydown 加 isComposing / 229 早退（#session-rename 同样处理） | 拼音输入「你好」在候选未上屏时按回车不发送、候选正常上屏；上屏后再回车才发送 |
| 4 | `src/settings.ts`, `src/lorebook-ui.ts` | 新增 requestCloseEditor()，统一 close/back/backdrop/cancel，用 loreManager.isDirty() 与表单比对触发三选一确认 | 改两条世界书条目后按 Esc 出现确认；选「取消」留在编辑器且改动还在；选「放弃」才丢弃 |
| 5 | `src/lorebook-ui.ts` | mergeImport 的 deleteLibraryEntry 移到 save() 成功之后，或改为保存后提示删除 | 合并导入后直接关闭编辑器：源书仍在书架，条目未丢 |
| 6 | `src/settings.ts`, `src/style.css` | 场次行去嵌套按钮，改兄弟结构；工具条用 opacity/focus-within 保证可 Tab | 键盘能从场次标题 Tab 到重命名/删除；`document.querySelectorAll("button button").length === 0`；读屏报出两个独立按钮名 |
| 7 | `index.html`, `src/ui.ts` | #chat 改 role=log，新增隐藏的 #sr-announcer aria-live=polite，只在块落地时写整句；预览块 aria-hidden | 开启打字机发一条长回复：读屏器在回复落地后朗读一次完整内容，工具气泡只播报「完成/失败」 |
| 8 | `src/settings.ts` | openSettings 不再回灌 flags；显示值取当前 flags。若保留重载路径必须 announce("applecos:flags") 并走 devMode 状态机 | 关掉「世界书触发」后 200 ms 内重开设置：开关仍显示关闭，运行时行为与显示一致，随后保存不写回旧值 |
| 9 | `src/settings.ts`（+ Go Config/Features） | 四个工具子开关独立持久化（或用允许的首屏镜像恢复）；adoptConfig 回填 flags.tools | 关掉骰子与世界书检索 → 重启 → 两项仍为关，`mountedTools()` 不含 roll/recall |
| 10 | `src/main.ts` | switchSession 加互斥 + 末次请求队列，等待期间 aria-busy 与状态文案 | 快速连点三个场次：最终打开最后点击那个，activeId、转录、模型句柄三者一致 |
| 11 | `src/settings.ts` | openEditor 在缓存未命中时先 await refreshLibrary() 再决定表单/列表；加载中显示占位 | 冷启动后立刻点侧栏某个 cast 卡：直接打开该角色表单，不出现空列表 |
| 12 | `src/ui.ts` | 重放按 toolCallId 配对，toolResult 更新既有卡片；孤立结果单独成条 | 重开一场含 2 次工具调用的戏：气泡数量与顺序与实时一致（2 个），结果在卡片内 |
| 13 | `src/lorebook-ui.ts`, `src/settings.ts` | 世界书管理器接收当前场次 id | 两个世界各有场次时，在 A 世界的世界书里点「试算」：消息数来自 A 的当前场次，不是列表首项 |
| 14 | `index.html`, `src/settings.ts` | 三个 dialog 补 aria-labelledby；导航补 aria-selected/aria-current；#empty 的 aria-hidden 随可见性变化 | 读屏器打开任一对话框时报出名称；开场空态可被朗读 |
| 15 | `src/theme.ts`, `src/icons.ts` | in 判断改 Object.hasOwn | 把 localStorage 主题写成 constructor 后刷新：主题回落 THEMES[0]，dataset.themeChoice 为合法值，控制台无异常 |
| 16 | `src/lorebook-ui.ts` | 勾选/下拉就地更新，不重建 detail；批量栏复用节点 | 键盘在「高级」里连续 Tab 勾选四个复选框焦点不丢；连续操作后条目参数与界面一致 |
| 17 | `src/style.css` | nocturne --accent-fill-hover 改暗；.tool-result 补 overflow-wrap: anywhere | 计算对比度 ≥4.5:1；工具结果含 200 字无空格长串时气泡不横向溢出 |
| 18 | `src/settings.ts`, `src/style.css` | 时钟面板补 Esc 与外部点击关闭 + 焦点归还；窄窗口按宽度初始化 data-rail，抽屉打开时 .stage 设 inert | Esc 关闭面板且焦点回按钮；窗口缩到 600px 启动时舞台未被遮罩挡住 |
| 19 | `index.html`, `src/settings.ts` | applecos.flags 镜像要么在 persistFlags 写入，要么删掉；#player-count / #worlds-title / 重复 setRail 一并收口 | 关掉「台本排版」重启应用首屏不再出现排版回弹；重复实现只剩一处 |

## 七、未执行与需人工确认

- 未启动开发服务器或打包应用。流式、读屏、输入法相关结论按代码推断（P1-1 的误批准链、P2-1 的输入法行为、P2-8 的并发错乱形态建议在应用里各手工点一次）。
- 未验证 Go 侧 Features 是否还有其它可扩展字段；P2-7 的最终修法取决于该结构能否扩展。
- 未检查 `src/world/` 引擎对 UI 传入数据的语义处理（例如 flags.tools 关闭后提示词是否同步增删），属其它专项范围。
