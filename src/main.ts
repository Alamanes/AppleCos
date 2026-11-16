/**
 * Page entry: world, sessions, agent, tools and the developer door, wired to
 * the real host services. The world engine owns story data; this module only
 * moves it between the screen, the agent and disk.
 */

import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

import { createAgent, normalize, type AgentHandle } from "./agent";
import { ConsentQueue } from "./consent";
import {
  DevMode,
  DIVINE_CURTAIN,
  DIVINE_OVERTURE,
  ORACLE_SECTION,
  ORACLE_SECTION_NAME,
  type DevEntrySource,
  type DevModeEvent,
} from "./devmode";
import { mountIcons } from "./icons";
import {
  createWorld as createLibraryWorld,
  loadCardById,
  loadLorebookById,
  loadWorld as loadLibraryWorld,
  loadWorldLoreDocument,
  migrateLibrary,
  newCardPayload,
  patchCardPayload,
  saveWorldCard,
  saveWorldLoreDocument,
  seedWorldArtifacts,
} from "./library";
import { Sessions, Settings, Shell, type Config, type SessionSummary } from "./mygo";
import {
  applyTheme,
  initSettings,
  openSettings,
  readFlags,
  refreshLibrary,
  setDevFlag,
  affinityTierLabel,
  useAffinityEditor,
  useClockHandler,
  useMemoryEntries,
  useMemoryStore,
  useRailMemory,
  useRailStats,
  useSessionStats,
  useQuitHandler,
  useSessionHandlers,
  useSessions,
  type Entry,
  type SessionMeta,
  type WorldState,
} from "./settings";
import { ChatView, messageText, type ToolHandle } from "./ui";
import {
  emptyRuntime,
  formatClock,
  isDivineTool,
  normalizeRuntime,
  toolsetFor,
  toolSummary,
  TOOL_LABELS,
  type StoryRuntime,
  type ToolConfig,
  type ToolContext,
  type ToolEventLog,
} from "./tools";
import { createBlockStream, parseBlocks, type Block } from "./world/blocks";
import { defaultWorld } from "./world/defaults";
import { createTransformContext, scanMessages } from "./world/prompt";
import {
  absorbLore,
  advanceTurn,
  appendMessage as appendWorldMessage,
  createSession as buildSession,
  hydrateSession,
  pruneSnapshots,
  restoreSession,
  rewindSession,
  setScene,
  snapshotTurn,
} from "./world/session";
import {
  accumulateUsage,
  emptySessionStats,
  normalizeSessionStats,
  sectionsToStats,
  type SessionStats,
} from "./world/stats";
import { getStore, type WorldStore } from "./world/store";
import {
  createId,
  normalizeRelations,
  relationOf,
  type CharacterCard,
  type PlayerIdentity,
  type SessionState,
  type TurnSnapshot,
  type World,
  type WorldMessage,
} from "./world/types";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const VOICE = "旁白";

const app = $("#app");
const view = new ChatView($("#chat"));
const form = $<HTMLFormElement>("#composer");
const input = $<HTMLTextAreaElement>("#input");
const sendButton = $<HTMLButtonElement>("#send");
const railToggle = $<HTMLButtonElement>("#toggle-rail");
const statusElement = $<HTMLElement>("#status");

let store: WorldStore;
let config: Config;
let world!: World;

/** Empty session used only to hold object identity before the first load. */
function placeholderSession(): SessionState {
  const now = Date.now();
  return {
    version: 1,
    meta: {
      id: "",
      worldId: "",
      title: "",
      cast: [],
      playerName: "",
      turn: 0,
      createdAt: now,
      updatedAt: now,
    },
    player: { name: "", description: "", persona: "" },
    messages: [],
    memory: { facts: [] },
    overlays: {},
    scene: { location: "", time: "", summary: "" },
    lore: { turn: 0, entries: {} },
    loreLog: {
      turn: 0,
      rounds: 0,
      budgetChars: 0,
      usedChars: 0,
      activated: [],
      skipped: [],
    },
    turns: [],
  };
}

let session: SessionState = placeholderSession();
let runtime: StoryRuntime = emptyRuntime();
/** Usage of the open session, saved beside its state. */
let sessionStats: SessionStats = emptySessionStats();
let handle: AgentHandle | null = null;
let transcript: AgentMessage[] = [];
let activeId = "";
let summaries: SessionSummary[] = [];
let running = false;
let ready = false;

const consent = new ConsentQueue({ unboundPolicy: "deny", timeoutMs: 120_000 });
const toolConfig: ToolConfig = { confirmLevel: "semi" };
const sections = new Map<string, string>();
const sessionViews = new Map<string, { updatedAt: string; meta: SessionMeta }>();
const toolCards = new Map<string, ToolHandle>();
/** Calls to unmounted tools: the guard answers them, no card is drawn. */
const ignoredCalls = new Set<string>();
const devLog: ToolEventLog[] = [];

let toolContext: ToolContext | null = null;
let devMode: DevMode | null = null;
/** True while the runtime mirrors its own state onto the settings flag. */
let mirroringDevFlag = false;
let turnReplied = false;
let turnStartedAt = 0;
let pendingRebuild = false;
let needsRerender = false;

/** Streaming parser for the structured reply that is being written. */
let blockStream: ReturnType<typeof createBlockStream> | null = null;
/** Blocks of the running reply that already reached the view. */
let blockSeen = 0;
let rewindPending = false;
let saveChain: Promise<void> = Promise.resolve();
let worldSaveChain: Promise<void> = Promise.resolve();

/* -------------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------------- */

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row.length > 0);
  return line ? line.slice(0, 40) : "";
}

function clockLabel(minute: number): string {
  const total = Math.max(0, Math.trunc(minute));
  const hour = Math.floor((total % 1440) / 60);
  const rest = total % 60;
  return String(hour).padStart(2, "0") + ":" + String(rest).padStart(2, "0");
}

function roleLabel(card: CharacterCard): string {
  const line = firstLine(card.scenario);
  if (line) return line.slice(0, 10);
  const tag = card.tags[0];
  return tag ? tag.slice(0, 10) : "角色";
}

function defaultConfig(): Config {
  return {
    kind: "openai",
    shape: "chat",
    baseUrl: "",
    model: "",
    apiKey: "",
    theme: "system",
    prompt: "",
    reasoning: "off",
    contextWindow: 32000,
    budgetPct: 20,
    triggerBudget: 4000,
    confirm: true,
    features: {
      worldPanel: true,
      worldClock: true,
      scriptMode: true,
      typewriter: true,
      autoTitle: true,
      reduceMotion: false,
      showLatency: false,
      worldbook: true,
      memory: true,
      tools: true,
      developerMode: false,
    },
  };
}

/* -------------------------------------------------------------------------
   Save chains
   ------------------------------------------------------------------------- */

function withRuntime(state: SessionState, rt: StoryRuntime = runtime): SessionState {
  return { ...state, runtime: { ...rt } } as unknown as SessionState;
}

async function saveStateNow(): Promise<void> {
  if (!activeId || !session) return;
  try {
    await store.saveSession({ ...withRuntime(session), stats: sessionStats } as unknown as SessionState);
  } catch (error) {
    view.error("保存会话失败：" + String(error));
  }
}

function scheduleSave(): void {
  saveChain = saveChain.then(() => saveStateNow()).catch(() => undefined);
}

async function flush(): Promise<void> {
  await saveChain.catch(() => undefined);
}

function saveWorldNow(): Promise<void> {
  worldSaveChain = worldSaveChain
    .then(async () => {
      try {
        await store.saveWorld(world);
      } catch (error) {
        view.error("保存世界失败：" + String(error));
      }
    })
    .catch(() => undefined);
  return worldSaveChain;
}

/* -------------------------------------------------------------------------
   Live data
   ------------------------------------------------------------------------- */

function commitSession(next: SessionState): void {
  Object.assign(session, next);
}

function commitRuntime(next: StoryRuntime): void {
  Object.assign(runtime, next);
}

function runtimeOf(state: unknown): StoryRuntime {
  const record = state as { runtime?: unknown } | null;
  return normalizeRuntime(record?.runtime);
}

function currentTranscript(): AgentMessage[] {
  return handle ? [...handle.agent.state.messages] : [...transcript];
}

function promptCards(): CharacterCard[] {
  const cards: CharacterCard[] = [];
  const narrator = world.cards[world.narratorId];
  if (narrator) cards.push(narrator);
  for (const id of session.meta.cast) {
    if (id === world.narratorId) continue;
    const card = world.cards[id];
    if (card) cards.push(card);
  }
  return cards;
}

function mountedTools(ctx: ToolContext, divine = runtime.devMode.on): AgentTool<any>[] {
  const flags = readFlags();
  return toolsetFor(ctx, divine).filter((tool) => {
    if (tool.name === "roll") return flags.tools.dice;
    if (tool.name === "set_scene") return flags.tools.scene || flags.tools.time;
    if (tool.name === "recall") return flags.tools.lore;
    if (tool.name === "remember") return flags.memory;
    return true;
  });
}

function historyBudget(): number {
  const context = Math.max(2048, Math.min(2_000_000, config.contextWindow || 32_000));
  const pct = Math.min(100, Math.max(5, config.budgetPct || 20));
  return Math.max(4000, Math.floor(context * (pct / 100) * 2));
}

/* -------------------------------------------------------------------------
   Transcript conversion
   ------------------------------------------------------------------------- */

function parseAgentMessages(lines: readonly string[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { role?: string } | null;
      if (!parsed || typeof parsed !== "object") continue;
      const role = parsed.role;
      if (role !== "system" && role !== "user" && role !== "assistant" && role !== "toolResult") {
        continue;
      }
      out.push(parsed as unknown as AgentMessage);
    } catch {
      // A truncated line stays on disk; it must not break the boot.
    }
  }
  return out;
}

function toAgentMessage(message: WorldMessage): AgentMessage {
  if (message.role === "assistant") {
    // Providers replay stored assistant turns, so keep the shape they expect.
    return {
      role: "assistant",
      content: [{ type: "text", text: message.content }],
      api: "openai-completions",
      provider: "custom",
      model: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: message.timestamp,
    } as unknown as AgentMessage;
  }
  return {
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
  } as unknown as AgentMessage;
}

function agentMessagesFrom(messages: readonly WorldMessage[]): AgentMessage[] {
  return messages.filter((message) => !message.hidden).map((message) => toAgentMessage(message));
}

/** Replays stored turns, labelling the assistant as the world's narrator. */
function renderTranscript(messages: readonly AgentMessage[]): void {
  view.render(
    messages.map((message) => {
      const record = message as unknown as { role?: string };
      if (record.role !== "assistant") return message;
      return { ...(message as unknown as Record<string, unknown>), speaker: VOICE };
    }),
  );
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.trim() !== "") parts.push(text);
  }
  return parts.join("\n").trim();
}

/* -------------------------------------------------------------------------
   Tool context
   ------------------------------------------------------------------------- */

function setPromptSection(name: string, text: string | null): void {
  if (text === null || text.trim() === "") sections.delete(name);
  else sections.set(name, text);
}

function appendPromptSections(messages: AgentMessage[]): AgentMessage[] {
  if (sections.size === 0) return messages;
  const extra = [...sections.entries()]
    .map(([name, body]) => "## " + name + "\n" + body)
    .join("\n\n");
  const first = messages[0];
  if (first && (first as unknown as { role?: string }).role === "system") {
    const record = first as unknown as Record<string, unknown>;
    const body = messageText(first);
    const merged = { ...record, content: body + "\n\n" + extra } as unknown as AgentMessage;
    return [merged, ...messages.slice(1)];
  }
  return [{ role: "system", content: extra, timestamp: Date.now() } as unknown as AgentMessage, ...messages];
}

function logToolEvent(event: ToolEventLog): void {
  devLog.push(event);
  if (devLog.length > 200) devLog.shift();
  if (devMode?.isOpen()) {
    view.say("notice", "[" + event.kind + "] " + (TOOL_LABELS[event.tool] ?? event.tool));
  }
}

/** Drops tool results whose tool call no longer exists after a rewind. */
function sanitizeTranscript(messages: readonly AgentMessage[]): AgentMessage[] {
  const calls = new Set<string>();
  const kept: AgentMessage[] = [];
  for (const message of messages) {
    const record = message as unknown as { role?: string; content?: unknown; toolCallId?: string };
    if (record.role === "assistant" && Array.isArray(record.content)) {
      for (const block of record.content) {
        const item = block as { type?: string; id?: string };
        if (item.type === "toolCall" && typeof item.id === "string") calls.add(item.id);
      }
    }
    if (record.role === "toolResult") {
      if (!record.toolCallId || !calls.has(record.toolCallId)) continue;
    }
    kept.push(message);
  }
  return kept;
}

function rewindTo(
  snapshot: TurnSnapshot,
  options: { keepMemory: boolean },
): { ok: boolean; reason?: string; removedTurns: number; keptMessages: number } {
  const current = handle;
  if (!current) return { ok: false, reason: "没有正在运行的会话。", removedTurns: 0, keptMessages: 0 };
  const before = session.meta.turn;
  const memory = session.memory;
  const next = rewindSession(session, snapshot.turn);
  if (options.keepMemory) next.memory = memory;
  commitSession(next);
  const messages = agentMessagesFrom(session.messages);
  current.agent.state.messages = messages;
  transcript = messages;
  needsRerender = true;
  rewindPending = true;
  void Sessions.replaceMessages(
    session.meta.id,
    messages.map((message) => JSON.stringify(message)),
  ).catch((error) => view.error("重写对话失败：" + String(error)));
  scheduleSave();
  pushWorldState();
  return {
    ok: true,
    removedTurns: Math.max(0, before - next.meta.turn),
    keptMessages: messages.length,
  };
}

function ensureToolContext(): ToolContext {
  if (toolContext) return toolContext;
  toolContext = {
    // A getter keeps the id current when the open world changes.
    get worldId() {
      return world.id;
    },
    library: {
      loadBook: () => loadWorldLoreDocument(world),
      saveBook: (doc) => saveWorldLoreDocument(world, doc),
      saveCard: (id, payload) => saveWorldCard(world, id, payload),
      saveWorld: () => saveWorldNow(),
      refresh: () => {
        void refreshLibrary();
      },
    },
    world,
    session,
    runtime,
    consent,
    snapshots: { rewind: (snapshot, options) => rewindTo(snapshot, options) },
    prompt: { setSection: (name, text) => setPromptSection(name, text) },
    config: toolConfig,
    log: (event) => logToolEvent(event),
    now: () => Date.now(),
  };
  return toolContext;
}

/* -------------------------------------------------------------------------
   Agent assembly
   ------------------------------------------------------------------------- */

function buildTransform() {
  return createTransformContext({
    snapshot: () => {
      const flags = readFlags();
      const worldView: World = flags.worldbook
        ? world
        : { ...world, lorebook: { ...world.lorebook, entries: [] } };
      const sessionView: SessionState = flags.memory
        ? session
        : { ...session, memory: { facts: [] } };
      return { world: worldView, cards: promptCards(), player: session.player, session: sessionView };
    },
    historyBudgetChars: historyBudget(),
    onLore: (result) => {
      if (!readFlags().worldbook) return;
      commitSession(absorbLore(session, result));
      pushWorldState();
    },
    instructions: config.prompt?.trim() || undefined,
    onSections: (list) => {
      const context = sectionsToStats(list);
      sessionStats = {
        ...sessionStats,
        context,
        contextTotalChars: context.reduce((sum, item) => sum + item.chars, 0),
      };
    },
    adjust: appendPromptSections,
  });
}

/** Names the current agent actually exposes, for the guard and the card filter. */
function mountedToolNames(): string[] {
  return handle ? handle.agent.state.tools.map((tool) => tool.name) : [];
}

async function beforeToolCall(context: {
  toolCall: { name: string };
  args: unknown;
}): Promise<{ block: boolean; reason?: string } | undefined> {
  const name = context.toolCall.name;
  const mounted = mountedToolNames();
  if (!mounted.includes(name)) {
    // A model that mistakes a JSON field name for a tool gets told the format
    // instead of a bare refusal, so the next attempt writes the reply properly.
    return {
      block: true,
      reason:
        "没有名为 " +
        name +
        " 的工具。narration、speech、thought 是回复 JSON 里的 kind 字段值，不是工具。" +
        '本轮请直接输出 {"blocks":[{"kind":"narration","text":"…"}]} 这样的正文，不要再调用工具。',
    };
  }
  if (isDivineTool(name) && toolConfig.confirmLevel === "strict") {
    const allowed = await consent.request({
      tool: name,
      label: (TOOL_LABELS[name] ?? name) + " · 神域",
      summary: toolSummary(name, context.args),
      irreversible: false,
    });
    if (!allowed) return { block: true, reason: "玩家拒绝了这次神力。" };
  }
  return undefined;
}

function bindAgent(agent: AgentHandle["agent"]): void {
  agent.subscribe(async (event) => {
    try {
      await handleAgentEvent(event);
    } catch (error) {
      view.error("处理事件失败：" + String(error));
    }
  });
}

async function rebuildAgent(messages: AgentMessage[], reason: string): Promise<void> {
  transcript = [...messages];
  if (!config.model.trim()) {
    handle = null;
    return;
  }
  const contextWindow = Math.max(2048, Math.min(2_000_000, config.contextWindow || 32_000));
  const maxTokens = Math.min(8192, Math.max(512, Math.floor(contextWindow / 3)));
  const ctx = ensureToolContext();
  try {
    const next = await createAgent({
      config,
      messages,
      systemPrompt: "",
      tools: mountedTools(ctx),
      transformContext: buildTransform(),
      beforeToolCall: (context) => beforeToolCall(context),
      maxTokens,
    });
    bindAgent(next.agent);
    handle = next;
    transcript = [...next.agent.state.messages];
    if (runtime.devMode.on) next.agent.state.tools = mountedTools(ctx, true);
    if (reason === "session") {
      needsRerender = false;
    }
  } catch (error) {
    view.error("模型没有连上：" + String(error));
  }
}

/* -------------------------------------------------------------------------
   Agent events
   ------------------------------------------------------------------------- */

/** Feeds one streamed delta; blocks render as soon as they close. */
function streamBlocks(delta: string): void {
  if (!blockStream) {
    blockStream = createBlockStream();
    blockSeen = 0;
    view.beginBlocks();
  }
  const blocks = blockStream.push(delta);
  if (blocks.length > 0) {
    blockSeen += blocks.length;
    view.appendBlocks(blocks);
  }
  // Text of the block still being written shows while the rest arrives.
  view.updatePreview(blockStream.preview());
}

/**
 * Lands the rest of a reply. A reply that never formed a block falls back to
 * its raw text as narration, so the transcript is never left silent.
 */
function settleBlocks(text: string): void {
  const stream = blockStream;
  blockStream = null;
  if (stream) {
    const tail = stream.finish();
    view.updatePreview(null);
    if (tail.length > 0) {
      blockSeen += tail.length;
      view.appendBlocks(tail);
    }
  } else {
    view.updatePreview(null);
  }
  const raw = text.trim();
  if (blockSeen === 0 && raw !== "") {
    const fallback: Block[] = parseBlocks(text) ?? [{ kind: "narration", text: raw }];
    view.beginBlocks();
    view.appendBlocks(fallback);
  }
  blockSeen = 0;
  view.endBlocks();
}

async function handleAgentEvent(event: AgentEvent): Promise<void> {
  switch (event.type) {
    case "message_start": {
      const role = (event.message as unknown as { role?: string }).role;
      if (role === "user") view.say("user", messageText(event.message));
      break;
    }
    case "message_update": {
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") streamBlocks(inner.delta);
      break;
    }
    case "message_end": {
      const message = event.message;
      const role = (message as unknown as { role?: string }).role;
      await persistMessage(message);
      if (role !== "assistant") return;
      sessionStats = accumulateUsage(sessionStats, (message as unknown as { usage?: Usage }).usage);
      const text = messageText(message);
      const record = message as unknown as { stopReason?: string; errorMessage?: string };
      if (text.trim() !== "" || blockStream) {
        settleBlocks(text);
        const ok = record.stopReason !== "error" && record.stopReason !== "aborted";
        if (text.trim() !== "" && ok) turnReplied = true;
      }
      if (record.stopReason === "error") view.error(record.errorMessage ?? "模型返回错误");
      break;
    }
    case "tool_execution_start": {
      const name = event.toolName;
      // A call to a tool that is not mounted is a formatting mistake by the
      // model, not an event worth showing; the guard answers it and the reply
      // continues. Only mounted tools get a card.
      if (!mountedToolNames().includes(name)) {
        ignoredCalls.add(event.toolCallId);
        break;
      }
      const card = view.tool(
        TOOL_LABELS[name] ?? name,
        toolSummary(name, event.args),
        "running",
      );
      toolCards.set(event.toolCallId, card);
      break;
    }
    case "tool_execution_end": {
      if (ignoredCalls.delete(event.toolCallId)) break;
      const card = toolCards.get(event.toolCallId);
      if (card) card.update(event.isError ? "error" : "done", resultText(event.result));
      toolCards.delete(event.toolCallId);
      pushWorldState();
      pushMemoryEntries();
      scheduleSave();
      if (isDivineTool(event.toolName)) await saveWorldNow();
      break;
    }
    case "agent_end": {
      await finishTurn();
      break;
    }
    default:
      break;
  }
}

async function persistMessage(message: AgentMessage): Promise<void> {
  if (!activeId) return;
  try {
    await Sessions.appendMessage(activeId, JSON.stringify(message));
  } catch (error) {
    view.error("写入对话失败：" + String(error));
    return;
  }
  for (const line of scanMessages([message])) {
    commitSession(
      appendWorldMessage(session, {
        role: line.role,
        content: line.content,
        speaker: line.speaker,
        turn: session.meta.turn,
      }),
    );
  }
}

async function finishTurn(): Promise<void> {
  setRunning(false);
  toolCards.clear();
  if (turnReplied) {
    commitSession(advanceTurn(session));
    commitSession(snapshotTurn(session, session.scene.summary));
    commitSession(pruneSnapshots(session, 50));
    await autoTitle();
  }
  turnReplied = false;
  if (pendingRebuild) {
    pendingRebuild = false;
    await rebuildAgent(currentTranscript(), "deferred");
  }
  if (rewindPending && handle) {
    rewindPending = false;
    const clean = sanitizeTranscript(handle.agent.state.messages);
    handle.agent.state.messages = clean;
    transcript = clean;
    try {
      await Sessions.replaceMessages(
        session.meta.id,
        clean.map((message) => JSON.stringify(message)),
      );
    } catch (error) {
      view.error("整理倒流后的对话失败：" + String(error));
    }
  }
  await saveStateNow();
  pushWorldState();
  await refreshSessions();
  if (needsRerender && handle) {
    needsRerender = false;
    renderTranscript(handle.agent.state.messages);
  }
  const flags = readFlags();
  if (flags.showLatency && turnStartedAt > 0) {
    const seconds = (Date.now() - turnStartedAt) / 1000;
    view.say("notice", "这一轮用了 " + seconds.toFixed(1) + " 秒");
  }
}

function isDefaultTitle(title: string): boolean {
  const trimmed = title.trim();
  return (
    trimmed === "" ||
    trimmed === world.name ||
    trimmed === "未命名会话" ||
    /^第\s*\d+\s*场/.test(trimmed)
  );
}

async function autoTitle(): Promise<void> {
  if (!readFlags().autoTitle) return;
  if (!isDefaultTitle(session.meta.title)) return;
  const last = [...session.messages].reverse().find((message) => message.role === "user");
  if (!last) return;
  const title = last.content.replace(/\s+/g, " ").trim().slice(0, 18);
  if (title === "") return;
  session.meta.title = title;
}

/* -------------------------------------------------------------------------
   Sessions
   ------------------------------------------------------------------------- */

async function ensureWorld(worldId: string): Promise<void> {
  if (!worldId || world.id === worldId) return;
  const loaded = await store.loadWorld(worldId).catch(() => null);
  if (!loaded) return;
  Object.assign(world, loaded);
}

function nextSessionTitle(): string {
  const index = summaries.filter((item) => item.worldId === world.id).length + 1;
  return "第 " + String(index).padStart(2, "0") + " 场 · " + world.name;
}

async function openSession(id: string): Promise<void> {
  const found =
    summaries.find((item) => item.id === id) ??
    (await store.listSessions()).find((item) => item.id === id);
  if (!found) return;
  await ensureWorld(found.worldId);
  const loaded = await store.loadSession(id).catch(() => null);
  if (!loaded) {
    view.error("打不开会话：" + id);
    return;
  }
  const state = loaded.state;
  sessionStats = normalizeSessionStats((state as { stats?: unknown } | null)?.stats);
  const restored = restoreSession(state, world);
  const parsed = parseAgentMessages(loaded.raw);
  const projections = restored.messages.length > 0 ? restored.messages : scanMessages(parsed);
  const next = hydrateSession(state, projections, world);
  // The host summary is authoritative when an older state forgot its header.
  next.meta.id = id;
  if (!next.meta.worldId) next.meta.worldId = found.worldId;
  if (!next.meta.title || next.meta.title === world.name) next.meta.title = found.title;
  commitSession(next);
  commitRuntime(runtimeOf(state));
  activeId = id;
  if (parsed.length === 0) transcript = agentMessagesFrom(projections);
  else transcript = parsed;
  sections.clear();
  if (runtime.devMode.on) sections.set(ORACLE_SECTION_NAME, ORACLE_SECTION);
  renderTranscript(transcript);
  pushMemoryEntries();
  await rebuildAgent(transcript, "session");
  if (devMode) devMode.restore(runtime.devMode);
  mirrorDevFlag(runtime.devMode.on);
  pushWorldState();
  await refreshSessions();
  input.focus();
}

async function switchSession(id: string): Promise<void> {
  if (!ready || !id || id === activeId) return;
  if (running) await halt();
  await flush();
  await openSession(id);
}

async function createNewSession(): Promise<void> {
  if (!ready) return;
  if (running) await halt();
  await flush();
  const title = nextSessionTitle();
  let summary: SessionSummary;
  try {
    summary = await store.createSession(world.id, title);
  } catch (error) {
    view.error("新建场次失败：" + String(error));
    return;
  }
  const fresh = buildSession(world, { id: summary.id, title });
  // A new scene starts from its own clock and cast; inheriting the previous
  // runtime is what made one scene leak its time and stage into the next.
  const freshRuntime: StoryRuntime = { ...emptyRuntime(), present: [...fresh.meta.cast] };
  for (const message of fresh.messages) {
    try {
      await Sessions.appendMessage(summary.id, JSON.stringify(toAgentMessage(message)));
    } catch {
      // The state still carries the opening line for this launch.
    }
  }
  try {
    await store.saveSession(withRuntime(fresh, freshRuntime));
  } catch (error) {
    view.error("保存场次失败：" + String(error));
  }
  summaries = (await store.listSessions()).filter((item) => item.worldId === world.id);
  await openSession(summary.id);
}

async function renameSession(id: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!ready || !trimmed) return;
  if (id === activeId) {
    session.meta.title = trimmed;
    await saveStateNow();
  } else {
    const loaded = await store.loadSession(id).catch(() => null);
    if (!loaded) return;
    const state = restoreSession(loaded.state, world);
    state.meta.title = trimmed;
    // Renaming another scene keeps the usage numbers it already stored.
    const keptStats = (loaded.state as { stats?: unknown } | null)?.stats;
    try {
      await store.saveSession({
        ...withRuntime(state, runtimeOf(loaded.state)),
        stats: keptStats,
      } as unknown as SessionState);
    } catch (error) {
      view.error("重命名失败：" + String(error));
      return;
    }
  }
  await refreshSessions();
}

async function deleteSession(id: string): Promise<void> {
  if (!ready) return;
  if (id === activeId && running) await halt();
  if (id === activeId) await flush();
  try {
    await store.removeSession(id);
  } catch (error) {
    view.error("删除场次失败：" + String(error));
    return;
  }
  sessionViews.delete(id);
  summaries = summaries.filter((item) => item.id !== id);
  if (id === activeId) {
    activeId = "";
    const next = summaries[0];
    if (next) await openSession(next.id);
    else await createNewSession();
    return;
  }
  await refreshSessions();
}

function liveSessionMeta(summary: SessionSummary, index: number): SessionMeta {
  const last = [...session.messages].reverse().find((message) => message.content.trim() !== "");
  return {
    id: summary.id,
    index,
    title: session.meta.title || summary.title,
    scene: session.scene.location || world.name,
    dayIndex: Math.floor(runtime.clockMinute / 1440) + 1,
    clock: clockLabel(runtime.clockMinute),
    preview: last ? last.content.replace(/\s+/g, " ").trim().slice(0, 40) : "还没有台词",
    updatedAt: Date.parse(summary.updatedAt) || Date.now(),
    state: running ? "streaming" : "idle",
  };
}

function rawPreview(line: string): string {
  try {
    return messageText(JSON.parse(line)).replace(/\s+/g, " ").trim().slice(0, 40);
  } catch {
    return "";
  }
}

async function sessionMetaFor(summary: SessionSummary, index: number): Promise<SessionMeta> {
  if (summary.id === activeId) return liveSessionMeta(summary, index);
  const cached = sessionViews.get(summary.id);
  if (cached && cached.updatedAt === summary.updatedAt) return { ...cached.meta, index };
  const loaded = await store.loadSession(summary.id).catch(() => null);
  const state = loaded?.state;
  const restored = loaded ? restoreSession(state, world) : null;
  const viewRuntime = runtimeOf(state);
  let preview = "还没有台词";
  if (loaded) {
    for (let i = loaded.raw.length - 1; i >= 0 && i >= loaded.raw.length - 6; i -= 1) {
      const text = rawPreview(loaded.raw[i] ?? "");
      if (text !== "") {
        preview = text;
        break;
      }
    }
  }
  const meta: SessionMeta = {
    id: summary.id,
    index,
    title: summary.title,
    scene: restored?.scene.location || world.name,
    dayIndex: Math.floor(viewRuntime.clockMinute / 1440) + 1,
    clock: clockLabel(viewRuntime.clockMinute),
    preview,
    updatedAt: Date.parse(summary.updatedAt) || Date.now(),
    state: "idle",
  };
  sessionViews.set(summary.id, { updatedAt: summary.updatedAt, meta });
  return meta;
}

async function refreshSessions(): Promise<void> {
  let all: SessionSummary[];
  try {
    all = await store.listSessions();
  } catch {
    return;
  }
  const list = all.filter((item) => item.worldId === world.id);
  summaries = list;
  const ordered = list
    .slice()
    .sort((left, right) => (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0));
  const rows: SessionMeta[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const summary = ordered[index];
    if (!summary) continue;
    rows.push(await sessionMetaFor(summary, index + 1));
  }
  useSessions(rows, activeId);
}

/* -------------------------------------------------------------------------
   World state and clock
   ------------------------------------------------------------------------- */

function pushWorldState(): void {
  if (!session || !world) return;
  const minute = runtime.clockMinute || 0;
  const hour = Math.floor((minute % 1440) / 60);
  const weather = hour >= 19 || hour < 5 ? "夜" : hour >= 17 ? "黄昏" : "白昼";
  const cast = session.meta.cast
    .map((id) => world.cards[id])
    .filter((card): card is CharacterCard => card !== undefined)
    .map((card) => ({
      id: card.id,
      name: card.name,
      role: roleLabel(card),
      // The world table is authoritative; the overlay only projects this scene.
      trust:
        typeof world.relations?.[card.id] === "number"
          ? relationOf(world.relations, card.id)
          : session.overlays[card.id]?.affinity ?? 0,
    }));
  const state: WorldState & { activeWorldId: string } = {
    name: world.name,
    tagline: firstLine(world.summary) || firstLine(world.setting),
    playerName: session.player.name,
    place: session.scene.location || "—",
    weather,
    dayIndex: Math.floor(minute / 1440) + 1,
    clock: clockLabel(minute),
    cast,
    loreHits: session.loreLog.activated
      .map((item) => item.title)
      .filter((title) => title !== ""),
    activeWorldId: world.id,
  };
  document.dispatchEvent(
    new CustomEvent<WorldState & { activeWorldId: string }>("applecos:world", { detail: state }),
  );
}

function setClock(minutes: number, phase?: string): void {
  if (!ready) return;
  const dayStart = Math.floor((runtime.clockMinute || 0) / 1440) * 1440;
  let next = runtime.clockMinute || 0;
  if (phase === "dusk") next = dayStart + 18 * 60 + 30;
  else if (phase === "night") next = dayStart + 22 * 60;
  else next += Math.max(0, minutes);
  runtime.clockMinute = next;
  commitSession(setScene(session, { time: formatClock(next) }));
  pushWorldState();
  scheduleSave();
  void refreshSessions();
}

/* -------------------------------------------------------------------------
   Library editor bridge
   ------------------------------------------------------------------------- */

/** Editor rows for the live session memory. */
function memoryEntries(): Entry[] {
  return session.memory.facts.map((fact) => {
    const cut = fact.text.indexOf("：");
    const title = cut > 0 ? fact.text.slice(0, cut) : fact.text;
    const body = cut > 0 ? fact.text.slice(cut + 1) : "";
    return {
      id: fact.id,
      kind: "memory",
      title: title.slice(0, 60),
      body,
      tags: fact.keywords.slice(),
      extra: { weight: String(Math.max(1, Math.round(fact.importance * 5))) },
      updatedAt: fact.updatedAt,
    };
  });
}

function pushMemoryEntries(): void {
  useMemoryEntries(memoryEntries());
}

/** Editor writes for memory land in the live session and its snapshot. */
function installMemoryStore(): void {
  // Rail memory pane reads the live facts; the pane re-renders on changes.
  useRailMemory(() =>
    session.memory.facts.map((fact) => ({
      tier: fact.tier,
      text: fact.text,
      updatedAt: fact.updatedAt,
    })),
  );
  // Footer numbers read lazily, so a session switch needs no re-registration.
  useRailStats(() => ({ turn: session.meta.turn, cast: session.meta.cast.length, clock: clockLabel(runtime.clockMinute || 0) }));
  // The editor reads and writes the same relations and overlays the rail shows.
  useAffinityEditor({
    get: (cardId) =>
      typeof world.relations?.[cardId] === "number"
        ? relationOf(world.relations, cardId)
        : session.overlays[cardId]?.affinity ?? 0,
    set: async (cardId, value) => {
      // applyAffinityEdit ignores cards outside the world; surface that instead.
      if (!world.cards[cardId]) throw new Error("card not in world");
      await applyAffinityEdit(cardId, value);
    },
    label: affinityTierLabel,
  });
  // Read on every open, so a switch never shows the numbers of the last scene.
  useSessionStats(() => sessionStats);
  useMemoryStore({
    list: () => memoryEntries(),
    save: async (entry) => {
      const title = entry.title.trim() || "未命名记忆";
      const body = entry.body.trim();
      const text = body === "" ? title : title + "：" + body;
      const weight = Number.parseInt(entry.extra.weight ?? "", 10);
      const importance = Number.isFinite(weight) ? Math.min(1, Math.max(0.2, weight / 5)) : 0.6;
      const existing = session.memory.facts.find((fact) => fact.id === entry.id);
      if (existing) {
        existing.text = text;
        existing.keywords = entry.tags.slice();
        existing.importance = importance;
        existing.updatedAt = Date.now();
      } else {
        session.memory.facts.push({
          id: entry.id || "memory-" + Date.now().toString(36),
          tier: "world",
          owner: "",
          text,
          keywords: entry.tags.slice(),
          importance,
          kind: "editor",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastUsedTurn: session.meta.turn,
          softenedAt: null,
          softenedImportance: null,
          softReason: "",
        });
      }
      scheduleSave();
      pushMemoryEntries();
    },
    remove: async (id) => {
      session.memory.facts = session.memory.facts.filter((fact) => fact.id !== id);
      scheduleSave();
      pushMemoryEntries();
    },
  });
}

async function addCardToWorld(id: string): Promise<void> {
  const card = await loadCardById(id);
  if (!card) {
    view.error("找不到这张角色卡。");
    return;
  }
  world.cards[id] = card;
  if (!session.meta.cast.includes(id)) session.meta.cast.push(id);
  if (!session.overlays[id]) {
    session.overlays[id] = {
      cardId: id,
      affinity: 0,
      tags: [],
      notes: [],
      relationship: "",
      updatedAt: Date.now(),
    };
  }
  await saveWorldNow();
  await saveStateNow();
  pushWorldState();
  await refreshSessions();
}

async function createFreshWorld(): Promise<void> {
  const id = await createLibraryWorld("新世界");
  await switchWorld(id);
}

/** Switching worlds flushes the current session, then opens the new stage. */
let switchingWorld = false;

async function switchWorld(id: string): Promise<void> {
  if (!ready || !id || switchingWorld) return;
  if (id === world.id) {
    await refreshLibrary();
    return;
  }
  switchingWorld = true;
  try {
    if (running) await halt();
    await flush();
    const loaded = await loadLibraryWorld(id).catch(() => null);
    if (!loaded) {
      view.error("打不开世界：" + id);
      return;
    }
    Object.assign(world, loaded);
    activeId = "";
    summaries = await store.listSessions().catch(() => []);
    const own = summaries.find((item) => item.worldId === world.id);
    if (own) await openSession(own.id);
    else await createNewSession();
    await refreshLibrary();
    pushWorldState();
    await refreshSessions();
  } finally {
    switchingWorld = false;
  }
}

/** A renamed player is a different person; other edits keep the same one. */
function identityChanged(before: PlayerIdentity, after: PlayerIdentity): boolean {
  const oldName = before.name.trim();
  return oldName !== "" && oldName !== after.name.trim();
}

/** Adds a card to the cast and gives it an overlay showing this scene. */
function addCastMember(cardId: string): void {
  if (!session.meta.cast.includes(cardId)) session.meta.cast.push(cardId);
  if (!session.overlays[cardId]) {
    session.overlays[cardId] = {
      cardId,
      affinity: relationOf(world.relations, cardId),
      tags: [],
      notes: [],
      relationship: "",
      updatedAt: Date.now(),
    };
  }
}

/** Archive block heading, also used to keep re-archiving idempotent. */
const IDENTITY_ARCHIVE_HEAD = "【前玩家身份档案】";

/** Keeps what the cast felt about the retired identity on its card. */
function identityArchive(old: PlayerIdentity): string {
  const lines: string[] = ["前玩家身份：" + (old.name.trim() || "旧身份")];
  if (old.description.trim()) lines.push("旧身份的设定：" + old.description.trim());
  if (old.persona.trim()) lines.push("对旧身份的行为要求：" + old.persona.trim());

  const bonds: string[] = [];
  for (const [cardId, value] of Object.entries(normalizeRelations(world.relations))) {
    const card = world.cards[cardId];
    if (!card) continue;
    bonds.push(card.name + " 好感 " + (value > 0 ? "+" + value : String(value)));
  }
  if (bonds.length > 0) lines.push("各角色对旧玩家的好感：" + bonds.join("、"));

  const records: string[] = [];
  for (const [cardId, overlay] of Object.entries(session.overlays)) {
    const card = world.cards[cardId];
    if (!card) continue;
    const bits: string[] = [];
    if (overlay.relationship.trim()) bits.push("关系：" + overlay.relationship.trim());
    if (overlay.tags.length > 0) bits.push("状态：" + overlay.tags.join("、"));
    if (overlay.notes.length > 0) bits.push("记录：" + overlay.notes.join("；"));
    if (bits.length > 0) records.push(card.name + "——" + bits.join("；"));
  }
  if (records.length > 0) lines.push("旧身份留下的关系记录：\n" + records.join("\n"));
  return lines.join("\n");
}

/** Appends the archive once, so repeated renames never duplicate it. */
function withIdentityArchive(description: string, archive: string): string {
  const block = IDENTITY_ARCHIVE_HEAD + "\n" + archive;
  const body = description.trim();
  if (body.includes(block)) return body;
  return body === "" ? block : body + "\n\n" + block;
}

/**
 * Retires the previous identity as a real card: its relations stay on that card
 * while the new player starts from an empty world table.
 */
async function retirePlayerIdentity(old: PlayerIdentity): Promise<void> {
  const archive = identityArchive(old);
  const oldName = old.name.trim() || "旧身份";
  const existing = Object.values(world.cards).find((card) => card.name.trim() === oldName);
  const cardId = existing?.id ?? createId("card");
  const payload = existing
    ? patchCardPayload(existing.raw, {
        description: withIdentityArchive(existing.description, archive),
      })
    : newCardPayload({
        name: oldName,
        description: withIdentityArchive("", archive),
        scenario: "前玩家身份，如今作为独立角色留在世界上。",
        tags: ["前玩家身份"],
      });
  await saveWorldCard(world, cardId, payload);
  addCastMember(cardId);
  // The new player owns an empty table; nothing carries over by accident.
  world.relations = {};
  for (const overlay of Object.values(session.overlays)) {
    overlay.affinity = 0;
    overlay.tags = [];
    overlay.notes = [];
    overlay.relationship = "";
    overlay.updatedAt = Date.now();
  }
}

/**
 * Mirrors an edited player card into the live world and the session. The prompt
 * snapshot reads session.player on every request, so no agent rebuild is needed.
 */
async function applyPlayerEdit(): Promise<void> {
  const loaded = await loadLibraryWorld(world.id).catch(() => null);
  if (!loaded) return;
  const previous = { ...session.player };
  const next = { ...loaded.player };
  const changed = identityChanged(previous, next);
  world.player = next;
  session.player = { ...next };
  session.meta.playerName = next.name;
  if (changed) await retirePlayerIdentity(previous);
  await saveWorldNow();
  await saveStateNow();
  pushWorldState();
  if (changed) {
    void refreshLibrary();
    await refreshSessions();
  }
}

/** Applies one editor write to the live world when it belongs to it. */
async function applyLibraryEdit(detail: {
  kind: string;
  id: string;
  action: "save" | "delete";
}): Promise<void> {
  if (detail.action === "delete") {
    if (detail.kind === "world" && detail.id === world.id) {
      const artifacts = await store.listWorlds().catch(() => []);
      const other = artifacts.find((artifact) => artifact.id !== world.id);
      if (other) await switchWorld(other.id);
      else await createFreshWorld();
      return;
    }
    if (detail.kind === "character" && world.cards[detail.id]) {
      delete world.cards[detail.id];
      delete session.overlays[detail.id];
      session.meta.cast = session.meta.cast.filter((cardId) => cardId !== detail.id);
      await saveWorldNow();
      await saveStateNow();
      pushWorldState();
      await refreshSessions();
    }
    if (detail.kind === "lore" && world.lorebook.id === detail.id) {
      world.lorebook = { ...world.lorebook, entries: [] };
      await saveWorldNow();
    }
    return;
  }

  if (detail.kind === "player") {
    await applyPlayerEdit();
    return;
  }
  if (detail.kind === "world" && detail.id === world.id) {
    const loaded = await loadLibraryWorld(detail.id).catch(() => null);
    if (!loaded) return;
    Object.assign(world, loaded);
    pushWorldState();
    await refreshSessions();
    return;
  }
  if (detail.kind === "character" && world.cards[detail.id]) {
    const card = await loadCardById(detail.id);
    if (!card) return;
    world.cards[detail.id] = card;
    await saveWorldNow();
    pushWorldState();
    return;
  }
  if (detail.kind === "lore" && world.lorebook.id === detail.id) {
    const book = await loadLorebookById(detail.id);
    if (!book) return;
    world.lorebook = book;
    await saveWorldNow();
    pushWorldState();
  }
}

/** Writes one affection edit from the rail into world, session and disk. */
async function applyAffinityEdit(cardId: string, value: number): Promise<void> {
  if (!world.cards[cardId]) return;
  const next = Math.max(-100, Math.min(100, Math.trunc(Number.isFinite(value) ? value : 0)));
  world.relations = { ...normalizeRelations(world.relations), [cardId]: next };
  const overlay = session.overlays[cardId];
  if (overlay) {
    overlay.affinity = next;
    overlay.updatedAt = Date.now();
  } else {
    session.overlays[cardId] = {
      cardId,
      affinity: next,
      tags: [],
      notes: [],
      relationship: "",
      updatedAt: Date.now(),
    };
  }
  await saveWorldNow();
  await saveStateNow();
  pushWorldState();
}

/* -------------------------------------------------------------------------
   Developer mode
   ------------------------------------------------------------------------- */

function applyDivineTools(divine: boolean): void {
  runtime.devMode = { ...runtime.devMode, on: divine };
  if (handle) handle.agent.state.tools = mountedTools(ensureToolContext(), divine);
  scheduleSave();
}

/** Writes the settings flag without treating it as a new user request. */
function mirrorDevFlag(on: boolean): void {
  if (readFlags().devMode === on) return;
  mirroringDevFlag = true;
  try {
    setDevFlag(on);
  } finally {
    mirroringDevFlag = false;
  }
}

function onDevEvent(event: DevModeEvent): void {
  runtime.devMode = devMode ? devMode.state() : runtime.devMode;
  if (event.type === "enter") {
    // The door was closed again while the overture played: respect that.
    if (!readFlags().devMode) {
      void devMode?.leave("switch");
      return;
    }
    view.god("神域开启");
    view.narrate(DIVINE_OVERTURE);
  } else if (event.type === "leave") {
    mirrorDevFlag(false);
    view.god("神域关闭");
    view.narrate(DIVINE_CURTAIN);
  } else if (event.type === "refused" && event.reason) {
    view.error(event.reason);
  }
  pushWorldState();
  scheduleSave();
}

function ensureDevMode(): void {
  if (devMode) return;
  devMode = new DevMode({
    bridge: {
      setTools: (divine) => applyDivineTools(divine),
      setSection: (name, text) => setPromptSection(name, text),
      halt: () => halt(),
    },
    state: runtime.devMode,
    allowStoryEntry: false,
    overtureMs: 600,
    traceOnLeave: true,
    onEvent: onDevEvent,
  });
}

async function toggleDev(source: DevEntrySource): Promise<void> {
  if (!handle) {
    view.error("先在设置里填好模型，神域才有回应。");
    if (readFlags().devMode) mirrorDevFlag(false);
    return;
  }
  ensureDevMode();
  if (!devMode) return;
  if (source === "switch") {
    // The setting is already on; open the door and undo it if the deck refuses.
    const opened = await devMode.enter(source);
    if (!opened) mirrorDevFlag(false);
    return;
  }
  if (devMode.isOpen() || devMode.phase !== "idle") {
    await devMode.toggle(source);
    return;
  }
  mirrorDevFlag(true);
  const opened = await devMode.enter(source);
  if (!opened) mirrorDevFlag(false);
}

/* -------------------------------------------------------------------------
   Channels from the settings module
   ------------------------------------------------------------------------- */

async function applyConfig(next: Config): Promise<void> {
  const previous = config;
  config = { ...next };
  if (!ready) return;
  const keys = [
    "baseUrl",
    "model",
    "apiKey",
    "kind",
    "shape",
    "prompt",
    "reasoning",
    "contextWindow",
    "budgetPct",
  ] as const;
  const changed = keys.some((key) => previous[key] !== next[key]);
  if (!changed) return;
  if (running) {
    pendingRebuild = true;
    return;
  }
  await rebuildAgent(currentTranscript(), "config");
}

function onFlagsChanged(): void {
  if (mirroringDevFlag) return;
  syncConsent();
  const flags = readFlags();
  if (!devMode) {
    if (flags.devMode) setDevFlag(false);
    return;
  }
  const open = devMode.isOpen() || devMode.phase === "opening";
  if (flags.devMode && !open) void toggleDev("switch");
  else if (!flags.devMode && open) void devMode.leave("switch");
  if (handle) handle.agent.state.tools = mountedTools(ensureToolContext(), runtime.devMode.on);
}

function reportFailure(prefix: string, error: unknown): void {
  view.error(prefix + String(error));
}

function bindChannels(): void {
  document.addEventListener("applecos:config", (event) => {
    const detail = (event as CustomEvent<Config & { reason?: string }>).detail;
    if (detail) void applyConfig(detail).catch((error) => reportFailure("应用设置失败：", error));
  });
  document.addEventListener("applecos:flags", () => onFlagsChanged());
  document.addEventListener("applecos:library-edit", (event) => {
    const detail = (event as CustomEvent<{ kind: string; id: string; action: "save" | "delete" }>).detail;
    if (detail) void applyLibraryEdit(detail).catch((error) => reportFailure("同步资料失败：", error));
  });
  document.addEventListener("applecos:card-add", (event) => {
    const detail = (event as CustomEvent<{ id: string }>).detail;
    if (detail?.id) void addCardToWorld(detail.id).catch((error) => reportFailure("加入角色失败：", error));
  });
  document.addEventListener("applecos:affinity", (event) => {
    const detail = (event as CustomEvent<{ cardId?: string; value?: number }>).detail;
    if (!detail?.cardId || typeof detail.value !== "number") return;
    void applyAffinityEdit(detail.cardId, detail.value).catch((error) =>
      reportFailure("保存好感失败：", error),
    );
  });
  document.addEventListener("applecos:world-switch", (event) => {
    const detail = (event as CustomEvent<{ id: string }>).detail;
    if (detail?.id) void switchWorld(detail.id).catch((error) => reportFailure("切换世界失败：", error));
  });
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
    if (event.key.toLowerCase() !== "d") return;
    event.preventDefault();
    void toggleDev("shortcut");
  });
}

/* -------------------------------------------------------------------------
   Consent bridge
   ------------------------------------------------------------------------- */

let consentBridgeBound = false;

function bindConsent(): void {
  consent.bind(
    (request) =>
      new Promise<"deferred">((resolve) => {
        const card = view.confirm({
          title: request.label + " · " + (TOOL_LABELS[request.tool] ?? request.tool),
          body: request.details ? request.summary + "\n\n" + request.details : request.summary,
          name: request.tool,
          approve: () => resolve("deferred"),
          deny: () => resolve("deferred"),
        });
        // A dismissed request must not leave a card behind.
        card.dataset.request = request.id;
      }),
  );
  if (consentBridgeBound) return;
  consentBridgeBound = true;
  document.addEventListener("applecos:tool-approve", () => {
    const active = consent.current();
    if (active) consent.allow(active.id);
  });
  document.addEventListener("applecos:tool-deny", () => {
    const active = consent.current();
    if (active) consent.deny(active.id);
  });
}

function syncConsent(): void {
  const confirm = readFlags().confirm;
  consent.setUnboundPolicy(confirm ? "deny" : "allow");
  if (confirm) bindConsent();
  else consent.bind(null);
}

/* -------------------------------------------------------------------------
   UI
   ------------------------------------------------------------------------- */

function syncSend(): void {
  if (running) {
    sendButton.dataset.mode = "busy";
    sendButton.disabled = false;
    sendButton.setAttribute("aria-label", "停止");
    return;
  }
  const ready = input.value.trim().length > 0;
  sendButton.dataset.mode = ready ? "ready" : "idle";
  sendButton.disabled = !ready;
  sendButton.setAttribute("aria-label", "发送");
}

function setRunning(next: boolean): void {
  running = next;
  statusElement.dataset.state = next ? "busy" : "idle";
  statusElement.textContent = next ? "演出中" : "待机";
  syncSend();
}

function grow(): void {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 168) + "px";
}

function setRail(open: boolean): void {
  app.dataset.rail = open ? "open" : "closed";
  railToggle.setAttribute("aria-expanded", String(open));
  railToggle.setAttribute("aria-label", open ? "收起侧栏" : "展开侧栏");
}

async function halt(): Promise<void> {
  const current = handle;
  if (!current) return;
  if (current.agent.state.isStreaming) current.agent.abort();
  await current.agent.waitForIdle().catch(() => undefined);
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text) return;
  if (text === "/神谕" || text.startsWith("/神谕 ")) {
    input.value = "";
    grow();
    syncSend();
    await toggleDev("slash");
    return;
  }
  if (running) return;
  if (!handle) {
    await rebuildAgent(currentTranscript(), "retry");
    if (!handle) {
      void openSettings("model");
      return;
    }
  }
  input.value = "";
  grow();
  syncSend();
  turnReplied = false;
  turnStartedAt = Date.now();
  setRunning(true);
  try {
    await handle.agent.prompt(text);
  } catch (error) {
    view.error("发送失败：" + String(error));
    setRunning(false);
  }
}

function bindUi(): void {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void send();
  });
  input.addEventListener("input", () => {
    grow();
    syncSend();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  });
  sendButton.addEventListener("click", () => {
    if (running) {
      handle?.agent.abort();
      return;
    }
    void send();
  });
  railToggle.addEventListener("click", () => setRail(app.dataset.rail === "closed"));
  $("#open-settings").addEventListener("click", () => void openSettings());
}

function registerHandlers(): void {
  useSessionHandlers({
    create: () => createNewSession(),
    select: (id) => switchSession(id),
    rename: (id, title) => renameSession(id, title),
    remove: (id) => deleteSession(id),
  });
  useClockHandler({ set: (minutes, phase) => setClock(minutes, phase) });
  useQuitHandler(async () => {
    if (!ready) {
      await quitApp();
      return;
    }
    consent.clear("cancelled");
    await halt();
    await flush();
    await worldSaveChain.catch(() => undefined);
    await saveStateNow();
    await saveWorldNow();
    await quitApp();
  });
}

async function quitApp(): Promise<void> {
  try {
    await Shell.quit();
  } catch {
    window.close();
  }
}

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */

async function loadOrCreateWorld(): Promise<void> {
  const artifacts = await store.listWorlds().catch(() => []);
  const first = artifacts[0];
  if (first) {
    const loaded = await store.loadWorld(first.id).catch(() => null);
    if (loaded) {
      world = loaded;
      return;
    }
  }
  world = defaultWorld();
  await saveWorldNow();
  await seedWorldArtifacts(world);
}

async function boot(): Promise<void> {
  setRunning(false);
  grow();
  mountIcons();
  registerHandlers();
  bindUi();
  bindConsent();
  bindChannels();
  initSettings();

  try {
    config = await Settings.load();
  } catch {
    config = defaultConfig();
  }
  applyTheme(config.theme || "system");

  store = getStore();
  await migrateLibrary().catch(() => undefined);
  await loadOrCreateWorld();
  ensureDevMode();
  installMemoryStore();
  ready = true;

  summaries = (await store.listSessions().catch(() => [])).filter(
    (item) => item.worldId === world.id,
  );
  const target = summaries[0]?.id ?? "";
  if (target) await openSession(target);
  else await createNewSession();

  syncConsent();
  pushWorldState();
  void refreshLibrary();
  if (!config.model.trim()) void openSettings("model");
  input.focus();
}

void boot().catch((error) => {
  view.error("启动失败：" + String(error));
});
