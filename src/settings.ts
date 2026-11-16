import { fetch as goFetch } from "@mygo-plugins/fetch";

import { defaultBaseUrl, detectRoute, type Route, type Shape, type Wire } from "./agent";
import {
  createWorld,
  deleteLibraryEntry,
  exportCardFile,
  exportLorebookFile,
  exportWorldFile,
  importCardFile,
  importLorebookFile,
  loadLibrary,
  loadPlayerEntry,
  saveLibraryEntry,
} from "./library";
import { DEFAULT_PLAYER_NAME } from "./world/types";
import { mountLorebookManager, type LorebookManager } from "./lorebook-ui";
import { Settings, type Config, type Features } from "./mygo";
import type { SessionStats } from "./world/stats";
import {
  applyTheme,
  currentChoice,
  normalizeChoice,
  resolvePalette,
  themeMeta,
  watchSystemTheme,
  type ThemeChoice,
} from "./theme";

export { applyTheme };

export interface ModelEntry {
  id: string;
  label: string;
}

const DEFAULT_PROMPT =
  "你是 AppleCos 的角色扮演引擎，运行在用户自己的 Mac 上。\n用简体中文回答，保持角色设定与沉浸感，不要解释你自己的实现细节。";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const $$ = <T extends HTMLElement>(selector: string): T[] =>
  Array.from(document.querySelectorAll<T>(selector));

/* -------------------------------------------------------------------------
   Go is the source of truth for worlds, cards and books. The page keeps only
   the editor cache below; nothing here writes business data to localStorage.
   ------------------------------------------------------------------------- */

function announce<T>(name: string, detail: T): void {
  document.dispatchEvent(new CustomEvent<T>(name, { detail }));
}

/* -------------------------------------------------------------------------
   Flags
   ------------------------------------------------------------------------- */

interface ToolFlags {
  dice: boolean;
  time: boolean;
  scene: boolean;
  lore: boolean;
}

interface Budget {
  context: number;
  pct: number;
  trigger: number;
}

export interface Flags {
  worldPanel: boolean;
  worldClock: boolean;
  scriptMode: boolean;
  typewriter: boolean;
  autoTitle: boolean;
  reduceMotion: boolean;
  showLatency: boolean;
  worldbook: boolean;
  memory: boolean;
  devMode: boolean;
  confirm: boolean;
  tools: ToolFlags;
  budget: Budget;
}

const DEFAULT_FLAGS: Flags = {
  worldPanel: true,
  worldClock: true,
  scriptMode: true,
  typewriter: true,
  autoTitle: true,
  reduceMotion: false,
  showLatency: false,
  worldbook: true,
  memory: true,
  devMode: false,
  confirm: true,
  tools: { dice: true, time: true, scene: true, lore: true },
  budget: { context: 32000, pct: 20, trigger: 4000 },
};

let flags: Flags = DEFAULT_FLAGS;

function mergeFlags(raw: Partial<Flags>): Flags {
  return {
    ...DEFAULT_FLAGS,
    ...raw,
    tools: { ...DEFAULT_FLAGS.tools, ...(raw.tools ?? {}) },
    budget: { ...DEFAULT_FLAGS.budget, ...(raw.budget ?? {}) },
  };
}

/* -------------------------------------------------------------------------
   World state
   ------------------------------------------------------------------------- */

export interface CastMember {
  /** Card id; present while the rail can edit the affection in place. */
  id?: string;
  name: string;
  role?: string;
  trust?: number;
  /** One-line current situation; omitted when the runtime does not send it. */
  situation?: string;
}

export interface WorldState {
  name: string;
  tagline: string;
  /** Display name of the player card in play. */
  playerName: string;
  place: string;
  weather: string;
  dayIndex: number;
  clock: string;
  cast: CastMember[];
  loreHits: string[];
}

const DEFAULT_WORLD: WorldState = {
  name: "未载入世界",
  tagline: "在设置里写一张世界设定",
  playerName: DEFAULT_PLAYER_NAME,
  place: "—",
  weather: "—",
  dayIndex: 1,
  clock: "00:00",
  cast: [],
  loreHits: [],
};

let world: WorldState = { ...DEFAULT_WORLD };

/* -------------------------------------------------------------------------
   Library: worlds, characters, lore, memories
   ------------------------------------------------------------------------- */

export type EditorKind = "world" | "character" | "lore" | "memory" | "player";

export interface Entry {
  id: string;
  kind: EditorKind;
  title: string;
  body: string;
  tags: string[];
  extra: Record<string, string>;
  updatedAt: number;
}

export type Library = Record<EditorKind, Entry[]>;

const EMPTY_LIBRARY: Library = { world: [], character: [], lore: [], memory: [], player: [] };

let library: Library = { world: [], character: [], lore: [], memory: [], player: [] };
let libraryBusy = false;
let activeWorldId = "";

/** The live session owns memory entries; the runtime registers this bridge. */
export interface MemoryStore {
  list(): Entry[];
  save(entry: Entry): Promise<void>;
  remove(id: string): Promise<void>;
}

let memoryStore: MemoryStore | null = null;

export function useMemoryStore(next: MemoryStore | null): void {
  memoryStore = next;
}

/** Called by the runtime when the session's memory facts change. */
export function useMemoryEntries(list: Entry[]): void {
  if (JSON.stringify(list) === JSON.stringify(library.memory)) return;
  library = { ...library, memory: list.slice() };
  refreshLibraryCounts();
  renderEditorIfOpen();
  renderRailMemory();
}

/** Reloads the four editor lists from the Go library. */
export async function refreshLibrary(): Promise<void> {
  if (libraryBusy) return;
  libraryBusy = true;
  try {
    const memory = memoryStore ? memoryStore.list() : library.memory;
    // The player card lives inside the world file, so keep the last read copy.
    library = { ...(await loadLibrary(memory)), player: library.player };
    refreshLibraryCounts();
    renderEditorIfOpen();
    renderWorldList();
  } catch (error) {
    setEditorStatus("读取资料库失败：" + String(error), true);
  } finally {
    libraryBusy = false;
  }
}

const KIND_META: Record<EditorKind, { label: string; noun: string }> = {
  world: { label: "世界", noun: "世界" },
  character: { label: "角色卡", noun: "角色" },
  lore: { label: "世界书", noun: "条目" },
  memory: { label: "记忆", noun: "记忆" },
  player: { label: "玩家角色", noun: "玩家角色" },
};

interface FieldDef {
  key: string;
  label: string;
  kind: "text" | "area" | "tags" | "number";
  placeholder?: string;
  rows?: number;
}

const EDITOR_FIELDS: Record<EditorKind, FieldDef[]> = {
  world: [
    { key: "title", label: "世界名", kind: "text", placeholder: "示例世界" },
    { key: "tagline", label: "一句话基调", kind: "text", placeholder: "例如：边境小镇的日常" },
    { key: "era", label: "时代", kind: "text", placeholder: "例如：架空年代、近代或现代" },
    { key: "place", label: "开场地点", kind: "text", placeholder: "例如：镇口驿站" },
    { key: "body", label: "设定正文", kind: "area", rows: 8 },
  ],
  character: [
    { key: "title", label: "名字", kind: "text", placeholder: "角色名" },
    { key: "tags", label: "关键词", kind: "tags", placeholder: "例如：谨慎, 务实, 守规矩" },
    { key: "relation", label: "处境或与你的关系", kind: "text", placeholder: "例如：初次见面的陌生人" },
    { key: "body", label: "外貌、口吻与底线", kind: "area", rows: 8 },
  ],
  lore: [{ key: "title", label: "世界书名", kind: "text", placeholder: "示例世界书" }],
  memory: [
    { key: "title", label: "摘要", kind: "text", placeholder: "你答应过对方一件事" },
    { key: "weight", label: "重要度 1–5", kind: "number", placeholder: "3" },
    { key: "body", label: "细节", kind: "area", rows: 8 },
  ],
  player: [
    {
      key: "title",
      label: "名字",
      kind: "text",
      placeholder: "用于对话署名与提示词，例如：玩家",
    },
    { key: "body", label: "身份描述", kind: "area", rows: 5 },
    { key: "persona", label: "行为要求", kind: "area", rows: 5 },
  ],
};

/* -------------------------------------------------------------------------
   Scenes
   ------------------------------------------------------------------------- */

export type SessionState = "idle" | "streaming" | "unread";

export interface SessionMeta {
  id: string;
  index: number;
  title: string;
  scene: string;
  dayIndex: number;
  clock: string;
  preview: string;
  updatedAt: number;
  state: SessionState;
}

let sessions: SessionMeta[] = [];
let activeSessionId = "";

/** Real host operations the page registers once the story runtime is up. */
export interface SessionHandlers {
  create(): void | Promise<void>;
  select(id: string): void | Promise<void>;
  rename(id: string, title: string): void | Promise<void>;
  remove(id: string): void | Promise<void>;
}

export interface ClockHandler {
  set(minutes: number, phase?: string): void | Promise<void>;
}

const handlers: {
  sessions?: SessionHandlers;
  clock?: ClockHandler;
  quit?: () => Promise<void>;
} = {};

/** Connects the scene list to the persisted sessions; null restores the local list. */
export function useSessionHandlers(next: SessionHandlers | null): void {
  handlers.sessions = next ?? undefined;
}

/** Connects the world clock buttons to the live story runtime. */
export function useClockHandler(next: ClockHandler | null): void {
  handlers.clock = next ?? undefined;
}

/** Connects the exit button to the runtime, which flushes before quitting. */
export function useQuitHandler(next: (() => Promise<void>) | null): void {
  handlers.quit = next ?? undefined;
}

/** Scenes the runtime owns take priority over the local fallback list. */
export function useSessions(list: SessionMeta[], activeId?: string): void {
  const previous = activeSessionId;
  sessions = list.slice();
  if (activeId) activeSessionId = activeId;
  if (!sessions.some((session) => session.id === activeSessionId)) {
    activeSessionId = sessions[0]?.id ?? "";
  }
  // The panel belongs to one scene, so a switch folds it instead of showing stale numbers.
  if (previous !== activeSessionId) closeSessionStats();
  renderSessions();
}

export function readSessions(): SessionMeta[] {
  return sessions.slice();
}

export function updateSession(id: string, patch: Partial<SessionMeta>): void {
  const next = sessions.map((session) => (session.id === id ? { ...session, ...patch } : session));
  if (JSON.stringify(next) === JSON.stringify(sessions)) return;
  sessions = next;
  persistSessions();
  renderSessions();
}

export function readFlags(): Flags {
  return { ...flags, tools: { ...flags.tools }, budget: { ...flags.budget } };
}

/** Mirrors a runtime developer-mode change on the setting and the banner. */
export function setDevFlag(on: boolean): void {
  if (flags.devMode === on) return;
  flags = { ...flags, devMode: on };
  syncSwitches();
  persistFlags();
  markSaved();
}

export function readWorld(): WorldState {
  return { ...world, cast: world.cast.slice(), loreHits: world.loreHits.slice() };
}

/* -------------------------------------------------------------------------
   Save indicator
   ------------------------------------------------------------------------- */

type SaveState = "idle" | "saving" | "saved" | "error";

function clockStamp(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function setSaveState(state: SaveState, message?: string): void {
  const foot = document.getElementById("save-state");
  if (!foot) return;
  foot.dataset.state = state;
  const label = message ?? (state === "idle" ? "所有改动即时保存" : state === "saving" ? "正在保存…" : "已保存");
  foot.replaceChildren(document.createTextNode(label));

  if (state === "error") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重试";
    retry.addEventListener("click", () => void saveConfig("manual"));
    foot.append(" ", retry);
  }
}

function markSaved(): void {
  setSaveState("saved", `已保存 · ${clockStamp()}`);
}

/* -------------------------------------------------------------------------
   Config: the model endpoint, saved through Go on every change
   ------------------------------------------------------------------------- */

export type ConfigReason = "endpoint" | "prompt" | "manual";

const DEFAULT_FEATURES: Features = {
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
};

let config: Config = {
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
  features: DEFAULT_FEATURES,
};

let wire: Wire = "openai";
let shape: Shape = "chat";
let configTimer: number | undefined;
let saveChain: Promise<void> = Promise.resolve();

/** Flags mapped onto the Features struct Go persists. */
function featuresFromFlags(source: Flags): Features {
  return {
    worldPanel: source.worldPanel,
    worldClock: source.worldClock,
    scriptMode: source.scriptMode,
    typewriter: source.typewriter,
    autoTitle: source.autoTitle,
    reduceMotion: source.reduceMotion,
    showLatency: source.showLatency,
    worldbook: source.worldbook,
    memory: source.memory,
    tools: source.tools.dice || source.tools.time || source.tools.scene || source.tools.lore,
    developerMode: source.devMode,
  };
}

/** Pulls a loaded config back into the local flag model. */
function adoptConfig(cfg: Config): void {
  config = cfg;
  const features = cfg.features ?? DEFAULT_FEATURES;
  flags = mergeFlags({
    ...flags,
    worldPanel: features.worldPanel,
    worldClock: features.worldClock,
    scriptMode: features.scriptMode,
    typewriter: features.typewriter,
    autoTitle: features.autoTitle,
    reduceMotion: features.reduceMotion,
    showLatency: features.showLatency,
    worldbook: features.worldbook,
    memory: features.memory,
    devMode: features.developerMode,
    confirm: cfg.confirm ?? flags.confirm,
    budget: {
      context: cfg.contextWindow || flags.budget.context,
      pct: Number.isFinite(cfg.budgetPct) ? cfg.budgetPct : flags.budget.pct,
      trigger: Number.isFinite(cfg.triggerBudget) ? cfg.triggerBudget : flags.budget.trigger,
    },
  });
}

function currentRoute(): Route {
  const raw = $<HTMLInputElement>("#base-url").value;
  const detected = detectRoute(raw);
  if (detected) return detected;
  return {
    kind: wire,
    shape: wire === "openai" ? shape : "chat",
    baseUrl: raw.trim().replace(/\/+$/, "") || defaultBaseUrl(wire),
  };
}

/**
 * Fields the user edited while the dialog was open. Anything absent keeps the
 * last saved value, so a switch or theme change never overwrites the endpoint
 * with inputs that were never filled in.
 */
const configTouched = new Set<"endpoint" | "model" | "apiKey" | "prompt" | "reasoning">();

function readConfigForm(): Config {
  const route = currentRoute();
  const endpoint = configTouched.has("endpoint");
  return {
    kind: endpoint ? route.kind : config.kind,
    shape: endpoint ? route.shape : config.shape,
    baseUrl: endpoint ? route.baseUrl : config.baseUrl,
    model: configTouched.has("model")
      ? $<HTMLInputElement>("#model-id").value.trim()
      : config.model,
    apiKey: configTouched.has("apiKey")
      ? $<HTMLInputElement>("#api-key").value.trim()
      : config.apiKey,
    theme: currentChoice(),
    prompt: configTouched.has("prompt")
      ? $<HTMLTextAreaElement>("#prompt").value.trim()
      : config.prompt,
    reasoning: configTouched.has("reasoning") ? readReasoning() : config.reasoning,
    contextWindow: flags.budget.context,
    budgetPct: flags.budget.pct,
    triggerBudget: flags.budget.trigger,
    confirm: flags.confirm,
    features: featuresFromFlags(flags),
  };
}

/** Keeps an unknown thinking level on "off", the value Go also falls back to. */
function normalizeReasoning(value: string | undefined): string {
  return value === "low" || value === "medium" || value === "high" ? value : "off";
}

/** Reads the thinking-level select for the next save. */
function readReasoning(): string {
  return normalizeReasoning($<HTMLSelectElement>("#reasoning").value);
}

async function saveConfig(reason: ConfigReason): Promise<void> {
  window.clearTimeout(configTimer);
  configTimer = undefined;

  const payload = readConfigForm();
  config = payload;
  setSaveState("saving");

  try {
    await Settings.save(payload);
    markSaved();
    announce<Config & { reason: ConfigReason }>("applecos:config", { ...payload, reason });
  } catch (error) {
    setSaveState("error", `保存失败：${String(error)}`);
  }
}

function scheduleConfigSave(reason: ConfigReason, delay = 400): void {
  window.clearTimeout(configTimer);
  configTimer = window.setTimeout(() => void saveConfig(reason), delay);
}

/** Writes a pending debounced change now, used before quitting or unloading. */
export async function flushConfig(): Promise<void> {
  if (configTimer === undefined) return;
  await saveConfig("manual");
}

/* -------------------------------------------------------------------------
   Model list
   ------------------------------------------------------------------------- */

function modelsUrl(kind: Wire, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (kind === "anthropic") {
    return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  }
  return `${base}/models`;
}

/** Asks the endpoint for its model ids, through the Go side so no CORS applies. */
export async function listModels(
  kind: Wire,
  baseUrl: string,
  apiKey: string,
): Promise<ModelEntry[]> {
  if (!baseUrl.trim()) throw new Error("先填写接口地址");
  const headers: Record<string, string> =
    kind === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${apiKey}` };

  const response = await goFetch(modelsUrl(kind, baseUrl), { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 160)}`);

  const payload = JSON.parse(text) as {
    data?: { id?: string; display_name?: string; displayName?: string }[];
  };
  return (payload.data ?? [])
    .map((entry) => {
      const id = entry.id ?? "";
      return { id, label: entry.display_name ?? entry.displayName ?? id };
    })
    .filter((entry) => entry.id !== "");
}

function renderModels(list: ModelEntry[]): void {
  const root = $("#model-list");
  const current = $<HTMLInputElement>("#model-id").value;
  root.replaceChildren(
    ...list.map((entry, index) => {
      const item = document.createElement("li");
      item.style.setProperty("--i", String(index));
      const button = document.createElement("button");
      button.type = "button";
      button.className = entry.id === current ? "model-item selected" : "model-item";
      button.textContent = entry.label;
      button.title = entry.id;
      button.addEventListener("click", () => {
        $<HTMLInputElement>("#model-id").value = entry.id;
        configTouched.add("model");
        for (const other of root.querySelectorAll(".model-item")) {
          other.classList.toggle("selected", other === button);
        }
        scheduleConfigSave("endpoint", 200);
      });
      item.append(button);
      return item;
    }),
  );
}

async function loadModels(): Promise<void> {
  const button = $<HTMLButtonElement>("#fetch-models");
  const status = $("#model-status");
  button.disabled = true;
  status.dataset.state = "busy";
  status.textContent = "正在获取…";
  try {
    const route = currentRoute();
    const list = await listModels(route.kind, route.baseUrl, $<HTMLInputElement>("#api-key").value);
    renderModels(list);
    status.dataset.state = "ok";
    status.textContent = list.length ? `${list.length} 个模型` : "接口没有返回模型";
  } catch (error) {
    status.dataset.state = "error";
    status.textContent = `获取失败：${String(error)}`;
  } finally {
    button.disabled = false;
  }
}

/* -------------------------------------------------------------------------
   Settings dialog
   ------------------------------------------------------------------------- */

type Pane = "appearance" | "world" | "model" | "persona" | "about";

const PANE_TITLES: Record<Pane, string> = {
  appearance: "外观",
  world: "世界",
  model: "模型",
  persona: "人格",
  about: "关于",
};

let bound = false;
let activePane: Pane = "appearance";

function showPane(pane: Pane): void {
  activePane = pane;
  for (const button of $$<HTMLButtonElement>(".nav-item")) {
    button.classList.toggle("selected", button.dataset.pane === pane);
  }
  for (const section of $$<HTMLElement>(".pane")) {
    const active = section.dataset.pane === pane;
    section.classList.toggle("active", active);
    if (active) {
      section.classList.remove("enter");
      void section.offsetWidth;
      section.classList.add("enter");
    }
  }
  const title = document.getElementById("pane-title");
  if (title) title.textContent = PANE_TITLES[pane];
}

function setWire(kind: Wire): void {
  wire = kind;
  const row = $("#wire");
  row.dataset.wire = kind;
  for (const button of row.querySelectorAll<HTMLButtonElement>(".wire-option")) {
    button.classList.toggle("selected", button.dataset.wire === kind);
  }
  const shapeRow = $("#shape");
  shapeRow.hidden = kind === "anthropic";
  $<HTMLInputElement>("#base-url").placeholder =
    kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
}

function setShape(next: Shape): void {
  shape = next;
  const row = $("#shape");
  row.dataset.shape = next;
  for (const button of row.querySelectorAll<HTMLButtonElement>(".shape-option")) {
    button.classList.toggle("selected", button.dataset.shape === next);
  }
}

function renderThemeCards(choice: ThemeChoice): void {
  for (const card of $$<HTMLButtonElement>(".theme-card")) {
    card.classList.toggle("selected", card.dataset.themeChoice === choice);
  }
  const note = document.getElementById("system-theme-note");
  if (note) note.textContent = `当前：${themeMeta(resolvePalette("system")).name}`;
  const about = document.getElementById("about-theme");
  if (about) about.textContent = themeMeta(resolvePalette(choice)).name;
}

function applyFlags(): void {
  const root = document.documentElement;
  root.dataset.flagWorld = flags.worldPanel ? "on" : "off";
  root.dataset.flagClock = flags.worldClock ? "on" : "off";
  root.dataset.flagScript = flags.scriptMode ? "on" : "off";
  root.dataset.flagMotion = flags.reduceMotion ? "on" : "off";
  root.dataset.flagDev = flags.devMode ? "on" : "off";
  root.dataset.flagTypewriter = flags.typewriter ? "on" : "off";
  // Turning the world panel off also drops its tab; the active pane falls back.
  activateRailTab(railTab, false);
}

function persistFlags(): void {
  applyFlags();
  announce<Flags>("applecos:flags", readFlags());
  // Features and budgets live in the Go config, so mirror them there too.
  scheduleConfigSave("manual", 300);
}

type BoolFlag = {
  [K in keyof Flags]: Flags[K] extends boolean ? K : never;
}[keyof Flags];

const FLAG_ELEMENTS: { element: string; flag: BoolFlag }[] = [
  { element: "#flag-world", flag: "worldPanel" },
  { element: "#flag-clock", flag: "worldClock" },
  { element: "#flag-script", flag: "scriptMode" },
  { element: "#flag-typewriter", flag: "typewriter" },
  { element: "#flag-autotitle", flag: "autoTitle" },
  { element: "#flag-motion", flag: "reduceMotion" },
  { element: "#flag-latency", flag: "showLatency" },
  { element: "#flag-worldbook", flag: "worldbook" },
  { element: "#flag-memory", flag: "memory" },
  { element: "#flag-confirm", flag: "confirm" },
  { element: "#flag-dev", flag: "devMode" },
];

function syncSwitches(): void {
  for (const { element, flag } of FLAG_ELEMENTS) {
    const node = document.querySelector<HTMLButtonElement>(element);
    if (node) node.setAttribute("aria-checked", String(flags[flag]));
  }
  const tools: [string, keyof ToolFlags][] = [
    ["#tool-dice", "dice"],
    ["#tool-time", "time"],
    ["#tool-scene", "scene"],
    ["#tool-lore", "lore"],
  ];
  for (const [element, key] of tools) {
    const node = document.querySelector<HTMLButtonElement>(element);
    if (node) node.setAttribute("aria-checked", String(flags.tools[key]));
  }
  const budgets: [string, keyof Budget][] = [
    ["#budget-context", "context"],
    ["#budget-pct", "pct"],
    ["#budget-trigger", "trigger"],
  ];
  for (const [element, key] of budgets) {
    const node = document.querySelector<HTMLInputElement>(element);
    if (node) node.value = String(flags.budget[key]);
  }
}

function bindSwitches(): void {
  for (const { element, flag } of FLAG_ELEMENTS) {
    const node = document.querySelector<HTMLButtonElement>(element);
    if (!node) continue;
    node.addEventListener("click", () => {
      flags = { ...flags, [flag]: !flags[flag] } as Flags;
      syncSwitches();
      persistFlags();
      markSaved();
    });
  }

  const tools: [string, keyof ToolFlags][] = [
    ["#tool-dice", "dice"],
    ["#tool-time", "time"],
    ["#tool-scene", "scene"],
    ["#tool-lore", "lore"],
  ];
  for (const [element, key] of tools) {
    const node = document.querySelector<HTMLButtonElement>(element);
    if (!node) continue;
    node.addEventListener("click", () => {
      flags = {
        ...flags,
        tools: { ...flags.tools, [key]: !flags.tools[key] } as ToolFlags,
      };
      syncSwitches();
      persistFlags();
      markSaved();
    });
  }

  const budgets: [string, keyof Budget, number, number][] = [
    ["#budget-context", "context", 2000, 200000],
    ["#budget-pct", "pct", 0, 50],
    ["#budget-trigger", "trigger", 0, 16000],
  ];
  for (const [element, key, min, max] of budgets) {
    const node = document.querySelector<HTMLInputElement>(element);
    if (!node) continue;
    node.addEventListener("change", () => {
      const parsed = Number.parseInt(node.value, 10);
      const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : flags.budget[key];
      node.value = String(next);
      flags = {
        ...flags,
        budget: { ...flags.budget, [key]: next } as Budget,
      };
      persistFlags();
      markSaved();
    });
  }
}

function renderWorldPanel(): void {
  const playerName = world.playerName || DEFAULT_PLAYER_NAME;
  const playerRow = document.getElementById("player-name");
  if (playerRow) playerRow.textContent = "当前：" + playerName;
  const railPlayer = document.getElementById("rail-player-name");
  if (railPlayer) railPlayer.textContent = playerName;
  $("#world-name").textContent = world.name;
  $("#world-sub").textContent = world.tagline;
  $("#world-place").textContent = world.place || "—";
  $("#world-weather").textContent = world.weather || "—";
  $("#clock-day").textContent = `第 ${world.dayIndex} 日`;
  $("#clock-time").textContent = world.clock;
  $("#world-lore").textContent = world.loreHits.length ? `${world.loreHits.length} 条命中` : "未命中";

  const cast = $("#world-cast");
  cast.replaceChildren(...world.cast.map(castCard));
  const castEmpty = document.getElementById("cast-empty");
  if (castEmpty) castEmpty.hidden = world.cast.length > 0;
}

/** Affection tiers; the thresholds match the prompt's behavior table. */
export function affinityTierLabel(value: number): string {
  if (value >= 70) return "亲近";
  if (value >= 30) return "友善";
  if (value >= -29) return "中立";
  if (value >= -69) return "疏离";
  return "敌意";
}

const METER_STEPS = 5;
/** Click targets behind the five bars: hostile, cold, neutral, warm, close. */
const METER_PRESETS = [-100, -50, 0, 50, 100];

/** Clamps an affection value into -100..100. */
function clampAffinity(value: number): number {
  return Math.max(-100, Math.min(100, Math.trunc(Number.isFinite(value) ? value : 0)));
}

/** Paints the meter: -100..100 maps linearly onto 0..5 lit bars. */
function paintMeter(meter: HTMLElement, value: number): void {
  const amount = clampAffinity(value);
  const filled = Math.round(((amount + 100) / 200) * METER_STEPS);
  // Lit bars follow the tier: hostile/cold red, neutral quiet, warm/close accent.
  const tone = amount < -29 ? " low" : amount < 30 ? " mid" : "";
  for (let index = 0; index < meter.children.length; index += 1) {
    const bar = meter.children[index] as HTMLElement;
    bar.className = index < filled ? "on" + tone : "";
  }
}

/** Writes one preset into the row before the host redraws it. */
function paintPreset(trust: HTMLElement, meter: HTMLElement, value: number): void {
  trust.textContent = String(value);
  paintMeter(meter, value);
}

/** Builds the meter; each bar is a preset that writes through the host. */
function castMeter(member: CastMember, trust: HTMLElement): HTMLElement {
  const meter = document.createElement("span");
  meter.className = "cast-meter";
  for (let index = 0; index < METER_STEPS; index += 1) {
    const preset = METER_PRESETS[index] ?? 0;
    const bar = document.createElement("i");
    if (member.id) {
      bar.setAttribute("role", "button");
      bar.tabIndex = 0;
      bar.title = preset + " 好感 · " + affinityTierLabel(preset);
      bar.setAttribute("aria-label", "好感 " + preset + "，档位 " + affinityTierLabel(preset));
      const apply = (event: Event) => {
        // Keep the card's own click from opening the editor underneath.
        event.stopPropagation();
        if (!member.id) return;
        const cardId = member.id;
        paintPreset(trust, meter, preset);
        announce("applecos:affinity", { cardId, value: preset });
      };
      bar.addEventListener("click", apply);
      bar.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          apply(event);
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.key === "ArrowRight" ? 1 : -1;
        (meter.children[index + step] as HTMLElement | undefined)?.focus();
      });
    }
    meter.append(bar);
  }
  paintMeter(meter, member.trust ?? 0);
  return meter;
}

/** One cast card: identity line plus a truncated situation line when present. */
function castCard(member: CastMember): HTMLElement {
  const card = document.createElement("article");
  card.className = "cast-card";

  const line = document.createElement("div");
  line.className = "cast-line";

  const dot = document.createElement("span");
  dot.className = "cast-dot";

  const name = document.createElement("span");
  name.className = "cast-name";
  name.textContent = member.name;
  line.append(dot, name);

  if (member.role) {
    const role = document.createElement("span");
    role.className = "cast-role";
    role.textContent = member.role;
    line.append(role);
  }

  if (typeof member.trust === "number") {
    const trust = document.createElement("span");
    trust.className = "cast-trust";
    trust.textContent = String(member.trust);
    line.append(castMeter(member, trust), trust);
  }

  card.append(line);

  // The row opens the card editor; the affinity slider keeps its own input.
  card.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest(".cast-tune")) return;
    if (!member.id) return;
    openEditor("character", member.id);
  });
  card.title = "点击编辑角色";

  const situation = member.situation?.trim();
  if (situation) {
    const where = document.createElement("p");
    where.className = "cast-where";
    where.textContent = situation;
    where.title = situation;
    card.append(where);
  }

  return card;
}

function persistWorld(): void {
  renderWorldPanel();
  announce<WorldState>("applecos:world", readWorld());
}

/* -------------------------------------------------------------------------
   Scene list
   ------------------------------------------------------------------------- */

function persistSessions(): void {
  // Sessions are owned by the runtime; the list is only a render cache.
}

function nextSessionIndex(): number {
  return sessions.reduce((max, session) => Math.max(max, session.index), 0) + 1;
}

function selectSession(id: string): void {
  if (handlers.sessions) {
    void handlers.sessions.select(id);
    return;
  }
  const session = sessions.find((item) => item.id === id);
  if (!session) return;
  activeSessionId = id;
  if (session.state === "unread") session.state = "idle";
  persistSessions();
  renderSessions();
  announce<SessionMeta>("applecos:session-select", session);
}

function createSession(): void {
  if (handlers.sessions) {
    void handlers.sessions.create();
    return;
  }
  const index = nextSessionIndex();
  const session: SessionMeta = {
    id: `scene-${Date.now().toString(36)}`,
    index,
    title: `第 ${String(index).padStart(2, "0")} 场 · 未命名`,
    scene: world.place === "—" ? "未命名场景" : world.place,
    dayIndex: world.dayIndex,
    clock: world.clock,
    preview: "还没有台词",
    updatedAt: Date.now(),
    state: "idle",
  };
  sessions = [session, ...sessions];
  activeSessionId = session.id;
  persistSessions();
  renderSessions();
  announce<SessionMeta>("applecos:session-new", session);
  markSaved();
}

function renameSession(id: string, title: string): void {
  const trimmed = title.trim();
  if (!trimmed) return;
  if (handlers.sessions) {
    void handlers.sessions.rename(id, trimmed);
    return;
  }
  sessions = sessions.map((session) => (session.id === id ? { ...session, title: trimmed } : session));
  persistSessions();
  renderSessions();
  const renamed = sessions.find((session) => session.id === id);
  if (renamed) announce<SessionMeta>("applecos:session-rename", renamed);
  markSaved();
}

function deleteSession(id: string): void {
  if (handlers.sessions) {
    void handlers.sessions.remove(id);
    return;
  }
  sessions = sessions.filter((session) => session.id !== id);
  if (activeSessionId === id) activeSessionId = sessions[0]?.id ?? "";
  persistSessions();
  renderSessions();
  announce<{ id: string }>("applecos:session-delete", { id });
  markSaved();
}

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

function sessionItem(session: SessionMeta): HTMLLIElement {
  const item = document.createElement("li");
  item.dataset.id = session.id;

  const button = document.createElement("button");
  button.type = "button";
  button.className = session.id === activeSessionId ? "session-item selected" : "session-item";
  button.dataset.state = session.state;
  button.setAttribute("aria-current", session.id === activeSessionId ? "true" : "false");

  const scene = document.createElement("span");
  scene.className = "session-scene";
  const index = document.createElement("span");
  index.className = "session-index";
  index.textContent = flags.worldClock ? String(session.index).padStart(2, "0") : "";
  const label = document.createElement("span");
  label.textContent = session.title || session.scene;
  scene.append(index, label);

  const time = document.createElement("span");
  time.className = "session-time";
  time.textContent = flags.worldClock ? `${session.clock}` : "";

  const preview = document.createElement("span");
  preview.className = "session-preview";
  preview.textContent = session.preview || "还没有台词";

  const tools = document.createElement("span");
  tools.className = "session-tools";

  const rename = document.createElement("button");
  rename.type = "button";
  rename.className = "session-tool";
  rename.setAttribute("aria-label", "重命名场次");
  rename.append(icon("M4 20h4l10-10-4-4L4 16v4zM14 6l4 4"));
  rename.addEventListener("click", (event) => {
    event.stopPropagation();
    startRename(item, session);
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "session-tool";
  remove.setAttribute("aria-label", "删除场次");
  remove.append(icon("M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"));
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    startDelete(item, session);
  });

  tools.append(rename, remove);
  button.append(scene, time, preview, tools);
  button.addEventListener("click", () => selectSession(session.id));
  item.append(button);
  return item;
}

function startRename(item: HTMLLIElement, session: SessionMeta): void {
  item.querySelector(".session-rename")?.remove();
  const input = document.createElement("input");
  input.className = "session-rename";
  input.value = session.title;
  input.setAttribute("aria-label", "场次标题");
  let settled = false;
  const commit = (): void => {
    if (settled) return;
    settled = true;
    renameSession(session.id, input.value);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      settled = true;
      input.remove();
    }
  });
  input.addEventListener("blur", commit);
  item.append(input);
  input.focus();
  input.select();
}

function startDelete(item: HTMLLIElement, session: SessionMeta): void {
  item.querySelector(".session-confirm")?.remove();
  const box = document.createElement("div");
  box.className = "session-confirm";

  const note = document.createElement("span");
  note.textContent = "删除这一场？";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "cancel";
  cancel.textContent = "取消";
  cancel.addEventListener("click", (event) => {
    event.stopPropagation();
    box.remove();
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "删除";
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteSession(session.id);
  });

  box.append(note, cancel, remove);
  item.append(box);
}

function renderSessions(): void {
  const list = document.getElementById("session-list");
  if (!list) return;
  const ordered = sessions.slice().sort((a, b) => b.index - a.index);
  list.replaceChildren(...ordered.map(sessionItem));
  const empty = document.getElementById("session-empty");
  if (empty) empty.hidden = sessions.length > 0;
}

/* -------------------------------------------------------------------------
   Rail tabs and the memory pane
   ------------------------------------------------------------------------- */

export type RailTab = "scenes" | "world" | "cast" | "memory";

/** One line of the rail memory pane, fed by the live session. */
export interface RailMemoryItem {
  tier: "world" | "cast" | "player";
  text: string;
  updatedAt?: number;
}

const RAIL_TAB_KEY = "applecos.railTab";
const RAIL_TABS: RailTab[] = ["scenes", "world", "cast", "memory"];
const RAIL_MEMORY_LIMIT = 8;

let railTab: RailTab = "scenes";
let railMemoryProvider: (() => RailMemoryItem[]) | null = null;

/** Connects the rail memory pane to the session memory; null falls back to the library cache. */
export function useRailMemory(provider: (() => RailMemoryItem[]) | null): void {
  railMemoryProvider = provider;
  renderRailMemory();
}

/** Footer numbers of the live session: turn, cast size, world clock. */
export interface RailStats {
  turn?: number;
  cast?: number;
  clock?: string;
}

let railStatsProvider: (() => RailStats) | null = null;

/** Connects the footer row to the live session; re-rendered on world updates. */
export function useRailStats(provider: (() => RailStats) | null): void {
  railStatsProvider = provider;
  renderRailStats();
}

/* -------------------------------------------------------------------------
   Affection: one card's value, shared by the rail meter and the card editor
   ------------------------------------------------------------------------- */

/** Reads and writes one card's affection; the host owns world, session and disk. */
export interface AffinityBridge {
  get(cardId: string): number;
  set(cardId: string, value: number): Promise<void>;
  label(value: number): string;
}

let affinityBridge: AffinityBridge | null = null;
let affinityRefresh: (() => void) | null = null;

/** Connects the character editor's affection block; the block re-reads on open. */
export function useAffinityEditor(provider: AffinityBridge | null): void {
  affinityBridge = provider;
  affinityRefresh?.();
}

/** Re-reads the affection of the open character form after a rail edit. */
function refreshAffinityEditor(): void {
  affinityRefresh?.();
}

/** Fills the footer row: status pill, then turn, then cast size or clock. */
function renderRailStats(): void {
  const row = document.querySelector<HTMLElement>(".rail-model-row");
  if (!row) return;
  let host = row.querySelector<HTMLElement>(".rail-stats");
  if (!host) {
    host = document.createElement("span");
    host.className = "rail-stats";
    row.append(host);
  }
  let stats: RailStats = {};
  if (railStatsProvider) {
    try {
      stats = railStatsProvider() ?? {};
    } catch {
      stats = {};
    }
  }
  const segments: HTMLElement[] = [];
  if (typeof stats.turn === "number" && stats.turn > 0) {
    const turn = document.createElement("span");
    turn.className = "rail-stat rail-stat-turn";
    turn.textContent = "第 " + stats.turn + " 轮";
    turn.title = "当前场次轮次";
    segments.push(turn);
  }
  const tail = document.createElement("span");
  tail.className = "rail-stat rail-stat-cast";
  if (typeof stats.cast === "number" && stats.cast > 0) {
    tail.textContent = stats.cast + " 人登场";
    tail.title = "已登场角色数";
  } else if (stats.clock) {
    tail.textContent = stats.clock;
    tail.title = "当前世界内时间";
  }
  if (tail.textContent) segments.push(tail);
  host.replaceChildren(...segments);
  host.hidden = segments.length === 0;
}

/* -------------------------------------------------------------------------
   Session usage panel: a quiet fold above the footer
   ------------------------------------------------------------------------- */

const NO_REPORT = "—";

let sessionStatsProvider: (() => SessionStats | null) | null = null;

/** Connects the usage panel to the live session; the numbers are read on open. */
export function useSessionStats(provider: (() => SessionStats | null) | null): void {
  sessionStatsProvider = provider;
  if (isStatsPanelOpen()) renderSessionStats();
}

function statsPanel(): HTMLElement | null {
  return document.getElementById("rail-stats-panel");
}

function statsToggle(): HTMLElement | null {
  return document.getElementById("rail-stats-toggle");
}

function isStatsPanelOpen(): boolean {
  const panel = statsPanel();
  return panel !== null && !panel.hidden;
}

/** Folds the panel away; the entry keeps the focus unless it is being closed. */
function closeSessionStats(returnFocus = false): void {
  const panel = statsPanel();
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  statsToggle()?.setAttribute("aria-expanded", "false");
  if (returnFocus) statsToggle()?.focus();
}

function toggleSessionStats(): void {
  const panel = statsPanel();
  if (!panel) return;
  if (!panel.hidden) {
    closeSessionStats();
    return;
  }
  renderSessionStats();
  panel.hidden = false;
  statsToggle()?.setAttribute("aria-expanded", "true");
}

function tokenText(value: number): string {
  return value.toLocaleString("zh-CN");
}

/** True once some token was reported; a silent endpoint keeps every row empty. */
function hasReportedUsage(stats: SessionStats): boolean {
  const { input, output, cacheRead, cacheWrite } = stats.cumulative;
  return input + output + cacheRead + cacheWrite > 0;
}

function statsGroup(title: string): HTMLElement {
  const box = document.createElement("section");
  box.className = "rail-stats-group";
  const head = document.createElement("p");
  head.className = "rail-stats-label";
  head.textContent = title;
  box.append(head);
  return box;
}

function statsRow(name: string, value: string, reported: boolean): HTMLElement {
  const row = document.createElement("p");
  row.className = "rail-stats-row";
  row.dataset.reported = reported ? "true" : "false";
  const key = document.createElement("span");
  key.textContent = name;
  const amount = document.createElement("span");
  amount.className = "rail-stats-value";
  amount.textContent = value;
  row.append(key, amount);
  return row;
}

function statsNote(text: string): HTMLElement {
  const note = document.createElement("p");
  note.className = "rail-stats-note";
  note.textContent = text;
  return note;
}

function cacheGroup(stats: SessionStats): HTMLElement {
  const box = statsGroup("缓存");
  const figure = document.createElement("p");
  figure.className = "rail-stats-figure";
  figure.textContent = stats.cacheHitRate === null ? "未上报" : Math.round(stats.cacheHitRate * 100) + "%";
  box.append(figure);
  const last = stats.lastTurn;
  box.append(
    statsRow(
      "本轮缓存读 / 写",
      last ? tokenText(last.cacheRead) + " / " + tokenText(last.cacheWrite) : NO_REPORT,
      last !== null,
    ),
  );
  box.append(statsNote("命中率 = 缓存读取 ÷（输入 + 缓存读取）"));
  return box;
}

function usageGroup(stats: SessionStats): HTMLElement {
  const box = statsGroup("用量");
  const reported = hasReportedUsage(stats);
  const cumulative = stats.cumulative;
  box.append(
    statsRow("累计输入", reported ? tokenText(cumulative.input) : NO_REPORT, reported),
    statsRow("累计输出", reported ? tokenText(cumulative.output) : NO_REPORT, reported),
    statsRow("累计缓存读取", reported ? tokenText(cumulative.cacheRead) : NO_REPORT, reported),
  );
  const last = stats.lastTurn;
  box.append(
    statsRow(
      "本轮输入 / 输出",
      last ? tokenText(last.input) + " / " + tokenText(last.output) : NO_REPORT,
      last !== null,
    ),
  );
  box.append(statsNote("共 " + stats.turns + " 轮"));
  return box;
}

function contextGroup(stats: SessionStats): HTMLElement {
  const box = statsGroup("上下文组成");
  const total = stats.contextTotalChars;
  for (const section of stats.context) {
    const row = document.createElement("div");
    row.className = "rail-stats-section";
    const name = document.createElement("span");
    name.className = "rail-stats-section-name";
    name.textContent = section.title;
    const tokens = document.createElement("span");
    tokens.className = "rail-stats-section-tokens";
    tokens.textContent = tokenText(section.tokens);
    const bar = document.createElement("span");
    bar.className = "rail-stats-section-bar";
    const fill = document.createElement("i");
    const share = total > 0 ? Math.min(1, section.chars / total) : 0;
    fill.style.width = (share * 100).toFixed(1) + "%";
    bar.append(fill);
    row.append(name, tokens, bar);
    box.append(row);
  }
  if (stats.context.length === 0) {
    box.append(statsNote("本轮还没有上下文分节。"));
    return box;
  }
  const sum = stats.context.reduce((running, section) => running + section.tokens, 0);
  box.append(statsNote("合计约 " + tokenText(sum) + " tokens（估算）"));
  return box;
}

/** Rebuilds the panel from the live session each time it opens. */
function renderSessionStats(): void {
  const panel = statsPanel();
  if (!panel) return;
  let stats: SessionStats | null = null;
  if (sessionStatsProvider) {
    try {
      stats = sessionStatsProvider();
    } catch {
      stats = null;
    }
  }

  const head = document.createElement("div");
  head.className = "rail-stats-head";
  const title = document.createElement("h2");
  title.className = "rail-stats-title";
  title.textContent = "本场用量";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "rail-stats-close";
  close.setAttribute("aria-label", "收起用量");
  close.textContent = "✕";
  close.addEventListener("click", () => closeSessionStats(true));
  head.append(title, close);

  const body = document.createElement("div");
  body.className = "rail-stats-body";
  if (!stats) {
    body.append(statsNote("这场戏还没有用量记录。"));
  } else {
    body.append(cacheGroup(stats), usageGroup(stats), contextGroup(stats));
  }
  panel.replaceChildren(head, body);
}

function readRailTab(): RailTab {
  let saved = "";
  try {
    saved = localStorage.getItem(RAIL_TAB_KEY) ?? "";
  } catch {
    saved = "";
  }
  const tab = RAIL_TABS.includes(saved as RailTab) ? (saved as RailTab) : "scenes";
  // The world pane has no tab while its flag is off.
  if (tab === "world" && !flags.worldPanel) return "scenes";
  return tab;
}

function activateRailTab(tab: RailTab, persist = true): void {
  if (!document.querySelector("[data-rail-pane]")) return;
  const next: RailTab = tab === "world" && !flags.worldPanel ? "scenes" : tab;
  railTab = next;
  for (const button of $$<HTMLButtonElement>("[data-rail-tab]")) {
    const selected = button.dataset.railTab === next;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const pane of $$<HTMLElement>("[data-rail-pane]")) {
    const active = pane.dataset.railPane === next;
    pane.hidden = !active;
    if (active) pane.scrollTop = 0;
  }
  if (next === "world" || next === "cast") renderWorldPanel();
  if (next === "memory") renderRailMemory();
  if (persist) {
    try {
      localStorage.setItem(RAIL_TAB_KEY, next);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
  }
}

/** Recent memory lines, newest first, capped at eight. */
function railMemoryItems(): RailMemoryItem[] {
  if (railMemoryProvider) {
    try {
      return railMemoryProvider() ?? [];
    } catch {
      return [];
    }
  }
  return library.memory.map((entry) => ({
    tier: "world" as const,
    text: entry.body ? entry.title + "：" + entry.body : entry.title,
    updatedAt: entry.updatedAt,
  }));
}

function renderRailMemory(): void {
  const host = document.getElementById("rail-memory-list");
  if (!host) return;
  const recent = railMemoryItems()
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, RAIL_MEMORY_LIMIT);

  const groups: { label: string; items: RailMemoryItem[] }[] = [
    { label: "世界", items: recent.filter((item) => item.tier !== "cast") },
    { label: "角色", items: recent.filter((item) => item.tier === "cast") },
  ];

  host.replaceChildren(
    ...groups
      .filter((group) => group.items.length > 0)
      .map((group) => {
        const block = document.createElement("div");
        block.className = "rail-memory-group";

        const head = document.createElement("h3");
        head.className = "rail-memory-head";
        head.textContent = group.label;
        block.append(head);

        for (const item of group.items) {
          const line = document.createElement("p");
          line.className = "rail-memory-line";
          line.textContent = item.text;
          line.title = item.text;
          block.append(line);
        }
        return block;
      }),
  );

  const empty = document.getElementById("rail-memory-empty");
  if (empty) empty.hidden = recent.length > 0;
}

/* -------------------------------------------------------------------------
   World clock
   ------------------------------------------------------------------------- */

function shiftClock(minutes: number, phase?: string): void {
  if (handlers.clock) {
    void handlers.clock.set(minutes, phase);
    return;
  }
  if (phase === "dusk") {
    world = { ...world, clock: "18:30" };
  } else if (phase === "night") {
    world = { ...world, clock: "22:00" };
  } else if (minutes > 0) {
    const [hourText, minuteText] = world.clock.split(":");
    const base = (Number.parseInt(hourText ?? "0", 10) * 60 + Number.parseInt(minuteText ?? "0", 10) + minutes) % 1440;
    const hour = Math.floor(base / 60);
    const minute = base % 60;
    world = {
      ...world,
      clock: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      weather: hour >= 19 || hour < 5 ? "夜" : hour >= 17 ? "黄昏" : "白昼",
    };
  }
  persistWorld();
  markSaved();
}

/* -------------------------------------------------------------------------
   Editor
   ------------------------------------------------------------------------- */

let editorKind: EditorKind = "world";
let editorId = "";
let editorMode: "list" | "form" = "list";

function entryDefaults(kind: EditorKind): Entry {
  return { id: "", kind, title: "", body: "", tags: [], extra: {}, updatedAt: Date.now() };
}

function findEntry(kind: EditorKind, id: string): Entry | undefined {
  return library[kind].find((entry) => entry.id === id);
}

function editorTitle(kind: EditorKind, entry?: Entry): string {
  if (!entry) return `新${KIND_META[kind].noun}`;
  return entry.title || `未命名${KIND_META[kind].noun}`;
}

function setEditorStatus(message: string, error = false): void {
  const node = document.getElementById("editor-status");
  if (!node) return;
  node.textContent = message;
  node.dataset.state = error ? "error" : message ? "ok" : "idle";
}

function renderEditorIfOpen(): void {
  const dialog = document.getElementById("editor") as HTMLDialogElement | null;
  if (!dialog?.open) return;
  if (editorMode === "list") {
    openEditorList(editorKind);
    return;
  }
  if (!findEntry(editorKind, editorId)) openEditorList(editorKind);
}

let loreManager: LorebookManager | null = null;

/** Unmounts the world book manager and restores the plain editor layout. */
function teardownLoreManager(): void {
  if (loreManager) {
    loreManager.destroy();
    loreManager = null;
  }
  const dialog = document.getElementById("editor");
  if (dialog) dialog.classList.remove("lore-mode");
  const manager = document.getElementById("lore-manager");
  if (manager) manager.hidden = true;
  const form = document.getElementById("editor-form");
  if (form) form.hidden = false;
}

/** Hides the plain form and mounts the entry manager in its place. */
function mountLoreEditor(id: string): void {
  const dialog = document.getElementById("editor");
  if (dialog) dialog.classList.add("lore-mode");
  const form = document.getElementById("editor-form");
  if (form) form.hidden = true;
  const manager = document.getElementById("lore-manager");
  if (!manager) return;
  manager.hidden = false;
  const created = mountLorebookManager(manager, {
    id,
    onStatus: (message, error = false) => setEditorStatus(message, error),
    onDirty: () => setEditorStatus("有未保存的改动，点“保存并返回”写入资料库。"),
    worldbookEnabled: () => readFlags().worldbook,
  });
  loreManager = created;
  void created.ready.then(() => {
    const name = created.document()?.name ?? "";
    if (!name) return;
    const title = document.getElementById("editor-title");
    if (title) title.textContent = name;
    const input = document.querySelector<HTMLInputElement>('#editor-form [data-field="title"]');
    if (input) input.value = name;
  });
}

function editorButton(label: string, action: () => void | Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.textContent = label;
  button.addEventListener("click", () => void action());
  return button;
}

function openEditor(kind: EditorKind, id?: string): void {
  if (kind === "player") {
    void openPlayerEditor();
    return;
  }
  editorKind = kind;
  const dialog = $<HTMLDialogElement>("#editor");
  if (kind === "world") {
    const target = id ?? activeWorldId ?? library.world[0]?.id ?? "";
    if (target && findEntry("world", target)) openEditorForm("world", target);
    else openEditorList("world");
  } else if (id) {
    openEditorForm(kind, id);
  } else {
    openEditorList(kind);
  }
  if (!dialog.open) dialog.showModal();
  if (library[kind].length === 0) void refreshLibrary();
}

/**
 * Opens the player card of the active world through the shared editor. The card
 * lives in the world file, so it is read fresh every time the editor opens.
 */
async function openPlayerEditor(): Promise<void> {
  const dialog = $<HTMLDialogElement>("#editor");
  editorKind = "player";
  if (!dialog.open) dialog.showModal();
  const worldId = activeWorldId || library.world[0]?.id || "";
  if (!worldId) {
    // The card is stored in the world file, so one must exist first.
    $("#editor-form").replaceChildren();
    $("#editor-kind").textContent = KIND_META.player.label;
    $("#editor-title").textContent = KIND_META.player.label;
    setEditorStatus("先在世界页新建或载入一个世界，玩家角色保存在世界里。", true);
    return;
  }
  setEditorStatus("正在读取玩家角色…");
  try {
    const entry = await loadPlayerEntry(worldId);
    library = { ...library, player: [entry] };
    openEditorForm("player", entry.id);
  } catch (error) {
    setEditorStatus("读取玩家角色失败：" + String(error), true);
  }
}

async function runImport(
  kind: EditorKind,
  action: () => Promise<{ id: string; name: string } | null>,
): Promise<void> {
  setEditorStatus("正在导入…");
  try {
    const result = await action();
    if (!result) {
      setEditorStatus("已取消导入");
      return;
    }
    await refreshLibrary();
    if (findEntry(kind, result.id)) openEditorForm(kind, result.id);
    else openEditorList(kind);
    setEditorStatus("已导入：" + result.name);
  } catch (error) {
    setEditorStatus("导入失败：" + String(error), true);
  }
}

async function runExport(label: string, action: () => Promise<string>): Promise<void> {
  setEditorStatus("正在导出…");
  try {
    const path = await action();
    setEditorStatus(path ? "已导出到 " + path : "已取消导出");
  } catch (error) {
    setEditorStatus("导出失败：" + String(error), true);
  }
}

function appendEditorTools(host: HTMLElement, kind: EditorKind, id: string): void {
  // Memory and the player card have no import or export of their own.
  if (kind === "memory" || kind === "player") return;
  const row = document.createElement("div");
  row.className = "editor-tools";
  // The lore form hides itself; its tools live in the book bar instead.
  const target =
    kind === "lore" ? document.getElementById("lore-book-settings") ?? host : host;
  if (kind === "character") {
    row.append(editorButton("导出角色卡", () => runExport("导出角色卡", () => exportCardFile(id))));
    row.append(
      editorButton("加入当前世界", () => {
        document.dispatchEvent(new CustomEvent("applecos:card-add", { detail: { id } }));
        setEditorStatus("已请求加入当前世界");
      }),
    );
  } else if (kind === "lore") {
    row.append(editorButton("导出世界书", () => runExport("导出世界书", () => exportLorebookFile(id))));
    row.append(
      editorButton("导出所选条目", () => {
        if (!loreManager) {
          setEditorStatus("世界书还没有载入", true);
          return;
        }
        void loreManager.exportSelected();
      }),
    );
    row.append(
      editorButton("合并导入", () => {
        if (!loreManager) {
          setEditorStatus("世界书还没有载入", true);
          return;
        }
        void loreManager.mergeImport();
      }),
    );
  } else if (kind === "world") {
    row.append(editorButton("导出世界", () => runExport("导出世界", () => exportWorldFile(id))));
  }
  host.append(row);
}

let deleteArmed = false;
let deleteTimer: number | undefined;

function resetDeleteArm(): void {
  deleteArmed = false;
  window.clearTimeout(deleteTimer);
  const button = document.getElementById("editor-delete");
  if (button) button.textContent = "删除";
}

function requestDelete(): void {
  if (!flags.confirm) {
    void deleteEditorEntry();
    return;
  }
  if (!deleteArmed) {
    deleteArmed = true;
    const button = $<HTMLButtonElement>("#editor-delete");
    button.textContent = "再点一次确认删除";
    setEditorStatus("再次点击删除，文件会移入回收站。");
    deleteTimer = window.setTimeout(() => resetDeleteArm(), 4000);
    return;
  }
  resetDeleteArm();
  void deleteEditorEntry();
}

function openEditorList(kind: EditorKind): void {
  // There is only ever one player card, so it never gets a list.
  if (kind === "player") {
    void openPlayerEditor();
    return;
  }
  teardownLoreManager();
  editorKind = kind;
  editorId = "";
  editorMode = "list";
  resetDeleteArm();

  $("#editor-kind").textContent = KIND_META[kind].label;
  $("#editor-title").textContent = `${KIND_META[kind].label} · ${library[kind].length} 条`;
  $<HTMLButtonElement>("#editor-delete").hidden = true;
  $<HTMLButtonElement>("#editor-back").textContent = "关闭";

  const host = $("#editor-form");
  host.replaceChildren();
  // A detached block must not keep refreshing itself.
  affinityRefresh = null;

  const tools = document.createElement("div");
  tools.className = "editor-tools";
  tools.append(
    editorButton(`新建${KIND_META[kind].noun}`, () => {
      const entry = entryDefaults(kind);
      entry.id = `${kind}-${Date.now().toString(36)}`;
      library = { ...library, [kind]: [...library[kind], entry] };
      openEditorForm(kind, entry.id);
    }),
  );
  if (kind === "character") {
    tools.append(editorButton("导入角色卡", () => runImport("character", importCardFile)));
  } else if (kind === "lore") {
    tools.append(editorButton("导入世界书 JSON", () => runImport("lore", importLorebookFile)));
  }
  host.append(tools);

  const list = document.createElement("ul");
  list.className = "model-list";
  list.style.maxHeight = "none";
  if (library[kind].length === 0) {
    const note = document.createElement("p");
    note.className = "editor-note";
    note.textContent = `还没有${KIND_META[kind].noun}。新建或导入一条，保存后会写进本机资料库。`;
    host.append(list, note);
  } else {
    for (const entry of library[kind]) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-item";
      button.textContent = editorTitle(kind, entry);
      button.addEventListener("click", () => openEditorForm(kind, entry.id));
      item.append(button);
      list.append(item);
    }
    host.append(list);
  }

  updateInjectPreview();
  refreshLibraryCounts();
}

/** Ticks under the editor slider; they mirror the prompt's tier thresholds. */
const AFFINITY_TICKS: string[] = ["-100 敌意", "-30 疏离", "0 中立", "+30 友善", "+70 亲近"];

/** Affection block inside the character form; every change writes to the host. */
function appendAffinityEditor(host: HTMLElement, cardId: string): void {
  const bridge = affinityBridge;
  const section = document.createElement("section");
  section.className = "affinity-field";

  const head = document.createElement("div");
  head.className = "affinity-head";
  const title = document.createElement("span");
  title.className = "affinity-title";
  title.textContent = "好感度";
  const readout = document.createElement("span");
  readout.className = "affinity-readout";
  head.append(title, readout);

  const input = document.createElement("input");
  input.type = "range";
  input.className = "affinity-range";
  input.min = "-100";
  input.max = "100";
  input.step = "5";
  input.setAttribute("aria-label", "好感度");

  const hint = document.createElement("p");
  hint.className = "affinity-hint";
  hint.textContent = "调整后立即生效，下一轮对话据此改变角色语气与行动";

  const scale = document.createElement("div");
  scale.className = "affinity-scale";
  for (const text of AFFINITY_TICKS) {
    const tick = document.createElement("span");
    tick.textContent = text;
    scale.append(tick);
  }

  const warn = document.createElement("p");
  warn.className = "affinity-warn";
  warn.hidden = true;
  warn.textContent = "该角色尚未加入当前世界，好感未保存；先在角色列表里「加入当前世界」再调整。";

  let value = 0;
  let timer: number | undefined;

  const render = (next: number): void => {
    value = clampAffinity(next);
    if (input.value !== String(value)) input.value = String(value);
    const label = bridge ? bridge.label(value) : affinityTierLabel(value);
    readout.textContent = (value > 0 ? "+" + value : String(value)) + " · " + label;
  };

  const read = (): number => {
    if (!bridge) return 0;
    try {
      return clampAffinity(bridge.get(cardId));
    } catch {
      return 0;
    }
  };

  const write = async (): Promise<void> => {
    window.clearTimeout(timer);
    timer = undefined;
    if (!bridge || !section.isConnected) return;
    try {
      await bridge.set(cardId, value);
      warn.hidden = true;
    } catch {
      warn.hidden = false;
    }
    // The host clamps and may reject; the display follows the source of truth.
    render(read());
  };

  // Dragging coalesces into one write; a commit writes at once.
  input.addEventListener("input", () => {
    render(Number(input.value));
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void write(), 160);
  });
  input.addEventListener("change", () => void write());

  affinityRefresh = () => render(read());
  render(read());

  section.append(head, input, hint, scale, warn);
  host.append(section);
}

function openEditorForm(kind: EditorKind, id: string): void {
  const entry = findEntry(kind, id);
  if (!entry) {
    openEditorList(kind);
    return;
  }
  teardownLoreManager();
  editorKind = kind;
  editorId = id;
  editorMode = "form";

  $("#editor-kind").textContent = KIND_META[kind].label;
  $("#editor-title").textContent = editorTitle(kind, entry);
  $("#editor-delete").hidden = kind === "player";
  $("#editor-back").textContent =
    kind === "world" || kind === "player" ? "关闭" : "返回列表";
  resetDeleteArm();

  const host = $("#editor-form");
  host.replaceChildren();
  // A detached block must not keep refreshing itself.
  affinityRefresh = null;

  for (const field of EDITOR_FIELDS[kind]) {
    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = field.label;

    const value =
      field.key === "title"
        ? entry.title
        : field.key === "body"
          ? entry.body
          : field.key === "tags"
            ? entry.tags.join(", ")
            : (entry.extra[field.key] ?? "");

    if (field.kind === "area") {
      const input = document.createElement("textarea");
      input.className = "field";
      input.rows = field.rows ?? 6;
      input.value = value;
      input.placeholder = field.placeholder ?? "";
      input.spellcheck = false;
      input.dataset.field = field.key;
      input.addEventListener("input", updateInjectPreview);
      label.append(input);
    } else {
      const input = document.createElement("input");
      input.className = "field";
      input.type = field.kind === "number" ? "number" : "text";
      input.value = value;
      input.placeholder = field.placeholder ?? "";
      input.autocomplete = "off";
      if (field.kind === "number") {
        input.min = "1";
        input.max = "5";
      }
      input.dataset.field = field.key;
      input.addEventListener("input", updateInjectPreview);
      label.append(input);
    }
    host.append(label);
  }

  // The affection block belongs to characters only; it writes through the host.
  if (kind === "character") appendAffinityEditor(host, id);

  const note = document.createElement("p");
  note.className = "editor-note";
  note.textContent =
    kind === "world"
      ? "保存后写入世界 JSON；若这是当前世界，侧栏抬头与开场地点会立即更新。"
      : kind === "character"
        ? "保存后写入角色卡文件；导入的卡同样可以在这里修改，或加入当前世界。"
        : kind === "lore"
          ? "条目在下方管理器里改；保存一次写入整本世界书，SillyTavern 字段原样保留。"
          : kind === "player"
            ? "名字用于对话署名与提示词；身份描述写「我是谁」；行为要求写希望 AI 如何对待你。保存后立即生效。"
            : "记忆随当前会话保存，会参与之后每一轮的提示词拼装。";
  host.append(note);
  if (kind === "lore") mountLoreEditor(id);
  appendEditorTools(host, kind, id);

  setEditorStatus("");
  updateInjectPreview();
}

function readEditorValues(): Entry {
  const existing = findEntry(editorKind, editorId);
  const entry: Entry = existing
    ? { ...existing, tags: existing.tags.slice(), extra: { ...existing.extra } }
    : entryDefaults(editorKind);
  entry.kind = editorKind;

  for (const field of EDITOR_FIELDS[editorKind]) {
    const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `#editor-form [data-field="${field.key}"]`,
    );
    const raw = node?.value ?? "";
    if (field.key === "title") entry.title = raw.trim();
    else if (field.key === "body") entry.body = raw;
    else if (field.key === "tags") {
      entry.tags = raw
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
    } else {
      entry.extra[field.key] = raw.trim();
    }
  }
  entry.updatedAt = Date.now();
  return entry;
}

function buildInjection(entry: Entry): string {
  const weight = entry.extra.weight ? Number.parseInt(entry.extra.weight, 10) : 0;
  switch (entry.kind) {
    case "world": {
      const lines = [`# 世界设定 · ${entry.title || "未命名"}`];
      if (entry.extra.era) lines.push(`时代：${entry.extra.era}`);
      if (entry.extra.place) lines.push(`开场地点：${entry.extra.place}`);
      lines.push("", entry.body || "（还没有写设定正文）");
      return lines.join("\n");
    }
    case "character": {
      const lines = [`# 角色卡 · ${entry.title || "未命名"}`];
      if (entry.extra.relation) lines.push(`处境或关系：${entry.extra.relation}`);
      if (entry.tags.length) lines.push(`关键词：${entry.tags.join("、")}`);
      lines.push("", entry.body || "（还没有写外貌与口吻）");
      return lines.join("\n");
    }
    case "lore": {
      const lines = [`[世界书] ${entry.title || "未命名"}`];
      lines.push("", entry.body || "（还没有写世界书条目）");
      return lines.join("\n");
    }
    case "memory": {
      const lines = [`[记忆] ${entry.title || "未命名"}`];
      if (weight > 0) lines.push(`重要度：${Math.min(5, Math.max(1, weight))} / 5`);
      lines.push("", entry.body || "（还没有写细节）");
      return lines.join("\n");
    }
    case "player": {
      // Mirrors the player section prompt.ts assembles.
      const persona = (entry.extra.persona ?? "").trim();
      const lines = [`## 玩家\n名字：${entry.title.trim() || DEFAULT_PLAYER_NAME}`];
      if (entry.body.trim()) lines.push(`身份：${entry.body.trim()}`);
      if (persona) lines.push(`行为要求：${persona}`);
      return lines.join("\n");
    }
  }
}

function updateInjectPreview(): void {
  const preview = document.getElementById("inject-preview");
  const meta = document.getElementById("editor-preview-meta");
  if (!preview) return;

  if (editorMode === "list") {
    const count = library[editorKind].length;
    preview.textContent = `${KIND_META[editorKind].label}共 ${count} 条。
选择一条编辑，右侧会显示它将如何进入上下文。`;
    if (meta) meta.textContent = `${count} 条`;
    return;
  }

  const entry = readEditorValues();
  preview.textContent = buildInjection(entry);
  if (meta) meta.textContent = `${buildInjection(entry).length} 字`;
}

async function saveEditorEntry(): Promise<void> {
  const entry = readEditorValues();
  if (!entry.id) entry.id = `${editorKind}-${Date.now().toString(36)}`;
  setEditorStatus("正在保存…");
  try {
    if (entry.kind === "lore") {
      await saveLoreEditorEntry();
      return;
    }
    if (entry.kind === "memory") {
      if (!memoryStore) throw new Error("记忆随会话保存，当前没有打开的会话");
      await memoryStore.save(entry);
      library = { ...library, memory: memoryStore.list() };
      refreshLibraryCounts();
      markSaved();
      setEditorStatus("已保存");
      openEditorList(editorKind);
      return;
    }
    const saved = await saveLibraryEntry(entry);
    await refreshLibrary();
    if (editorKind === "player") library = { ...library, player: [saved] };
    announce<{ kind: EditorKind; id: string; action: "save" }>("applecos:library-edit", {
      kind: editorKind,
      id: saved.id,
      action: "save",
    });
    markSaved();
    setEditorStatus("已保存");
    if (editorKind === "world" || editorKind === "player") {
      $<HTMLDialogElement>("#editor").close();
    } else openEditorList(editorKind);
  } catch (error) {
    setEditorStatus("保存失败：" + String(error), true);
  }
}

/** Saves the whole book through the manager, then refreshes the list. */
async function saveLoreEditorEntry(): Promise<void> {
  const manager = loreManager;
  if (!manager) throw new Error("世界书编辑器还没有就绪");
  const saved = await manager.save();
  const name = saved.doc.name;
  library = {
    ...library,
    lore: library.lore.map((item) =>
      item.id === saved.id ? { ...item, title: name, updatedAt: Date.now() } : item,
    ),
  };
  await refreshLibrary();
  announce<{ kind: EditorKind; id: string; action: "save" }>("applecos:library-edit", {
    kind: "lore",
    id: saved.id,
    action: "save",
  });
  markSaved();
  setEditorStatus("已保存");
  openEditorList("lore");
}

async function deleteEditorEntry(): Promise<void> {
  if (!editorId) return;
  const kind = editorKind;
  const id = editorId;
  if (kind === "player") {
    setEditorStatus("玩家角色随世界保存，不能单独删除", true);
    return;
  }
  setEditorStatus("正在删除…");
  try {
    if (kind === "memory") {
      if (!memoryStore) throw new Error("记忆随会话保存，当前没有打开的会话");
      await memoryStore.remove(id);
      library = { ...library, memory: memoryStore.list() };
    } else {
      await deleteLibraryEntry(kind, id);
      announce<{ kind: EditorKind; id: string; action: "delete" }>("applecos:library-edit", {
        kind,
        id,
        action: "delete",
      });
      await refreshLibrary();
    }
    refreshLibraryCounts();
    markSaved();
    setEditorStatus("已删除");
    editorId = "";
    if (kind === "world") $<HTMLDialogElement>("#editor").close();
    else openEditorList(kind);
  } catch (error) {
    setEditorStatus("删除失败：" + String(error), true);
  }
}

function refreshLibraryCounts(): void {
  const targets: [string, EditorKind][] = [
    ["#world-count", "world"],
    ["#character-count", "character"],
    ["#lore-count", "lore"],
    ["#memory-count", "memory"],
  ];
  for (const [selector, kind] of targets) {
    const node = document.querySelector<HTMLElement>(selector);
    if (node) node.textContent = String(library[kind].length);
  }
}

/* -------------------------------------------------------------------------
   Settings wiring
   ------------------------------------------------------------------------- */

function closeSettings(): void {
  const dialog = $<HTMLDialogElement>("#settings");
  if (dialog.open) dialog.close();
}

/** Called by the page boot and by the rail button. */
export async function openSettings(pane?: Pane): Promise<void> {
  const dialog = $<HTMLDialogElement>("#settings");
  try {
    config = await Settings.load();
  } catch {
    // Keep the last known values when Go cannot answer yet.
  }

  wire = config.kind === "anthropic" ? "anthropic" : "openai";
  shape = config.shape === "responses" ? "responses" : "chat";

  // Fresh dialog: nothing counts as edited until the user touches a control.
  configTouched.clear();

  setWire(wire);
  setShape(shape);
  $<HTMLInputElement>("#base-url").value = config.baseUrl ?? "";
  $<HTMLInputElement>("#model-id").value = config.model ?? "";
  $<HTMLInputElement>("#api-key").value = config.apiKey ?? "";
  $<HTMLSelectElement>("#reasoning").value = normalizeReasoning(config.reasoning);

  const prompt = $<HTMLTextAreaElement>("#prompt");
  prompt.value = config.prompt ?? "";
  prompt.placeholder = DEFAULT_PROMPT;

  $("#model-list").replaceChildren();
  $("#model-status").textContent = "";

  adoptConfig(config);
  applyFlags();

  const choice = currentChoice();
  renderThemeCards(choice);
  syncSwitches();
  refreshLibraryCounts();

  const fallback: Pane = pane ?? (config.model ? "appearance" : "model");
  showPane(fallback);

  if (!dialog.open) dialog.showModal();
}

function bindSettings(): void {
  for (const button of $$<HTMLButtonElement>(".nav-item")) {
    button.addEventListener("click", () => {
      const pane = button.dataset.pane as Pane | undefined;
      if (pane && pane in PANE_TITLES) showPane(pane);
    });
  }

  for (const card of $$<HTMLButtonElement>(".theme-card")) {
    card.addEventListener("click", () => {
      const choice = normalizeChoice(card.dataset.themeChoice);
      applyTheme(choice);
      renderThemeCards(choice);
      markSaved();
      scheduleConfigSave("manual", 150);
    });
  }

  for (const button of $$<HTMLButtonElement>(".wire-option")) {
    button.addEventListener("click", () => {
      setWire(button.dataset.wire === "anthropic" ? "anthropic" : "openai");
      configTouched.add("endpoint");
      scheduleConfigSave("endpoint", 250);
    });
  }

  for (const button of $$<HTMLButtonElement>(".shape-option")) {
    button.addEventListener("click", () => {
      setShape(button.dataset.shape === "responses" ? "responses" : "chat");
      configTouched.add("endpoint");
      scheduleConfigSave("endpoint", 250);
    });
  }

  $<HTMLInputElement>("#base-url").addEventListener("blur", () => {
    const route = detectRoute($<HTMLInputElement>("#base-url").value);
    if (!route) return;
    $<HTMLInputElement>("#base-url").value = route.baseUrl;
    setWire(route.kind);
    if (route.kind === "openai") setShape(route.shape);
    configTouched.add("endpoint");
    scheduleConfigSave("endpoint", 200);
  });

  $<HTMLInputElement>("#base-url").addEventListener("input", () => {
    configTouched.add("endpoint");
    scheduleConfigSave("endpoint", 700);
  });
  $<HTMLInputElement>("#api-key").addEventListener("input", () => {
    configTouched.add("apiKey");
    scheduleConfigSave("endpoint", 700);
  });
  $<HTMLInputElement>("#model-id").addEventListener("input", () => {
    configTouched.add("model");
    scheduleConfigSave("endpoint", 700);
  });
  // A level change saves at once; the config event rebuilds the agent kernel.
  $<HTMLSelectElement>("#reasoning").addEventListener("change", () => {
    configTouched.add("reasoning");
    void saveConfig("endpoint");
  });
  $<HTMLTextAreaElement>("#prompt").addEventListener("input", () => {
    configTouched.add("prompt");
    scheduleConfigSave("prompt", 700);
  });

  $("#fetch-models").addEventListener("click", () => void loadModels());

  $("#reset-prompt").addEventListener("click", () => {
    $<HTMLTextAreaElement>("#prompt").value = "";
    $<HTMLTextAreaElement>("#prompt").placeholder = DEFAULT_PROMPT;
    configTouched.add("prompt");
    scheduleConfigSave("prompt", 150);
  });

  $("#close-settings").addEventListener("click", closeSettings);

  const dialog = $<HTMLDialogElement>("#settings");
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeSettings();
  });

  $("#about-quit").addEventListener("click", () => {
    closeSettings();
    requestQuit();
  });
}

/* -------------------------------------------------------------------------
   Editor wiring
   ------------------------------------------------------------------------- */

function bindEditor(): void {
  const dialog = $<HTMLDialogElement>("#editor");

  $("#editor-close").addEventListener("click", () => dialog.close());
  $("#editor-back").addEventListener("click", () => {
    const single = editorKind === "world" || editorKind === "player";
    if (editorMode === "form" && !single) openEditorList(editorKind);
    else dialog.close();
  });
  $("#editor-save").addEventListener("click", () => void saveEditorEntry());
  $("#editor-delete").addEventListener("click", () => requestDelete());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  $("#open-world").addEventListener("click", () => openEditor("world"));
  $("#open-world-library").addEventListener("click", () => openEditor("world"));
  $("#open-character-library").addEventListener("click", () => openEditor("character"));
  $("#open-lore-library").addEventListener("click", () => openEditor("lore"));
  $("#open-memory-library").addEventListener("click", () => openEditor("memory"));
  // The settings row and the rail command share one player editor.
  $("#open-player-library").addEventListener("click", () => openEditor("player"));
  $("#rail-open-player").addEventListener("click", () => openEditor("player"));

  // Rail command buttons open the same editors as the settings panes.
  $("#rail-open-lore").addEventListener("click", () => openEditor("lore"));
  $("#rail-open-character").addEventListener("click", () => openEditor("character"));
  $("#rail-open-memory").addEventListener("click", () => openEditor("memory"));
  $("#rail-memory-open").addEventListener("click", () => openEditor("memory"));
}

/* -------------------------------------------------------------------------
   World switcher
   ------------------------------------------------------------------------- */

function setWorldsStatus(message: string, error = false): void {
  const node = document.getElementById("worlds-status");
  if (!node) return;
  node.textContent = message;
  node.dataset.state = error ? "error" : message ? "ok" : "idle";
}

function worldAction(label: string, action: () => void | Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.textContent = label;
  button.addEventListener("click", () => void action());
  return button;
}

async function exportWorldFromDialog(id: string): Promise<void> {
  setWorldsStatus("正在导出…");
  try {
    const path = await exportWorldFile(id);
    setWorldsStatus(path ? "已导出到 " + path : "已取消导出");
  } catch (error) {
    setWorldsStatus("导出失败：" + String(error), true);
  }
}

function worldItem(entry: Entry): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "world-item";
  if (entry.id === activeWorldId) item.dataset.active = "true";

  const info = document.createElement("div");
  info.className = "world-item-info";
  const name = document.createElement("span");
  name.className = "world-item-name";
  name.textContent = entry.title || entry.id;
  const detail = document.createElement("span");
  detail.className = "world-item-detail";
  detail.textContent = entry.extra.tagline || firstLineOf(entry.body) || "还没有设定";
  info.append(name, detail);

  const actions = document.createElement("div");
  actions.className = "world-item-actions";
  if (entry.id === activeWorldId) {
    const badge = document.createElement("span");
    badge.className = "world-item-badge";
    badge.textContent = "当前";
    actions.append(badge);
  } else {
    actions.append(
      worldAction("切换", () => {
        closeWorlds();
        announce<{ id: string }>("applecos:world-switch", { id: entry.id });
      }),
    );
  }
  actions.append(
    worldAction("编辑", () => {
      closeWorlds();
      openEditor("world", entry.id);
    }),
  );
  actions.append(worldAction("导出", () => exportWorldFromDialog(entry.id)));
  item.append(info, actions);
  return item;
}

function firstLineOf(text: string): string {
  const line = text
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row.length > 0);
  return line ? line.slice(0, 48) : "";
}

function renderWorldList(): void {
  const list = document.getElementById("world-list");
  if (!list) return;
  list.replaceChildren(...library.world.map(worldItem));
}

function openWorlds(): void {
  const dialog = $<HTMLDialogElement>("#worlds");
  setWorldsStatus("");
  renderWorldList();
  if (!dialog.open) dialog.showModal();
  void refreshLibrary()
    .then(() => renderWorldList())
    .catch(() => undefined);
}

function closeWorlds(): void {
  const dialog = $<HTMLDialogElement>("#worlds");
  if (dialog.open) dialog.close();
}

async function createNewWorldFromDialog(): Promise<void> {
  const input = $<HTMLInputElement>("#world-new-name");
  const name = input.value.trim() || "新世界";
  setWorldsStatus("正在新建…");
  try {
    const id = await createWorld(name);
    input.value = "";
    await refreshLibrary();
    renderWorldList();
    closeWorlds();
    announce<{ id: string }>("applecos:world-switch", { id });
  } catch (error) {
    setWorldsStatus("新建失败：" + String(error), true);
  }
}

function bindWorlds(): void {
  const dialog = $<HTMLDialogElement>("#worlds");
  $("#open-worlds").addEventListener("click", openWorlds);
  $("#worlds-close").addEventListener("click", closeWorlds);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeWorlds();
  });
  $("#world-new").addEventListener("click", () => void createNewWorldFromDialog());
  $<HTMLInputElement>("#world-new-name").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void createNewWorldFromDialog();
  });
}

/* -------------------------------------------------------------------------
   Rail: clock, scenes, world, exit
   ------------------------------------------------------------------------- */

function setRail(open: boolean): void {
  const app = document.getElementById("app");
  if (app) app.dataset.rail = open ? "open" : "closed";
  const toggle = document.getElementById("toggle-rail");
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "收起侧栏" : "展开侧栏");
  }
}

function requestQuit(): void {
  const box = document.getElementById("quit-confirm");
  const note = document.getElementById("quit-note");
  if (!box) return;
  const status = document.getElementById("status");
  const busy = status?.dataset.state === "busy";
  if (note) note.textContent = busy ? "演出中，退出会先停止当前生成。" : "退出 AppleCos？";
  box.hidden = false;
}

async function performQuit(): Promise<void> {
  // A debounced setting must reach the disk before the window disappears.
  await flushConfig().catch(() => undefined);
  if (handlers.quit) {
    await handlers.quit();
    return;
  }
  announce<{ at: number }>("applecos:quit", { at: Date.now() });
  try {
    const mod = (await import("./mygo")) as unknown as {
      Shell?: { quit?: () => Promise<void> };
    };
    await mod.Shell?.quit?.();
  } catch {
    // No Shell binding yet; window.close is the platform fallback.
  }
  window.close();
}

function bindRail(): void {
  // Closing the window or quitting from the system menu skips performQuit.
  window.addEventListener("beforeunload", () => {
    if (configTimer !== undefined) void saveConfig("manual");
  });

  $("#new-session").addEventListener("click", createSession);

  for (const button of $$<HTMLButtonElement>("[data-rail-tab]")) {
    button.addEventListener("click", () => activateRailTab(button.dataset.railTab as RailTab));
  }

  // Arrow keys walk the tab row, Home and End jump to both ends.
  document.getElementById("rail-tabs")?.addEventListener("keydown", (event) => {
    const key = event.key;
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
    const tabs = $$<HTMLButtonElement>("[data-rail-tab]").filter((tab) => tab.offsetParent !== null);
    if (tabs.length === 0) return;
    event.preventDefault();
    const focused = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const current = focused >= 0 ? focused : Math.max(0, tabs.findIndex((tab) => tab.dataset.railTab === railTab));
    let next = current;
    if (key === "Home") next = 0;
    else if (key === "End") next = tabs.length - 1;
    else if (key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    else next = (current + 1) % tabs.length;
    const target = tabs[next];
    if (!target) return;
    activateRailTab(target.dataset.railTab as RailTab);
    target.focus();
  });

  const clockButton = $("#world-clock");
  const clockPanel = $("#clock-panel");
  clockButton.addEventListener("click", () => {
    const open = clockButton.getAttribute("aria-expanded") === "true";
    clockButton.setAttribute("aria-expanded", String(!open));
    clockPanel.hidden = open;
  });

  for (const button of $$<HTMLButtonElement>("#clock-panel button")) {
    button.addEventListener("click", () => {
      const minutes = Number.parseInt(button.dataset.advance ?? "0", 10);
      shiftClock(Number.isFinite(minutes) ? minutes : 0, button.dataset.phase);
      clockPanel.hidden = true;
      clockButton.setAttribute("aria-expanded", "false");
    });
  }

  $("#quit-app").addEventListener("click", requestQuit);
  $("#quit-confirm").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-quit]");
    if (!button) return;
    if (button.dataset.quit === "cancel") {
      $("#quit-confirm").hidden = true;
      return;
    }
    void performQuit();
  });

  $("#godbanner-dismiss").addEventListener("click", () => {
    flags = { ...flags, devMode: false };
    syncSwitches();
    persistFlags();
    markSaved();
  });

  document.getElementById("rail-scrim")?.addEventListener("click", () => setRail(false));

  statsToggle()?.addEventListener("click", () => toggleSessionStats());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isStatsPanelOpen()) closeSessionStats(true);
  });
  // Any click outside the panel and its entry folds it away.
  document.addEventListener("pointerdown", (event) => {
    if (!isStatsPanelOpen()) return;
    const target = event.target as Node | null;
    if (statsPanel()?.contains(target) || statsToggle()?.contains(target)) return;
    closeSessionStats();
  });
}

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */

function loadLocalState(): void {
  // The runtime fills world, library and sessions from Go after boot.
  flags = mergeFlags({});
  world = { ...DEFAULT_WORLD };
  library = { world: [], character: [], lore: [], memory: [], player: [] };
  sessions = [];
  activeSessionId = "";
}

function bindExternalChannels(): void {
  document.addEventListener("applecos:sessions", (event) => {
    const detail = (event as CustomEvent<{ sessions: SessionMeta[]; activeId?: string }>).detail;
    if (detail?.sessions) useSessions(detail.sessions, detail.activeId);
  });

  document.addEventListener("applecos:world", (event) => {
    const detail = (event as CustomEvent<Partial<WorldState> & { activeWorldId?: string }>).detail;
    if (!detail) return;
    world = { ...world, ...detail };
    // A cached player card belongs to the previous world once the world changes.
    if (detail.activeWorldId && detail.activeWorldId !== activeWorldId) {
      activeWorldId = detail.activeWorldId;
      library = { ...library, player: [] };
    }
    // Render only: echoing an event here would loop with the sender.
    renderWorldPanel();
    renderRailStats();
    // A rail edit reaches the open character form through the same world state.
    refreshAffinityEditor();
  });

  document.addEventListener("applecos:flags", (event) => {
    const detail = (event as CustomEvent<Partial<Flags>>).detail;
    if (!detail) return;
    flags = mergeFlags(detail);
    applyFlags();
    syncSwitches();
  });
}

function bindShortcuts(): void {
  document.addEventListener("keydown", (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (!meta) return;
    if (event.key.toLowerCase() === "n" && !event.shiftKey) {
      event.preventDefault();
      createSession();
    }
    if (event.key === ",") {
      event.preventDefault();
      void openSettings();
    }
  });
}

function bootLocalUi(): void {
  loadLocalState();
  railTab = readRailTab();
  applyFlags();
  syncSwitches();
  renderWorldPanel();
  renderSessions();
  renderRailMemory();
  refreshLibraryCounts();
  watchSystemTheme();

  void Settings.load()
    .then((loaded) => {
      adoptConfig(loaded);
      applyFlags();
      syncSwitches();
      // An older build persisted "system" for palettes it did not know. Keep
      // the mirror's choice in that case so the selection survives a restart.
      const restored = loaded.theme || "system";
      applyTheme(restored === "system" ? currentChoice() : restored, { announce: false });
      renderThemeCards(currentChoice());
    })
    .catch(() => undefined);
}

/** Wires the whole shell once; safe to call after the page loads. */
export function initSettings(): void {
  if (bound) return;
  bound = true;

  bootLocalUi();
  bindSettings();
  bindSwitches();
  bindEditor();
  bindWorlds();
  bindRail();
  bindExternalChannels();
  bindShortcuts();
  setSaveState("idle");
}

export { DEFAULT_PROMPT };
export type { Pane, ThemeChoice };
