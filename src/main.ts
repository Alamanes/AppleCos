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
import { Sessions, Settings, Shell, events, type Config, type SessionSummary } from "./mygo";
import {
  applyTheme,
  initSettings,
  openSettings,
  readConfig,
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
import { isMyGo } from "mygo-runtime";

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
import { mergeCardBooks } from "./world/card";
import { defaultWorld } from "./world/defaults";
import { createTransformContext, LORE_ISOLATION, scanMessages } from "./world/prompt";
import {
  absorbLore,
  advanceTurn,
  appendMessage as appendWorldMessage,
  applyProjections,
  createSession as buildSession,
  hydrateSession,
  pruneSnapshots,
  readProjections,
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
  type LoreActivationResult,
  type Lorebook,
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
const deathBanner = $<HTMLElement>("#player-death");
const deathCause = $<HTMLElement>("#player-death-cause");

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

/**
 * Generation of the last session open. Every await inside openSession checks it,
 * so a slow load cannot commit a session the player already left.
 */
let openingToken = 0;
/** True while a switch owns the session; later clicks are queued, last one wins. */
let switchingSession = false;
type SwitchRequest = { kind: "open"; id: string } | { kind: "new" };
let pendingSwitch: SwitchRequest | null = null;
/** Set by a rewind so afterToolCall can end the turn on a clean transcript. */
let rewindRequested = false;
/** Lore activation of the request in flight; committed only once a reply lands. */
let pendingLore: LoreActivationResult | null = null;
/** Prompt assembly failures are reported once, not on every request. */
let promptFailureReported = false;
/** Card books merged into the world book, rebuilt only when the cast changes. */
let cardBookCache: { key: string; book: Lorebook } | null = null;

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

/** Strips the IPC wrapper and maps failures a player can act on. */
function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.replace(/^CallError:\s*/i, "").trim();
  if (/already processing/i.test(text)) return "上一轮还在收尾，请稍等一秒再发。";
  if (/is this page running inside a mygo|runtime not found/i.test(text)) {
    return "宿主没有响应，请从应用窗口里打开页面。";
  }
  if (/no api key|missing api key/i.test(text)) return "还没有填写 API 密钥。";
  return text;
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
      toolsDice: true,
      toolsTime: true,
      toolsScene: true,
      toolsLore: true,
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

/**
 * Serializes every write of the open session. A rewrite and an append both
 * target messages.jsonl, so the order they reach disk must match the order the
 * page produced them; state writes join the same queue for the same reason.
 */
let sessionIo: Promise<void> = Promise.resolve();

function queueIo<T>(work: () => Promise<T>): Promise<T> {
  const run = sessionIo.then(work, work);
  sessionIo = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function saveStateNow(): Promise<void> {
  if (!activeId) return;
  // The payload is snapshotted now; a later switch must not retarget this write.
  const payload = { ...withRuntime(session), stats: sessionStats } as unknown as SessionState;
  try {
    await queueIo(() => store.saveSession(payload));
  } catch (error) {
    const reason = readableError(error);
    // A size limit is the one failure the player can act on: say what to do.
    const hint = /太大|过大|too large/i.test(reason)
      ? "（状态已超过宿主上限，请清理快照或另开新场次）"
      : "";
    view.error("保存会话失败：" + reason + hint);
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
        view.error("保存世界失败：" + readableError(error));
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

/** The one place the live transcript is replaced; the view follows the agent. */
function setTranscript(messages: AgentMessage[]): void {
  transcript = messages;
  if (handle) handle.agent.state.messages = transcript;
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
  // The oracle section is the developer-mode contract. Every other section is
  // text injected through a tool, so it is framed as reference data like lore.
  const extra = [...sections.entries()]
    .map(([name, body]) =>
      name === ORACLE_SECTION_NAME
        ? "## " + name + "\n" + body
        : "## " + name + "\n" + LORE_ISOLATION + "\n" + body,
    )
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

/**
 * Cuts the live transcript at the message that closed the snapshot's turn. Real
 * Pi messages are kept, so tool calls and results survive a rewind; the world
 * projection alone only carries plain text.
 */
function cropTranscript(messages: readonly AgentMessage[], keep: number): AgentMessage[] | null {
  if (keep <= 0) return null;
  let seen = 0;
  let cut = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const role = (message as unknown as { role?: string }).role;
    if (role !== "user" && role !== "assistant") continue;
    if (messageText(message).trim() === "") continue;
    seen += 1;
    if (seen === keep) {
      cut = index + 1;
      break;
    }
  }
  if (cut < 0) return null;
  const kept = messages.slice(0, cut);
  // A result or a call whose pair fell outside the cut is invalid upstream.
  while (kept.length > 0 && (kept[kept.length - 1] as unknown as { role?: string })?.role === "toolResult") {
    kept.pop();
  }
  const last = kept[kept.length - 1] as { role?: string; content?: unknown } | undefined;
  if (last?.role === "assistant" && Array.isArray(last.content)) {
    const blocks = last.content.filter((block) => (block as { type?: string }).type !== "toolCall");
    if (blocks.length !== last.content.length) {
      kept[kept.length - 1] = { ...last, content: blocks } as unknown as AgentMessage;
    }
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
  const keep = next.messages.filter((message) => !message.hidden && message.content.trim() !== "").length;
  const messages = cropTranscript(current.agent.state.messages, keep) ?? agentMessagesFrom(next.messages);
  setTranscript(messages);
  needsRerender = true;
  // finishTurn rewrites the file once the turn closes, so the transcript is not
  // rewritten twice for the same rewind.
  rewindPending = true;
  rewindRequested = true;
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

/**
 * The world book with each card's own book folded in, so a setting imported
 * from a PNG or CHARX actually fires. Cached: rebuilding the entries every turn
 * would allocate a new book per request.
 */
function lorebookWithCards(cards: readonly CharacterCard[]): Lorebook {
  const key = [
    world.id,
    world.lorebook.entries.length,
    ...cards.map((card) => card.id + ":" + (card.lorebook ? card.lorebook.entries.length : 0)),
  ].join("|");
  if (cardBookCache && cardBookCache.key === key) return cardBookCache.book;
  const book = mergeCardBooks(world.lorebook, cards);
  cardBookCache = { key, book };
  return book;
}

function buildTransform() {
  return createTransformContext({
    snapshot: () => {
      const flags = readFlags();
      const cards = promptCards();
      const book: Lorebook = flags.worldbook
        ? lorebookWithCards(cards)
        : { ...world.lorebook, entries: [] };
      const worldView: World = { ...world, lorebook: book };
      const sessionView: SessionState = flags.memory
        ? session
        : { ...session, memory: { facts: [] } };
      return { world: worldView, cards, player: session.player, session: sessionView };
    },
    historyBudgetChars: historyBudget(),
    // Lore counters advance only once a reply lands, so a retried or aborted
    // request does not burn sticky and cooldown turns.
    onLore: (result) => {
      if (!readFlags().worldbook) return;
      pendingLore = result;
    },
    instructions: config.prompt?.trim() || undefined,
    onError: (error) => {
      console.error("[prompt] 装配失败", error);
      if (promptFailureReported) return;
      promptFailureReported = true;
      const reason = readableError(error);
      view.error("提示词装配失败，已退回最小规则：" + reason);
      logToolEvent({ at: Date.now(), kind: "prompt.error", tool: "prompt", payload: { message: reason } });
    },
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
    // Upstream resolves the tool before this hook, so this branch only fires when
    // the mounted set changed mid-loop. Answering with the reply format keeps
    // that case from turning into a bare English error.
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

/**
 * Ends the turn right after a rewind. The running loop still holds the context
 * it started with, so letting it write on would narrate a timeline that no
 * longer exists; the next turn starts from the rewritten transcript.
 */
async function afterToolCall(): Promise<{ terminate?: boolean } | undefined> {
  if (!rewindRequested) return undefined;
  rewindRequested = false;
  return { terminate: true };
}

function bindAgent(agent: AgentHandle["agent"]): void {
  agent.subscribe(async (event) => {
    try {
      await handleAgentEvent(event);
    } catch (error) {
      view.error("处理事件失败：" + readableError(error));
    }
  });
}

/**
 * Rebuilds the kernel agent. On failure the old handle is dropped instead of
 * kept: an agent built from a previous endpoint would keep sending the old key
 * to the old address while the panel shows the new, empty configuration.
 */
async function rebuildAgent(
  messages: AgentMessage[],
  reason: string,
  generation: number = openingToken,
): Promise<void> {
  const seed = [...messages];
  if (!config || !config.model.trim()) {
    handle = null;
    transcript = seed;
    return;
  }
  const contextWindow = Math.max(2048, Math.min(2_000_000, config.contextWindow || 32_000));
  const maxTokens = Math.min(8192, Math.max(512, Math.floor(contextWindow / 3)));
  const ctx = ensureToolContext();
  try {
    const next = await createAgent({
      config,
      messages: seed,
      systemPrompt: "",
      tools: mountedTools(ctx),
      transformContext: buildTransform(),
      beforeToolCall: (context) => beforeToolCall(context),
      afterToolCall: () => afterToolCall(),
      maxTokens,
    });
    // The player may have opened another session while the kernel was starting.
    if (generation !== openingToken) return;
    bindAgent(next.agent);
    handle = next;
    setTranscript([...next.agent.state.messages]);
    if (runtime.devMode.on) next.agent.state.tools = mountedTools(ctx, true);
    if (reason === "session") {
      needsRerender = false;
    }
  } catch (error) {
    handle = null;
    transcript = seed;
    view.error("模型没有连上：" + readableError(error) + "（发送已被阻止）");
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
      const record = message as unknown as { stopReason?: string; errorMessage?: string };
      const interrupted =
        role === "assistant" && (record.stopReason === "error" || record.stopReason === "aborted");
      if (role !== "assistant") {
        await persistMessage(message);
        return;
      }
      sessionStats = accumulateUsage(sessionStats, (message as unknown as { usage?: Usage }).usage);
      const text = messageText(message);
      if (text.trim() !== "" || blockStream) {
        settleBlocks(text);
        if (text.trim() !== "" && !interrupted) turnReplied = true;
      }
      if (record.stopReason === "error") view.error(record.errorMessage ?? "模型返回错误");
      // A cancelled or failed reply is shown, never stored: on reload it would
      // read as a finished turn that the player never got.
      if (!interrupted) {
        await persistMessage(message);
        commitPendingLore();
        pushWorldState();
      }
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
      commitPendingLore();
      await finishTurn();
      break;
    }
    default:
      break;
  }
}

async function persistMessage(message: AgentMessage): Promise<void> {
  // The target session is fixed before the await: a switch mid-write must not
  // push the line into whichever scene is open when the IPC returns.
  const id = activeId;
  if (!id) return;
  try {
    await queueIo(() => Sessions.appendMessage(id, JSON.stringify(message)));
  } catch (error) {
    view.error("写入对话失败：" + readableError(error));
    return;
  }
  if (id !== activeId) return;
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

/** Folds the lore activation of the finished request into the session. */
function commitPendingLore(): void {
  const result = pendingLore;
  pendingLore = null;
  if (!result) return;
  commitSession(absorbLore(session, result));
}

async function finishTurn(): Promise<void> {
  toolCards.clear();
  try {
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
      setTranscript(clean);
      const id = activeId;
      if (id) {
        const lines = clean.map((message) => JSON.stringify(message));
        try {
          await queueIo(() => Sessions.replaceMessages(id, lines));
        } catch (error) {
          view.error("整理倒流后的对话失败：" + readableError(error));
        }
      }
    }
    await saveStateNow();
    pushWorldState();
    pushMemoryEntries();
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
  } finally {
    // A rewind that never reached a tool call must not end the next turn.
    rewindRequested = false;
    // The kernel awaits this handler before it clears its own run, so switching
    // to idle earlier let a send slip into a run that was still finishing.
    setRunning(false);
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
  // Every await below can outlive the click that started it; a newer open wins
  // and a stale one returns without committing anything.
  const token = ++openingToken;
  const stale = (): boolean => token !== openingToken;
  const found =
    summaries.find((item) => item.id === id) ??
    (await store.listSessions()).find((item) => item.id === id);
  if (!found || stale()) return;
  await ensureWorld(found.worldId);
  if (stale()) return;
  let loadError: unknown = null;
  const loaded = await store.loadSession(id).catch((error) => {
    loadError = error;
    return null;
  });
  if (!loaded) {
    // The host reports why it refused (too large, unreadable transcript, gone);
    // the previous scene stays open and nothing is written over the broken one.
    if (!stale()) {
      const reason = loadError ? readableError(loadError) : "数据可能过大或已损坏";
      view.error("打不开场次：" + reason + "（" + id + "）");
    }
    return;
  }
  if (stale()) return;
  const state = loaded.state;
  sessionStats = normalizeSessionStats((state as { stats?: unknown } | null)?.stats);
  const restored = restoreSession(state, world);
  const parsed = parseAgentMessages(loaded.raw);
  const scanned = scanMessages(parsed);
  // New saves store only a header per line; older ones still carry the text.
  const headers = readProjections(state);
  const projections = storedLines(state, scanned, restored);
  const next = hydrateSession(state, projections, world);
  // The host summary is authoritative when an older state forgot its header.
  next.meta.id = id;
  if (!next.meta.worldId) next.meta.worldId = found.worldId;
  if (!next.meta.title || next.meta.title === world.name) next.meta.title = found.title;
  // Turn-scoped bookkeeping from the previous scene must not leak into this one.
  rewindPending = false;
  rewindRequested = false;
  needsRerender = false;
  pendingRebuild = false;
  pendingLore = null;
  turnReplied = false;
  blockStream = null;
  blockSeen = 0;
  toolCards.clear();
  ignoredCalls.clear();
  consent.clear("cancelled");
  commitSession(next);
  commitRuntime(runtimeOf(state));
  activeId = id;
  transcript = parsed.length === 0 ? agentMessagesFrom(projections) : parsed;
  sections.clear();
  if (runtime.devMode.on) sections.set(ORACLE_SECTION_NAME, ORACLE_SECTION);
  renderTranscript(transcript);
  // The two files are written independently; a mismatch is shown, not hidden.
  // World lines only: the transcript also holds tool calls and their results.
  const stated = headers.length > 0 ? headers.length : restored.messages.length;
  if (stated > 0 && stated !== scanned.length) {
    view.say(
      "notice",
      "本场次的转录与状态条数不一致（转录 " +
        scanned.length +
        " 条 / 状态 " +
        stated +
        " 条），已按转录显示。",
    );
  }
  pushMemoryEntries();
  await rebuildAgent(transcript, "session", token);
  if (stale()) return;
  if (devMode) devMode.restore(runtime.devMode);
  mirrorDevFlag(runtime.devMode.on);
  pushWorldState();
  await refreshSessions();
  if (stale()) return;
  input.focus();
}

/** True while the kernel is still working, even after the status went idle. */
function busy(): boolean {
  return running || Boolean(handle?.agent.state.isStreaming);
}

/** Stops the run and settles queued writes before the session changes. */
async function settleCurrent(): Promise<void> {
  if (busy()) await halt();
  await flush();
}

/** Runs queued switches one at a time; the last request wins. */
async function runSwitch(request: SwitchRequest): Promise<void> {
  switchingSession = true;
  try {
    let current: SwitchRequest | null = request;
    while (current) {
      await settleCurrent();
      if (current.kind === "open") await openSession(current.id);
      else await createSessionCore();
      const queued = pendingSwitch;
      pendingSwitch = null;
      const already = queued?.kind === "open" && queued.id === activeId;
      current = queued && !already ? queued : null;
    }
  } finally {
    switchingSession = false;
  }
}

async function switchSession(id: string): Promise<void> {
  if (!ready || !id) return;
  if (switchingSession) {
    // A switch is already running; remember the newest target instead of racing it.
    if (id !== activeId) pendingSwitch = { kind: "open", id };
    return;
  }
  if (id === activeId) return;
  await runSwitch({ kind: "open", id });
}

async function createNewSession(): Promise<void> {
  if (!ready) return;
  if (switchingSession) {
    pendingSwitch = { kind: "new" };
    return;
  }
  await runSwitch({ kind: "new" });
}

/** Creates a scene and opens it; callers hold the switch lock. */
async function createSessionCore(): Promise<void> {
  await settleCurrent();
  const title = nextSessionTitle();
  let summary: SessionSummary;
  try {
    summary = await store.createSession(world.id, title);
  } catch (error) {
    view.error("新建场次失败：" + readableError(error));
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
    view.error("保存场次失败：" + readableError(error));
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
    // Keep the stored line headers: rewriting the state must not drop them.
    state.messages = storedLines(loaded.state, scanMessages(parseAgentMessages(loaded.raw)), state);
    state.meta.title = trimmed;
    // Renaming another scene keeps the usage numbers it already stored.
    const keptStats = (loaded.state as { stats?: unknown } | null)?.stats;
    try {
      await store.saveSession({
        ...withRuntime(state, runtimeOf(loaded.state)),
        stats: keptStats,
      } as unknown as SessionState);
    } catch (error) {
      view.error("重命名失败：" + readableError(error));
      return;
    }
  }
  await refreshSessions();
}

async function deleteSession(id: string): Promise<void> {
  if (!ready) return;
  if (id === activeId && busy()) await halt();
  if (id === activeId) await flush();
  try {
    await store.removeSession(id);
  } catch (error) {
    view.error("删除场次失败：" + readableError(error));
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

/**
 * World lines of a stored scene: the transcript supplies the text, the stored
 * headers supply the ids and turns that snapshots and rewind key on.
 */
function storedLines(
  state: unknown,
  scanned: readonly WorldMessage[],
  restored: SessionState,
): WorldMessage[] {
  const headers = readProjections(state);
  if (headers.length > 0) return applyProjections(scanned, headers);
  return restored.messages.length > 0 ? restored.messages : [...scanned];
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

/** Affection shown and prompted for: the scene overlay, seeded by the world table. */
function affinityOf(cardId: string): number {
  const overlay = session.overlays[cardId];
  if (overlay) return overlay.affinity;
  return relationOf(world.relations, cardId);
}

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
      // The scene overlay owns the number, so a rewind rolls it back; the world
      // table only seeds a new scene.
      trust: affinityOf(card.id),
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
  syncPlayerDeath();
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
    get: (cardId) => affinityOf(cardId),
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
    if (busy()) await halt();
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
    else await createSessionCore();
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

/** Same marker slay_character writes; a dead identity retires as dead. */
const DECEASED_TAG = "已故";

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
  const death = session.playerDeath;
  const archive = identityArchive(old);
  const oldName = old.name.trim() || "旧身份";
  // A character that died on stage retires as a corpse: no cast slot, no prompt.
  const died = death !== undefined && (death.name.trim() === "" || death.name.trim() === oldName);
  const existing = Object.values(world.cards).find((card) => card.name.trim() === oldName);
  const cardId = existing?.id ?? createId("card");
  const payload = existing
    ? patchCardPayload(existing.raw, {
        description: withIdentityArchive(existing.description, archive),
        ...(died ? { tags: [...new Set([...existing.tags, "前玩家身份", DECEASED_TAG])] } : {}),
      })
    : newCardPayload({
        name: oldName,
        description: withIdentityArchive("", archive),
        scenario: died ? "前玩家身份，已在剧情中死去。" : "前玩家身份，如今作为独立角色留在世界上。",
        tags: died ? ["前玩家身份", DECEASED_TAG] : ["前玩家身份"],
      });
  await saveWorldCard(world, cardId, payload);
  if (!died) addCastMember(cardId);
  // The new player owns an empty table; nothing carries over by accident.
  world.relations = {};
  for (const overlay of Object.values(session.overlays)) {
    overlay.affinity = 0;
    overlay.tags = [];
    overlay.notes = [];
    overlay.relationship = "";
    overlay.updatedAt = Date.now();
  }
  if (died && death) {
    const overlay = session.overlays[cardId] ?? {
      cardId,
      affinity: 0,
      tags: [],
      notes: [],
      relationship: "",
      updatedAt: Date.now(),
    };
    overlay.deceased = true;
    overlay.deathCause = death.cause.trim() || "没有写明";
    overlay.diedAtTurn = death.turn;
    overlay.updatedAt = Date.now();
    session.overlays[cardId] = overlay;
    session.meta.cast = session.meta.cast.filter((id) => id !== cardId);
    runtime.present = runtime.present.filter((id) => id !== cardId);
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
  if (changed) {
    await retirePlayerIdentity(previous);
    // A written character ends the death lock; the old one is now a real card.
    delete session.playerDeath;
  } else if (
    session.playerDeath !== undefined &&
    (previous.description !== next.description || previous.persona !== next.persona)
  ) {
    // Same name, rewritten person: unlock, but mint no card that would collide.
    delete session.playerDeath;
  }
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
  // A save can land before the first load finishes; compare against defaults.
  const previous = config ?? defaultConfig();
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
  view.error(prefix + readableError(error));
}

function bindChannels(): void {
  document.addEventListener("applecos:config", (event) => {
    // The event is only a signal; the saved config is read from its owner so
    // the API key never travels through a document-wide CustomEvent.
    const detail = (event as CustomEvent<{ reason?: string } | undefined>).detail;
    if (!detail) return;
    void applyConfig(readConfig()).catch((error) => reportFailure("应用设置失败：", error));
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
  document.addEventListener("applecos:prepare-quit", () => {
    // The settings module asks the runtime to settle before the window closes.
    void shutdown();
  });
  window.addEventListener("beforeunload", () => {
    // Closing the window skips the in-app quit chain: stop the stream and make
    // a best-effort write so the last turn's state is not lost silently.
    consent.clear("cancelled");
    if (handle?.agent.state.isStreaming) handle.agent.abort();
    void saveStateNow();
    void saveWorldNow();
  });
}

/* -------------------------------------------------------------------------
   Consent bridge
   ------------------------------------------------------------------------- */

let consentBridgeBound = false;

/** Request id carried by a confirmation click; empty when the card had none. */
function consentRequestId(event: Event): string {
  const detail = (event as CustomEvent<{ id?: string; requestId?: string } | undefined>).detail;
  return detail?.requestId ?? detail?.id ?? "";
}

function bindConsent(): void {
  consent.bind(
    (request) =>
      new Promise<"deferred">((resolve) => {
        view.confirm({
          title: request.label + " · " + (TOOL_LABELS[request.tool] ?? request.tool),
          body: request.details ? request.summary + "\n\n" + request.details : request.summary,
          name: request.tool,
          // The card carries the request it answers, so an old card can never
          // approve a later request that replaced it.
          requestId: request.id,
          timeoutMs: request.timeoutMs,
          approve: () => resolve("deferred"),
          deny: () => resolve("deferred"),
        });
      }),
  );
  if (consentBridgeBound) return;
  consentBridgeBound = true;
  // Every settlement, timeout included, retires the card that asked for it.
  consent.onSettled((request, outcome) => {
    const state = outcome === "allow" ? "approved" : outcome === "deny" ? "denied" : "expired";
    view.resolveConfirm(request.id, state);
  });
  document.addEventListener("applecos:tool-approve", (event) => {
    const id = consentRequestId(event);
    // allow() only answers the active request; a stale card's click is ignored.
    if (id) consent.allow(id);
  });
  document.addEventListener("applecos:tool-deny", (event) => {
    const id = consentRequestId(event);
    if (id) consent.deny(id);
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

/**
 * Locks the composer while the player has no character: the death of their own
 * identity cannot be undone by a card, so nothing may be sent until a new one
 * is written.
 */
function syncPlayerDeath(): void {
  const death = session.playerDeath;
  const locked = death !== undefined;
  deathBanner.hidden = !locked;
  input.disabled = locked;
  input.placeholder = locked ? "角色已退场，建立新角色后才能继续" : "写一句台词";
  if (death) {
    const name = death.name.trim();
    const cause = death.cause.trim();
    deathCause.textContent = (name === "" ? "你扮演的角色" : "「" + name + "」") + (cause === "" ? "已经退场。" : "已经退场：" + cause);
  }
  syncSend();
}

function syncSend(): void {
  if (session.playerDeath) {
    sendButton.dataset.mode = "idle";
    sendButton.disabled = true;
    sendButton.setAttribute("aria-label", "角色已退场");
    return;
  }
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
  if (!ready) return;
  if (session.playerDeath) {
    // Guarded as well as disabled: a queued Enter must not slip past the lock.
    syncPlayerDeath();
    view.error("你的角色已经退场，先建立一名新角色。");
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  if (text === "/神谕" || text.startsWith("/神谕 ")) {
    input.value = "";
    grow();
    syncSend();
    await toggleDev("slash");
    return;
  }
  if (busy()) {
    // The kernel awaits this turn's listeners before it clears its own run, so
    // waiting here is what turns a click in the closing beat into a normal send.
    if (handle) await handle.agent.waitForIdle().catch(() => undefined);
    if (busy()) return;
  }
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
  rewindRequested = false;
  turnReplied = false;
  turnStartedAt = Date.now();
  setRunning(true);
  try {
    await handle.agent.prompt(text);
  } catch (error) {
    view.error("发送失败：" + readableError(error));
    // The line must not vanish; put it back so it can be sent again.
    if (input.value.trim() === "") {
      input.value = text;
      grow();
    }
    setRunning(false);
    syncSend();
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
    if (event.key !== "Enter" || event.shiftKey) return;
    // Enter commits an IME candidate; sending here would swallow the line.
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void send();
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
  // The player card lives in the world file; the rail button is its entry.
  $("#player-death-new").addEventListener("click", () => {
    document.querySelector<HTMLButtonElement>("#rail-open-player")?.click();
  });
}

/** Settles the story before the window goes away; runs at most once. */
let shutdownRun: Promise<void> | null = null;

async function runShutdown(): Promise<void> {
  consent.clear("cancelled");
  if (!ready) return;
  await halt();
  await flush();
  await worldSaveChain.catch(() => undefined);
  await saveStateNow();
  await saveWorldNow();
}

function shutdown(): Promise<void> {
  if (!shutdownRun) shutdownRun = runShutdown().catch(() => undefined);
  return shutdownRun;
}

/** Hears the host's pre-quit event; the client may not expose a helper for it. */
function subscribeQuitSignal(): void {
  try {
    if (!isMyGo()) return;
    // Generated event from the Go binding; the host closes shortly after it.
    events.appBeforeQuit.on(() => {
      // The host waits briefly, then closes regardless: keep this path short.
      void shutdown();
    });
  } catch {
    // No host runtime (plain vite dev): nothing will close the window here.
  }
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
    await shutdown();
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
  subscribeQuitSignal();
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
  view.error("启动失败：" + readableError(error));
});
