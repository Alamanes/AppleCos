# AppleCos Go 后端对抗性审查报告

审查对象：AppleCos 宿主进程（Go 侧）。审查范围已按主控指令收缩为「Go 后端 + 与外部输入、本地文件系统、导入解析、持久化相关的边界」，接驳层、前端内核与界面三层由其他审查员负责，本报告不重复展开，仅在证据链需要时引用前端调用点作为佐证。

审查日期：2026-11-17
审查性质：只读审查。未修改任何既有源码，未改动 `RES/`，未提交 Git，未安装依赖，未执行破坏性命令。

---

## 一、审查范围与方法

### 1.1 覆盖文件（全部逐行通读）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `main.go` | 275 | 进程入口、配置读写、窗口与 Shell 绑定、fetch 插件挂载、IPC 注册 |
| `store.go` | 216 | 数据目录、ID 校验、原子写入、限长读取、JSON 校验、回收站 |
| `library.go` | 565 | 世界 / 角色卡 / 世界书的增删改查与导入导出 |
| `cards.go` | 353 | 角色卡 JSON / PNG / CHARX 解析与 V3 归一化 |
| `sessions.go` | 286 | 会话列表、状态、转录追加与重写、删除 |
| `src/mygo.ts` | 308 | 生成的客户端（只读，用于确认 Go 方法对外暴露面与参数契约） |

### 1.2 方法

1. 先确定 Go 方法对外暴露面：`mygo.Bind(Settings{}, Library{}, Sessions{}, Shell{})`（`main.go:255`），因此上述四个类型的**每一个导出方法**都是页面可调用的 IPC 入口，全部纳入攻击面。
2. 对每个入口做「参数来源 → 校验 → 落点」三段追踪，判定它能否被页面传入的字符串导向应用数据目录之外，或导向内容与大小不受约束的写入。
3. 对文件写入逐个核对：是否原子、是否 fsync、权限位是否在既存文件上生效、并发调用时是否有串行化。
4. 对导入解析（JSON / PNG tEXt / CHARX zip）逐个核对边界：长度字段、偏移推进、解压上限、解码后大小、归一化后大小。
5. 对持久化一致性核对：会话状态与转录两个文件的写入顺序、失败处理、读取失败时的降级行为、上限与调用方实际载荷是否匹配。
6. 计时验证只在代码层面完成（静态追踪 + 复杂度估算）。凡需要实际运行才能确认量级的，均标注「需运行验证」。

### 1.3 未做的事

未运行 `go build`/`go vet`、未构造恶意样本、未对运行中的应用发起 IPC 调用。报告中「已由代码确认」指该行为可由所引行号直接推出；「需运行验证」指结论成立但触发量级或实机表现待实测。

---

## 二、总体结论

后端整体在两方面做得扎实：**路径穿越防线**与**导入解析的边界检查**基本没有可击穿之处（见第五节「已审查未发现高severity的路径」）。ID 校验正则、PNG 分块偏移校验、zip 解压上限、限长读取都写得比常见实现更严。

问题集中在另一类：**信任边界的定位**。Go 侧把「页面」当成可信调用方，于是把带任意路径参数的读写能力直接挂到了 IPC 上；同时在持久化侧，上限常量与调用方实际写入的载荷结构并不匹配，失败路径又大量采用静默降级，导致一旦越界就不是「报错」而是「静默丢数据」。

共 15 项发现：**P1 一项、P2 七项、P3 七项**。

最需要在修复阶段优先处理的是 B1（任意路径读写）、B2（会话状态 8MB 上限与页面载荷不匹配导致的永久不可保存）、B4（追加与整写交错导致的静默丢消息）。这三项都具备「本地数据在用户不知情的情况下损坏」的性质，而本项目的核心资产就是本地剧情数据。

---

## 三、详细发现（按严重度排列）

### B1 · P1 · 带任意路径参数的读写方法直接暴露在 IPC 上，绕过数据目录边界

**位置**

- `library.go:394-413` `ExportCardTo(id, path)`（写入）
- `library.go:335-362` `ImportCardFile(path)`（读取）
- `library.go:128-162` `ImportLorebookFile(path)`（读取）
- 暴露面证据：`src/mygo.ts:168`、`src/mygo.ts:193`、`src/mygo.ts:204`

**代码依据**

```go
// library.go:394
func (Library) ExportCardTo(id string, path string) (string, error) {
	raw, err := loadArtifact(cardKind, id)
	...
	target := strings.TrimSpace(path)
	if target == "" {
		return "", errors.New("没有指定保存位置")
	}
	if !strings.HasSuffix(strings.ToLower(target), ".json") {
		target += ".json"
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(target, []byte(raw), 0o644); err != nil {
```

`path` 来自页面，没有任何规范化、白名单或「必须位于哪个目录」的检查，且会先 `MkdirAll` 建出整条父目录链。写入内容是 `SaveCard` 归一化后的角色卡 JSON —— 而 `SaveCard`（`library.go:52-87`）只要求顶层是合法 JSON 对象，字段内容不受限，模型经由 `revise_character`/`create_character`（`src/tools.ts` 中 `ctx.library.saveCard`）写入的文本原样落在其中。

**攻击 / 失败场景**

1. 页面上下文被控（未来的一处 DOM 注入、第三方依赖、调试端口、或被诱导执行的脚本），即可 `Library.exportCardTo("card-abc123", "/Users/<user>/.zshrc")`：`MkdirAll` 无声无息、`WriteFile` 直接覆盖，后缀补 `.json` 也只影响文件名而不阻止覆盖既有文件（前置判断是「不以 .json 结尾才补」，已存在的 `.zshrc` 会被写成 `.zshrc.json`，而目标若本就以 `.json` 结尾则被原地覆盖，例如各类工具配置文件、`auth.json`）。
2. 读取侧对称：`importLorebookFile("任意 JSON 文件路径")` 会把该文件当作世界书存进资料库，随后 `loadLorebook(id)` 将原文完整返回给页面。应用自身的数据目录内就有多个 JSON 对象文件（`config.json` 含 API key、`library/*/*.json`），因此这是一条「把宿主进程可读的任意 JSON 对象搬运给页面」的通道；同时 `os.Stat` 与解析错误信息（`导入失败：…`、`需要一个 JSON 对象`、`文件过大：N 字节`）可用于探测文件是否存在与其大致大小。
3. 该能力对模型的直接可达性为零（模型没有 IPC 工具），但对**页面内任意脚本**可达。项目把「页面不直连模型服务、网络出口在 Go」当作安全设计的一部分（`AGENTS.md`「技术决策/网络出口」），那么文件出口同样应当收敛在 Go。

**修复建议**

- 两个「无对话框」变体改为**不接收绝对路径**：只接收资源 ID 或受限的相对路径，由 Go 侧拼接到固定根目录（`App.Path(PathUserData)` 下的 `exports/` 之类），并用 `filepath.Clean` + `filepath.Rel` 断言结果仍在根内（拒绝 `..`、拒绝绝对路径、拒绝跨卷）。
- 若确需覆盖用户任意位置，只能走 `mygo.Dialog.Save` 让用户亲手选点（现有 `ExportCard` 已经这么做），`ExportCardTo` 应删除或降为内部函数。
- 读取侧同理：`ImportCardFile` 只接受相对名或改由 Open 对话框取得。
- 写入前对目标做「已存在则要求确认」或强制换名，避免静默覆盖。

**验收标准**

- 任意页面脚本调用 `Library.exportCardTo` 都无法把内容写到 `PathUserData` 之外；传入 `../`、绝对路径、`~` 前缀一律返回错误而非创建目录。
- `Library.importCardFile`/`importLorebookFile` 无法读取数据目录外的文件。

---

### B2 · P2 · `session.json` 的 8MB 上限与调用方实际写入的载荷结构不匹配，越界后会话永久无法保存

**位置**

- 上限定义：`store.go:28-34`（`maxArtifactBytes = 8 << 20`）
- 强制点：`sessions.go:132-145`（`SaveState` 走 `decodeJSONObject(raw, maxArtifactBytes)`）
- 读取侧同限：`sessions.go:106`、`sessions.go:235`
- 载荷结构证据（跨层引用，仅作证）：`src/world/store.ts:157-167` 把整个 `SessionState` 展开写进 `session.json`，其中 `messages` 是全量文本投影，`turns` 是最近 50 个快照且每个快照内嵌整份 `memory.facts`（`src/world/session.ts:283-301`、`pruneSnapshots(…, 50)` 在 `src/main.ts:774`）

**代码依据**

```go
// sessions.go:132
func (Sessions) SaveState(id string, raw string) (SessionSummary, error) {
	clean, err := decodeJSONObject(raw, maxArtifactBytes)
	if err != nil {
		return SessionSummary{}, err
	}
```
```go
// store.go:139
func decodeJSONObject(raw string, max int) ([]byte, error) {
	...
	if len(trimmed) > max {
		return nil, fmt.Errorf("JSON 太大：%d 字节，上限 %d", len(trimmed), max)
	}
```

**失败场景**

`session.json` 的体量随「轮数 × 单条消息长度」（文本被完整复制一份）+「快照数 × 记忆条数 × 单条记忆长度」增长。记忆条数没有上限（`remember` 工具只按轮次限制调用次数，不限制累计总量；单条上限 400 字）。以 50 个快照、每快照 400 条记忆、每条 450 字节估算，仅快照段就接近 9MB，已越过 8MB 硬顶。越过后：

1. `SaveState` 每次返回错误，页面侧 `saveStateNow` 只弹一行「保存会话失败」；
2. 会话仍在内存里继续推进，后续每一轮都失败，且**没有任何机制能把已存文件缩小**（因为不能写入）；
3. `Load` 用的 `readLimited(statePath, maxArtifactBytes)` 同样以 8MB 为界，一旦文件真的超过（例如未来放宽写入侧或手工放置），该会话直接打不开，报「文件过大」，而列表里它仍然存在（`List` 走 `loadSessionSummary`，同样读状态文件，会跳过它，表现为会话从侧栏消失但目录仍在）。

净效果是「用户以为在存档，实际从某一点起全部没落盘」，而界面只有一个瞬时提示。这是本报告中最典型的静默数据损失。

**修复建议**

- 二选一并写进文档：把会话状态上限提高到与转录上限同量级（并让读取侧同值），或让状态文件只存**增量**——快照只存 `messageIds` 与 `memory` 的**差异**，`messages` 投影不再整体复制进 `session.json`（这与 `AGENTS.md` 里「转录与状态分开存」的设计意图一致，当前实现其实违背了它）。
- 无论如何，上限必须与调用方契约一致，并在超限时给出**可执行**的错误（例如提示「本条会话状态过大，已停止保存」而不是笼统失败）。
- `List`/`Load` 遇到超限文件应返回明确错误，让界面把它显示成「损坏/过大」而不是消失。

**验收标准**

- 构造一份超过上限的会话状态，界面能给出明确且可操作的错误，且不会静默丢弃后续轮次。
- 长会话（≥ 300 轮、≥ 300 条记忆）运行 50 轮后 `session.json` 体积保持在同一数量级（不随快照数线性叠加）。

---

### B3 · P2 · 转录读取失败被静默吞掉，摘要计数与内容可能互相矛盾

**位置**：`sessions.go:117-127`（`Load`）、`sessions.go:252-262`（`loadSessionSummary`）

**代码依据**

```go
// sessions.go:117
messages := make([]string, 0, summary.Messages)
if messagePath, pathErr := sessionMessagesPath(id); pathErr == nil {
	if data, readErr := readLimited(messagePath, maxSessionBytes); readErr == nil {
		for _, line := range strings.Split(string(data), string(newline)) {
			...
		}
	}
}
```

`readErr` 非空（超过 64MB、权限错误、磁盘错误）时函数直接返回成功，`Messages` 为空数组。`summary.Messages` 却来自另一条路径（`countMessageLines`），此时两者必然矛盾：摘要说「本场 812 条」，实际返回 0 条。

**失败场景**

转录文件被外部工具截断/改坏、或成长到 64MB 以上时，界面得到一个「空转录但计数正常」的会话。用户接着编辑或触发 `ReplaceMessages`（重写/倒流），全量重写会把磁盘上原本还在的转录真正覆盖成空——静默丢弃在此升级为永久丢弃。

**修复建议**

- `Load` 读转录失败时返回错误（或返回 `(SessionData, error)` 并在错误里说明是哪一半失败），不返回半成品。
- 提供独立的「转录读取失败」状态，界面据此禁止对该会话执行任何写操作。

**验收标准**

- 把 `messages.jsonl` 改成不可读或超限，`Sessions.Load` 返回错误而不是空消息列表；界面不会出现「计数非零、内容为空」。

---

### B4 · P2 · 追加写入与整文件重写之间没有串行化，交错时静默丢失消息

**位置**

- `sessions.go:148-170`（`AppendMessage`，`O_CREATE|O_WRONLY|O_APPEND`）
- `sessions.go:173-191`（`ReplaceMessages`，经 `writeFileAtomic` 做「临时文件 + rename」）
- `store.go:85-112`（`writeFileAtomic`）
- 触发点（跨层引用）：`src/main.ts:483` 在倒流工具里**不 await** 就发起 `Sessions.replaceMessages`，同一轮后续的 `message_end` 仍会走 `persistMessage` → `AppendMessage`

**代码依据**

```go
// sessions.go:160
path := filepath.Join(dir, "messages.jsonl")
file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, filePerm)
...
if _, err := file.Write(append(clean, newline)); err != nil {
```

`O_APPEND` 绑定的是**打开时的那个 inode**；`ReplaceMessages` 通过 `os.Rename` 把路径换成新 inode。两者并发时，落在旧 inode 上的追加内容随旧 inode 被回收而消失，且**两个调用都会返回成功**。

**失败场景**

开发者模式下触发 `rewind`：宿主改写转录的同时，本轮尚未结束的助手消息/工具结果继续走追加。如果追加的 `OpenFile` 发生在 rename 之前、`Write` 发生在 rename 之后，这些消息只存在于进程内存，进程退出后彻底消失；而本轮追加在 `session.json` 里的文本投影仍在，导致「状态有这段、转录没有」的错位。同样的 last-writer-wins 问题存在于 `SaveWorld`/`SaveState` 的并发调用（页面有多处并发保存链，例如 `applyAffinityEdit` 同时触发 `saveWorldNow` 与 `saveStateNow`）。

**修复建议**

- 在 Go 侧按文件加锁：以「目录 + 文件名」为键的 `sync.Mutex`（或单写者 goroutine + channel），`AppendMessage` 与 `ReplaceMessages` 共享同一把锁，保证「追加」与「替换」互斥。
- 或者让 `ReplaceMessages` 也走「追加 + 截断」而非 rename，使两者作用于同一 inode。
- 附带修掉调用点：倒流路径应 `await` 完成 `ReplaceMessages` 后再继续本轮。

**验收标准**

- 并发压测（同一会话同时 append 与 replace）后，转录行数等于「replace 基准 + 之后 append 的条数」，无丢失。
- 倒流后等待一次 `agent_end`，磁盘转录与内存转录逐行一致。

---

### B5 · P2 · 角色卡归一化结果没有大小上限，导入后可生成无法再读回的条目

**位置**

- 输入上限：`library.go:343`（`readLimited(path, maxImportBytes)`，64MB）
- 归一化：`cards.go:36-72`（`normalizeCard` → `json.MarshalIndent`）
- 落盘：`library.go:356`（`writeFileAtomic(dest, normalized, filePerm)`）——**未复用 `maxArtifactBytes` 校验**
- 读取侧上限：`library.go:170`、`library.go:521`、`library.go:457`（均按 `maxArtifactBytes` = 8MB）

**代码依据**

`SaveCard`（`library.go:66-74`）在归一化前做了 `decodeJSONObject(raw, maxArtifactBytes)`，但 `ImportCardFile`（`library.go:335-362`）只做 `readLimited(path, maxImportBytes)` 就交给 `normalizeCard`，产出物直接写盘。PNG 路径下 `pngCardJSON` → `decodeBase64Text`（`cards.go:179-200`）最多解出约 48MB 明文，`json.Unmarshal` 进 `map[string]any` 再 `MarshalIndent` 会带来数倍内存放大。

**失败场景**

1. 放入一张携带 40MB 卡数据的 PNG：进程瞬时内存可达数百 MB（单进程桌面应用的主要内存来源是 WebView 与模型上下文，这里额外吃一大块）；
2. 归一化结果 >8MB 被写进资料库后，`listArtifacts` 因 `readLimited` 失败而无法读取摘要（`library.go:457` 的 `if ... readLimited(...); err == nil` 分支跳过），列表里该卡名字退化为 id；
3. `LoadCard` 直接返回「文件过大」，这张卡从此打不开、删不掉（删除可用，但用户不知道它是哪张）。

**修复建议**

- `normalizeCard` 返回前校验 `len(out) <= maxArtifactBytes`，超限返回明确错误（「角色卡数据过大：N 字节，上限 8MB」）。
- 对 PNG/CHARX 的 base64 解码也设上限（解码前先按 4/3 估算明文大小）。
- 让列表侧对超限文件显示为「过大/损坏」而不是名字退化。

**验收标准**

- 导入一张旨在产出 >8MB 卡数据的 PNG/CHARX，返回明确错误且不在资料库留下文件。
- 任意合法导入的卡都能被 `ListCards` 正确命名并被 `LoadCard` 打开。

---

### B6 · P2 · 配置文件非原子写入，失败读取被静默替换为默认值

**位置**

- `main.go:147-163`（`Save`：`os.MkdirAll` + `os.WriteFile`）
- `main.go:118-145`（`Load`：读取失败返回 error，调用方回落默认值）
- 回落证据（跨层引用）：`src/main.ts:1817-1821` `catch { config = defaultConfig(); }`

**代码依据**

```go
// main.go:159
if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
	return err
}
return os.WriteFile(path, data, 0o600)
```

三个问题同源：

1. **非原子**：`os.WriteFile` 直接截断原文件再写。写入过程中进程被杀、磁盘满、掉电，都会留下半截 JSON；`Load` 随后 `json.Unmarshal` 失败，页面把整个配置换成默认值——用户的接口地址、模型名、**提示词、全部开关与 API key 一次性消失**，且 `config.json` 已被覆盖成默认内容（下一次 `Save` 时），原始值不可恢复。
2. **权限不收敛**：`0o600` 只在 `O_CREATE` 时生效；文件已存在（例如旧版本或用户手工创建为 0644）时继续保留宽权限，而这里存的是 API key。
3. **目录权限不收敛**：`MkdirAll(0o700)` 对已存在的目录不改权限。

值得肯定的是同文件的 `writeFileAtomic`（`store.go:85-112`）已经实现了正确的「临时文件 + Chmod + Sync + Rename」流程，配置写入却没有复用。

**修复建议**

- `Settings.Save` 改用 `writeFileAtomic(path, data, 0o600)`。
- 写入后（或加载时）`os.Chmod(path, 0o600)` 强制收敛，目录同理校验。
- `Load` 遇到解析失败时先改名保留为 `config.json.corrupt-<时间戳>` 再回落默认值，并在返回值里带一条警告，让界面告诉用户「配置已损坏，原件已保留」。

**验收标准**

- 写入过程中强制杀进程后，`config.json` 要么是完整旧值、要么是完整新值。
- 已存在 0644 的 `config.json` 在启动一次并保存后变为 0600。
- 损坏的配置会生成保留副本，不会静默消失。

---

### B7 · P2 · 会话 ID 仅 4 位十六进制随机后缀，同秒创建会覆盖既有会话并清空其转录

**位置**：`sessions.go:67-98`（`Create`）

**代码依据**

```go
// sessions.go:69
id := "s-" + time.Now().Format("20060102-150405") + "-" + randomHex(4)
...
// sessions.go:91
if err := writeFileAtomic(filepath.Join(dir, "session.json"), data, filePerm); err != nil {
...
// sessions.go:94
if err := os.WriteFile(filepath.Join(dir, "messages.jsonl"), nil, filePerm); err != nil {
```

同一秒内两次创建若随机后缀相同（65536 分之一），第二次会：覆盖 `session.json`（旧会话状态消失）并用 `O_TRUNC` 清空 `messages.jsonl`（旧转录彻底消失，且不留 Trash 副本，因为它不是删除路径）。没有任何「目标已存在则拒绝」的判断。

**修复建议**

- 生成后 `os.Stat` 检查，冲突则重试；或直接用 `os.Mkdir` 的 `EEXIST` 作为原子占位。
- 随机后缀扩到 `randomHex(8)` 以上，与 `generatedID` 保持一致。

**验收标准**

- 连续创建 1000 个会话不出现覆盖；人为构造同 id 的第二次创建时返回错误且不动既有文件。

---

### B8 · P2 · 列表接口每次全量读取并解析所有文件，IPC 调用被放大为 O(磁盘总字节)

**位置**

- `sessions.go:41-65`（`List`）→ `sessions.go:230-275`（`loadSessionSummary` 内 `readLimited(messagePath, maxSessionBytes)` + `countMessageLines`）
- `library.go:429-469`（`listArtifacts` 对每个 `.json` 都 `readLimited` + `summarizeArtifact` 解析）

**代码依据**

```go
// sessions.go:258
if data, readErr := readLimited(messagePath, maxSessionBytes); readErr == nil {
	count = countMessageLines(data)
}
```

为了得到「消息条数」，每次都把整个转录（上限 64MB）读进内存并逐行切分。`Sessions.List` 遍历全部会话，因此一次列表刷新的成本是**所有会话转录字节数之和**。页面在每轮结束、每次时钟变更、每次重命名后都会刷新列表（`refreshSessions` 在 `finishTurn`/`setClock`/`renameSession` 中调用），成本随使用线性叠加，20 个中等会话就足以让每次刷新读上百 MB。

`listArtifacts` 同理：世界/卡/世界书三个目录每次都被全量解析，而页面在作者工具每次落盘后都触发 `refreshLibrary`。

**修复建议**

- 条数改为增量维护：在 `AppendMessage` 里同步更新一个 `meta.json` 计数（或在 `session.json` 里维护 `messageCount`），`List` 只读小文件。
- `listArtifacts` 加缓存（按 `mtime+size` 失效），或把摘要（name/detail）在写入时一并存进 sidecar。
- 给 `List` 的结果数量与 `listArtifacts` 的目录规模设上限，避免病态目录拖垮调用。

**验收标准**

- 20 个各含 5MB 转录的会话，`Sessions.List` 的读取字节数不再与转录总字节数成正比。
- 单个目录放入 1000 个条目时，列表调用仍在可交互延迟内。

---

### B9 · P3 · `writeFileAtomic` 未 fsync 父目录，崩溃后可能回退到旧版本

**位置**：`store.go:85-112`

`tmp.Sync()` 保证了临时文件内容落盘，`os.Rename` 只保证命名空间的原子性，**目录项本身没有 fsync**。掉电后可能读到「内容完整但重命名丢失」的旧文件（对会话是丢最后一轮，对卡是世界书是丢最后一次编辑）。

**修复建议**：rename 后打开父目录并 `Sync()`（macOS 上 `os.Open(dir)` + `Sync`）。

**验收标准**：模拟掉电（或借助故障注入）后，重命名后写入的内容不丢失。

---

### B10 · P3 · 读取路径会创建目录，删除不存在的会话静默成功

**位置**

- `sessions.go:203-209`（`sessionDir` → `appDir` → `os.MkdirAll`）
- `sessions.go:101-107`（`Load` 经 `sessionStatePath` 建目录后才报错）
- `sessions.go:153-159`（`AppendMessage` 先建目录再检查 `session.json`）
- `sessions.go:194-200`（`Delete` → `moveToTrash`，`store.go:163` 对不存在直接 `return nil`）

**场景**：页面传入一个不存在的 id，`Sessions.Load` 会先凭空创建 `sessions/<id>/` 再返回「找不到会话」。反复调用（或一次界面刷新遍历时拿到脏 id）会留下大量空目录；`List` 随后要为它们逐个尝试读状态（失败后跳过），既拖慢列表又污染数据目录。`Delete` 对不存在的 id 返回成功，界面据此把条目移除，实际什么都没删。

**修复建议**：读路径改用不建目录的纯 `filepath.Join`；写路径才 `MkdirAll`。`Delete` 对不存在返回明确错误。

**验收标准**：`Load`/`AppendMessage` 对不存在的 id 不产生任何目录；`Delete` 不存在 id 返回错误。

---

### B11 · P3 · 回收站无保留策略与容量上限，删除即无限累积

**位置**：`store.go:162-179`

`moveToTrash` 只负责改名进 `Trash/<base>-<时间戳>`，永不清理。删除会话（含整份转录）或大体积角色卡时，磁盘占用只增不减。会话目录可达数百 MB 量级时，用户会看到「删了但空间没回来」却无从得知原因。

**修复建议**：设定保留期（如 30 天）与总容量上限，在启动时清理；或在 `Trash` 内维护 `index.json` 记录大小。

**验收标准**：长时间使用后 `Trash` 占用有硬上限，超出时按最旧优先清理。

---

### B12 · P3 · 写入不校验 JSON 内 id 与目标文件 id 一致，可产生重复与悬空引用

**位置**

- `library.go:532-556`（`saveArtifact`：传入 id 与 JSON 内 `id` 各自独立）
- `sessions.go:131-145`（`SaveState` 同样不比对 `meta.id` 与目录名）

**场景**：`SaveWorld("world-a", '{"id":"world-b",...}')` 会写出 `worlds/world-a.json`，而内容自称 `world-b`。页面加载后按内容里的 id 继续保存，于是同一逻辑世界出现两份文件；会话里的 `worldId` 只能命中其中之一，另一个成为孤儿并在侧栏重复出现。会话状态同理：文件名与 `meta.id` 不一致时，重命名/倒流会写错对象。

**修复建议**：写入时若 JSON 内含 `id` 且与目标 id 不同，返回错误或强制覆盖为规范化后的 id。

**验收标准**：任何写入后，文件路径中的 id 与内容中的 id 必然一致。

---

### B13 · P3 · 配置读取无大小上限；Shell 颜色参数未校验

**位置**：`main.go:123`（`os.ReadFile(path)` 无限制）、`main.go:244-250`（`SetWindowBackground(color string)` 直接透传）

配置文件异常增大（被别的程序写入、或错误重定向）时，读取会把整个文件读进内存再解析。`SetWindowBackground` 接收页面传入的任意字符串并交给窗口层解析，非法值只会报错，但这是唯一一处把未校验字符串直接交给原生层的入口。

**修复建议**：`Load` 改用 `readLimited(path, 1<<20)`；`SetWindowBackground` 用正则限定颜色语法（`#[0-9a-f]{3,8}` 或 `light-dark(...)` 的组合）。

**验收标准**：超大 `config.json` 被拒绝而非整体读入；非法颜色字符串在 Go 侧即被拒绝。

---

### B14 · P3 · 随机源失败时退化为可预测 ID

**位置**：`store.go:70-76`

`crypto/rand` 失败时返回 `strconv.FormatInt(time.Now().UnixNano(), 16)[:n]`。同一纳秒内不可重现，但仍远弱于随机；更重要的是它把「熵不足」这件异常悄悄降级成了正常返回，调用方无从得知。会话 ID 与卡 ID 都建立在此之上。

**修复建议**：`randomHex` 返回 error，让创建操作失败并上报，而不是静默使用弱 ID（并与 B7 的冲突检测配合）。

**验收标准**：随机源不可用时创建操作报错，不产生可预测 ID。

---

### B15 · P3 · 错误信息回传绝对路径与文件元数据

**位置**：`library.go:130`/`128-139`（`os.Stat`/`readLimited` 的原始错误）、`library.go:343-349`、`sessions.go:107-110`

Go 原样返回 `*PathError` 文本（含完整绝对路径）与「文件过大：N 字节」。对本地单用户桌面应用影响有限，但它让 B1 的读取通道具备了路径探测能力（判断文件是否存在、是否可读、大致体积）。

**修复建议**：对外错误做归一化（`找不到世界书：<id>`、`文件不可读`），把路径细节只写进日志。

**验收标准**：IPC 返回的错误文本不含用户主目录绝对路径。

---

## 四、跨层风险链路（仅后端可达部分）

### 链路 1：任意 JSON 文件 → 资料库 → 页面

`Library.importLorebookFile(absPath)`（`library.go:128`，参数无路径策略）
→ `readLimited` 读原文件 → `decodeJSONObject` 只要求「是 JSON 对象」
→ 写入 `library/lorebooks/<slug>-<hex>.json` → 返回 id
→ 页面 `Library.loadLorebook(id)` 取回**原文**。

数据目录内的 `config.json`（含 API key）、`library/worlds/*.json`、域的会话 `session.json` 都是 JSON 对象，天然满足准入条件。这条链路的唯一闸门是「页面能否发起这次 IPC 调用」。

### 链路 2：模型/编辑内容 → `SaveCard` → `ExportCardTo` → 任意路径写入

模型经 `revise_character`/`create_character`/`slay_character`（`src/tools.ts`，写入走 `ctx.library.saveCard`）→ `Library.SaveCard`（`library.go:66`）只校验「顶层是 JSON 对象」
→ 该 JSON 成为资料库中的一张卡
→ `Library.exportCardTo(id, 任意路径)`（`library.go:394`）把这段**内容至少部分受模型影响**的 JSON 写到数据目录之外。

链路 2 的意义不是「模型能写文件」（它不能直接调 IPC），而是：一旦页面的写入路径被任何机制驱动，可写内容的来源就不是用户了，而是模型输出。

### 链路 3：长会话 → `session.json` 超限 → 静默停止存档

页面每轮 `saveSession`（`src/world/store.ts:157`，含全量消息投影 + 50 快照）
→ `Sessions.SaveState`（`sessions.go:132`）被 8MB 上限拒绝
→ 页面只显示一行错误 → 后续轮次继续失败，已存文件无法缩小 → 用户以为在存，实际没有。

### 链路 4：倒流 → rename 换 inode → 追加落到孤儿 → 静默丢消息

`rewind` 工具 → `Sessions.ReplaceMessages`（`sessions.go:173`，rename 换 inode）
与同轮 `message_end` → `Sessions.AppendMessage`（`sessions.go:148`，`O_APPEND` 绑定旧 inode）交错
→ 两个调用都成功，落旧 inode 的行随文件回收消失
→ `session.json` 的文本投影仍保留该轮，磁盘转录缺失 → 重开后对话断一截。

---

## 五、各层覆盖说明

### 5.1 已逐行审查的关键路径

- **IPC 暴露面**：`Settings.Load/Save`、`Library` 全部 22 个导出方法、`Sessions` 全部 7 个导出方法、`Shell.Quit/SetWindowBackground`。
- **路径构造**：`appDir`、`artifactPath`、`sessionDir`、`sessionStatePath`、`sessionMessagesPath`、`moveToTrash` 的目标路径。
- **写入**：`writeFileAtomic`、`os.WriteFile`（配置、导出、世界书、`messages.jsonl` 创建）、`os.OpenFile` + `O_APPEND`。
- **读取**：`readLimited`、`os.ReadFile`（配置）、`os.ReadDir` 两个列表目录。
- **解析**：`decodeJSONObject`、`normalizeCard`/`normalizeCardObject`/`fillCardDefaults`、`pngCardJSON`/`splitTextChunk`、`charxCardJSON`/`readZipEntry`、`decodeBase64Text`、`cardJSONName`/`cardMeta`/`hasBookJSON`、`summarizeArtifact`。
- **时间与元数据**：`parseMetaTime`、`jsonString`/`jsonObject`、`countMessageLines`。
- **配置归一化**：`normalizeConfig`/`normalizeReasoning`/`normalizeTheme`/`clampInt`。

### 5.2 已审查、未发现高危问题的路径（明确结论）

- **路径穿越**：`idPattern = ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`（`store.go:40`）+ `validID` 是唯一入口守卫，`..`、`/`、`\`、绝对路径、以点开头的名字全部无法通过；`moveToTrash` 只取 `filepath.Base`。所有落点都由 `validID` 保护的方法内部强制调用，没有绕过点。**未发现穿越。**
- **ZIP 解压**：`charxCardJSON` 不抽取文件到磁盘，只读内存中的成员，无 zip-slip 面；`readZipEntry` 同时校验头声明大小与 `io.LimitReader(maxImportBytes+1)`，声明的 64 位大小被 `readZipEntry` 双侧夹紧。**未发现解压炸弹可击穿点。**
- **PNG 分块解析**：`length < 0 || offset+length+4 > len(data)`（`cards.go:102`）在每次偏移推进前校验，循环条件 `offset+8 <= len(data)` 亦成立；长度字段不会造成越界切片。**未发现越界读。**
- **限长读取**：`readLimited` 同时做 `Stat` 预检与 `LimitReader(max+1)` 双保险，`max` 为 int64，无 32 位截断。**实现正确。**
- **JSON 解析健壮性**：`json.Valid` + `Unmarshal` 到 `map[string]json.RawMessage` 双重校验、BOM 剥离、拒绝非对象顶层；`encoding/json` 自带嵌套深度上限。**未发现可击穿的解析面。**
- **权限常量**：数据目录 `0700`、文件 `0600` 在新建时一致应用（既存文件不收敛的问题见 B6/B9 相关段落）。
- **原子写入本身**：`writeFileAtomic` 的「同目录临时文件 + Chmod + Sync + Close + Rename」顺序正确，`defer os.Remove` 不会误删已改名文件（改名后原路径已不存在）。

### 5.3 未覆盖（按主控指令收缩范围）

接驳层（`fetch` 出口、`AbortController`、流式事件与会话切换竞态）、前端内核（`agent.ts`/`main.ts`/`tools.ts` 的状态机）、UI（`ui.ts`/`style.css` 的 DOM 与可访问性）三层不在本报告内。本报告只在证据链需要时引用了 `src/main.ts`、`src/world/store.ts`、`src/world/session.ts` 的调用点，未对其行为下判断。

---

## 六、建议修复顺序

1. **B1**（先收口，工程量最小、收益最大）：删掉两个「无对话框」的路径型 API，或改为根目录内相对路径；`ExportCardTo` 直接并入 `ExportCard`。
2. **B4 + B2**（数据安全核心）：先加写入锁，再重新设计 `session.json` 载荷（去掉全量消息投影、快照只存差异），使上限与契约一致。
3. **B3 + B6**（失败可见性）：把静默吞错改为显式错误并保留损坏原件，让用户永远看得到「哪一步坏了」。
4. **B5 + B7 + B10**（导入与创建的边界收口）：归一化后校验大小、创建前查重、读路径不建目录。
5. **B8**（性能）：条数与摘要改为增量维护。
6. **B9 / B11 / B12 / B13 / B14 / B15**（加固）：可与其他改动合并进同一批「持久化加固」提交。

---

## 七、供修复代理执行的清单

以下每项给出涉及文件、改动要点与验收标准。执行时不要触碰 `RES/`，不要提交 Git，一次提交只做一件事。

| 编号 | 严重度 | 涉及文件 | 改动要点 | 验收标准 |
| --- | --- | --- | --- | --- |
| F1 | P1 | `library.go`（394-413、335-362、128-162）、`src/mygo.ts` | 移除或内部化 `ExportCardTo` / `ImportCardFile` / `ImportLorebookFile` 的任意路径能力；改为固定根目录 + `filepath.Rel` 越界断言 | 传入 `../`、绝对路径、`~` 均返回错误且不建目录；无法读写 `PathUserData` 之外的文件 |
| F2 | P2 | `sessions.go`（148-191）、新增锁文件 | `AppendMessage` 与 `ReplaceMessages` 共享按路径的互斥锁 | 并发 append/replace 压测无丢行；两调用均返回成功后转录完整 |
| F3 | P2 | `sessions.go`（132-145）、`store.go`（28-34）、前端契约文档 | 让 `session.json` 载荷与 8MB 上限匹配：去掉全量消息投影、快照存差异；或统一提高写入与读取上限 | 300 轮 / 300 条记忆的会话运行 50 轮后 `session.json` 体积不随快照数线性增长，保存始终成功 |
| F4 | P2 | `sessions.go`（117-127） | 转录读取失败时返回错误，不返回空消息列表 | `messages.jsonl` 不可读/超限时 `Load` 返回错误；界面不再出现「计数非零、内容为空」 |
| F5 | P2 | `cards.go`（36-72、179-200）、`library.go`（335-362） | 归一化结果与 base64 解码明文双重限长，超限报错且不落盘 | 构造 >8MB 卡数据的 PNG/CHARX 导入失败且资料库无残留；所有合法卡可被列出并加载 |
| F6 | P2 | `main.go`（147-163、118-145） | `Settings.Save` 改用 `writeFileAtomic`；保存后 `Chmod` 收敛为 0600；`Load` 解析失败时保留损坏副本并上报 | 杀进程中断写入后配置仍完整；既存 0644 文件保存后变 0600；损坏配置生成保留副本 |
| F7 | P2 | `sessions.go`（67-98）、`store.go`（70-76） | 会话 ID 改用 8 位以上随机并在冲突时重试（用 `os.Mkdir` 的 EEXIST 做原子占位）；`randomHex` 失败返回 error | 连续创建 1000 次无覆盖；同 id 重复创建返回错误且不动既有文件 |
| F8 | P2 | `sessions.go`（230-275）、`library.go`（429-469） | 条数与摘要改为增量维护（`AppendMessage` 时更新计数）；`listArtifacts` 按 `mtime+size` 缓存 | 20 个 5MB 会话的 `List` 读取量与转录总字节数无关；1000 条目录的列表调用仍在可交互延迟内 |
| F9 | P3 | `store.go`（85-112） | rename 后对父目录 `Sync` | 故障注入下重命名后的内容不丢失 |
| F10 | P3 | `sessions.go`（101-107、153-159、194-200、203-209） | 读路径不建目录（拆出 `sessionPath` 与 `sessionDirForWrite`）；`Delete` 对不存在 id 返回错误 | `Load`/`AppendMessage` 对不存在 id 不产生目录；`Delete` 不存在 id 返回错误 |
| F11 | P3 | `store.go`（162-179） | 回收站加保留期与容量上限，启动时清理 | `Trash` 占用有硬上限，超出按最旧清理 |
| F12 | P3 | `library.go`（532-556）、`sessions.go`（131-145） | 写入前比对 JSON 内 id 与目标 id，不一致则报错或强制规范化 | 写入后文件路径 id 与内容 id 必然一致 |
| F13 | P3 | `main.go`（123、244-250） | 配置读取改用 `readLimited`；`SetWindowBackground` 校验颜色语法 | 超大配置被拒绝；非法颜色在 Go 侧即被拒绝 |
| F14 | P3 | `library.go`（导入与加载错误）、`sessions.go`（107-110） | 对外错误归一化，路径与字节数细节只进日志 | IPC 错误文本不含绝对路径 |
| F15 | P3 | `store.go`（70-76） | 与 F7 合并：随机源失败即失败，不静默降级 | 随机源不可用时创建报错，不产生可预测 ID |

---

*本报告仅为审查结论，未对仓库做任何修改。*
