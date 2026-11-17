/**
 * Story tools for AppleCos.
 *
 * The model gets no shell, no file access, and no network. These tools only
 * rewrite story data the app already owns, and the host persists it.
 *
 * Data lives in src/world/types.ts: World holds the authored setting, cards and
 * lorebook; SessionState holds the transcript, layered memory, character
 * overlays and scene; StoryRuntime holds what only play produces (clock, who is
 * on stage, beats, dice counters, divine state).
 *
 * Two groups:
 * - baseTools(ctx): nine tools, always mounted. Three of them let the world
 *   engine author settings itself: world book entries, new cards, card edits.
 * - divineTools(ctx): three tools, mounted only while developer mode is open.
 *   They are physically absent otherwise, so persuasion cannot reach them.
 *
 * Irreversible acts (erasing a fact, removing a character, rewinding turns) and
 * the permanent overwrite of authored text (character fields, lore entry bodies)
 * ask ctx.consent first. Everything else runs directly and never interrupts play.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { arr, bool, int, num, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";

import type { ConsentQueue } from "./consent";
import { newCardPayload, patchCardPayload, type CardPatch } from "./library";
import type { DevModeState } from "./devmode";
import type {
  CharacterCard,
  CharacterOverlay,
  LoreEntry,
  MemoryFact,
  MemoryTier,
  SessionState,
  TurnSnapshot,
  World,
} from "./world/types";
import type { LoreDocument } from "./world/lore-doc";
import { createId, normalizeRelations } from "./world/types";

// ---- Story runtime: what play produces on top of world and session ----

export type BeatKind = "setup" | "twist" | "climax" | "calm";

export interface BeatEntry {
  id: string;
  summary: string;
  kind: BeatKind;
  at: number;
}

export type FlagValue = string | number | boolean;

export interface StoryRuntime {
  /** Seed for every dice roll in this session. */
  seed: number;
  /** Rolls already taken; the next one uses seed + rolls + 1. */
  rolls: number;
  /** Minutes since the prologue; scene.time is rendered from it. */
  clockMinute: number;
  /** Card ids currently on stage. */
  present: string[];
  beats: BeatEntry[];
  flags: Record<string, FlagValue>;
  devMode: DevModeState;
}

export function emptyRuntime(seed = 20_261_116): StoryRuntime {
  return {
    seed,
    rolls: 0,
    clockMinute: 0,
    present: [],
    beats: [],
    flags: {},
    devMode: { on: false },
  };
}

/** Fills fields a stored runtime may be missing. */
export function normalizeRuntime(value: unknown): StoryRuntime {
  const source = (value ?? {}) as Partial<StoryRuntime>;
  const runtime = emptyRuntime(typeof source.seed === "number" ? source.seed : undefined);
  if (typeof source.rolls === "number") runtime.rolls = source.rolls;
  if (typeof source.clockMinute === "number") runtime.clockMinute = source.clockMinute;
  if (Array.isArray(source.present)) runtime.present = source.present.filter((entry): entry is string => typeof entry === "string");
  if (Array.isArray(source.beats)) {
    runtime.beats = source.beats.filter((beat): beat is BeatEntry => !!beat && typeof beat.id === "string" && typeof beat.summary === "string");
  }
  if (source.flags && typeof source.flags === "object") {
    for (const [key, flag] of Object.entries(source.flags)) {
      if (typeof flag === "string" || typeof flag === "number" || typeof flag === "boolean") runtime.flags[key] = flag;
    }
  }
  if (source.devMode) {
    runtime.devMode = {
      on: source.devMode.on === true,
      since: typeof source.devMode.since === "number" ? source.devMode.since : undefined,
      source: typeof source.devMode.source === "string" ? source.devMode.source : undefined,
      trace: source.devMode.trace === true,
    };
  }
  return runtime;
}

// ---- Host contract ----

export interface RewindOutcome {
  ok: boolean;
  reason?: string;
  removedTurns: number;
  keptMessages: number;
}

/** The host owns the transcript, so only it can actually go back in time. */
export interface SessionAccess {
  /**
   * Restores the agent transcript and the session turn list to the snapshot.
   * World, session and runtime data are adjusted by the rewind tool itself.
   */
  rewind(snapshot: TurnSnapshot, options: { keepMemory: boolean }): RewindOutcome;
}

/** Named sections of the system prompt, owned by the host. */
export interface PromptAccess {
  setSection(name: string, text: string | null): void;
}

export interface ToolConfig {
  /** How often the story asks before acting. Irreversible acts always ask. */
  confirmLevel: "auto" | "semi" | "strict";
}

export interface ToolEventLog {
  at: number;
  kind:
    | "memory.add"
    | "memory.rewrite"
    | "scene.set"
    | "character.update"
    | "beat.add"
    | "roll"
    | "world.rewrite"
    | "time.rewind"
    | "oracle.section"
    | "oracle.flag"
    | "lore.write"
    | "card.create"
    | "card.revise"
    // Host-side failure, logged so a broken prompt assembly stays visible.
    | "prompt.error";
  tool: string;
  payload: Record<string, unknown>;
}

/**
 * Everything a tool may touch. The host builds one per session.
 *
 * Persistence is the host's job: it stores World, SessionState and StoryRuntime
 * (through Sessions.SaveState) and restores the transcript on rewind
 * (through Sessions.ReplaceMessages). Tools never call IPC themselves.
 */
/** Host channel for the authoring writes the engine may make by itself. */
export interface LibraryAccess {
  /** Loads the current world's book as an editable document. */
  loadBook(): Promise<{ id: string; doc: LoreDocument }>;
  /** Writes the book document and returns the stored copy. */
  saveBook(doc: LoreDocument): Promise<{ id: string; doc: LoreDocument }>;
  /** Stores one card payload under the given id. */
  saveCard(id: string, payload: unknown): Promise<CharacterCard>;
  /** Writes the live world back to disk. */
  saveWorld(): Promise<void>;
  /** Redraws the library lists in the sidebar. */
  refresh(): void;
}

export interface ToolContext {
  /** Stored id of the world this session runs in. */
  readonly worldId: string;
  /** Authoring channel: world book, cards, world file, sidebar refresh. */
  readonly library: LibraryAccess;
  /** Authored setting, cards and lorebook. Tools may edit it only in divine mode. */
  readonly world: World;
  /** Live session: transcript, memory, overlays, scene. */
  readonly session: SessionState;
  /** Play-produced state: clock, stage, beats, dice, divine mode. */
  readonly runtime: StoryRuntime;
  readonly consent: ConsentQueue;
  readonly snapshots: SessionAccess;
  readonly prompt: PromptAccess;
  readonly config: ToolConfig;
  log(event: ToolEventLog): void;
  now(): number;
}

// ---- Small helpers ----

const MAX_MEMORY_TEXT = 400;
const MAX_BEAT_TEXT = 200;
const MAX_NOTE_TEXT = 400;
const MAX_TAGS = 8;
/** Facts one session keeps; past this the least valuable one is dropped. */
const MAX_MEMORY_FACTS = 240;

export function formatClock(minute: number): string {
  const total = Math.max(0, Math.trunc(minute));
  const day = Math.floor(total / 1440) + 1;
  const hour = Math.floor((total % 1440) / 60);
  const rest = total % 60;
  const hh = hour < 10 ? "0" + hour : String(hour);
  const mm = rest < 10 ? "0" + rest : String(rest);
  return "第 " + day + " 天 " + hh + ":" + mm;
}

function clip(content: string, max: number): string {
  const trimmed = content.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** One flattened line, short enough to read inside a confirmation card. */
function excerpt(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.trunc(clampNumber(value, min, max));
}

function splitWords(raw: string | undefined, max: number): string[] {
  if (!raw) return [];
  return raw
    .split(/[,，、;；]/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0)
    .slice(0, max);
}

function text(content: string): { type: "text"; text: string } {
  return { type: "text", text: content };
}

function result(content: string, details: unknown, terminate = false): AgentToolResult {
  // Every payload here is plain JSON; the cast keeps unknown call sites simple.
  const payload: AgentToolResult = { content: [text(content)], details: details as never };
  // Hint the loop to stop after this batch, used when the turn made itself moot.
  if (terminate) payload.terminate = true;
  return payload;
}

function failure(content: string, details: unknown = {}): AgentToolResult {
  return { content: [text(content)], details: details as never, isError: true };
}

function cardList(world: World): CharacterCard[] {
  return Object.values(world.cards);
}

function cardName(world: World, cardId: string): string {
  return world.cards[cardId]?.name ?? cardId;
}

/** Resolves a spoken name to a card id: exact name, then id, then substring. */
export function resolveCardId(world: World, spoken: string): string | undefined {
  const needle = spoken.trim().toLowerCase();
  if (!needle) return undefined;
  const cards = cardList(world);
  const exact = cards.find((card) => card.name.toLowerCase() === needle);
  if (exact) return exact.id;
  const byId = world.cards[spoken.trim()];
  if (byId) return byId.id;
  const partial = cards.find((card) => card.name.toLowerCase().includes(needle));
  return partial?.id;
}

function ensureOverlay(session: SessionState, cardId: string, now: number): CharacterOverlay {
  const existing = session.overlays[cardId];
  if (existing) return existing;
  const overlay: CharacterOverlay = {
    cardId,
    affinity: 0,
    tags: [],
    notes: [],
    relationship: "",
    updatedAt: now,
  };
  session.overlays[cardId] = overlay;
  return overlay;
}

/** Detached copy, kept so a failed write can put the overlay back. */
function cloneOverlay(overlay: CharacterOverlay): CharacterOverlay {
  return { ...overlay, tags: overlay.tags.slice(), notes: overlay.notes.slice() };
}

function describeImportance(importance: number): string {
  return "重要 " + clampInt(Math.round(importance * 5), 1, 5);
}

function factHaystack(fact: MemoryFact, world: World): string {
  const owner = fact.owner ? cardName(world, fact.owner) : "";
  return [fact.text, owner, fact.keywords.join(" "), fact.kind].join(" ").toLowerCase();
}

function scoreFact(fact: MemoryFact, query: string, world: World): number {
  let score = fact.importance * 10 + (fact.softenedAt === null ? 3 : 0);
  if (!query) return score;
  const hay = factHaystack(fact, world);
  if (hay.includes(query)) score += 12;
  for (const token of query.split(/\s+/)) {
    if (token && hay.includes(token)) score += 4;
  }
  return score;
}

function scoreLore(entry: LoreEntry, query: string): number {
  let score = -entry.order + (entry.constant ? 5 : 0);
  if (!query) return score;
  const hay = [entry.content, entry.title, entry.keys.join(" ")].join(" ").toLowerCase();
  if (hay.includes(query)) score += 10;
  for (const token of query.split(/\s+/)) {
    if (token && hay.includes(token)) score += 3;
  }
  return score;
}

function defaultLoreEntry(id: string, content: string, keys: string[]): LoreEntry {
  return {
    id,
    title: clip(content, 40),
    keys,
    secondaryKeys: [],
    content,
    enabled: true,
    constant: false,
    selective: false,
    selectiveLogic: 0,
    order: 100,
    position: "after_char",
    depth: 0,
    depthRole: "system",
    probability: 100,
    useProbability: false,
    useRegex: false,
    caseSensitive: false,
    excludeRecursion: false,
    preventRecursion: false,
    delay: 0,
    cooldown: 0,
    sticky: 0,
    group: "",
    groupWeight: 100,
    groupOverride: false,
    scanDepth: null,
  };
}

function stageNames(ctx: ToolContext): string[] {
  return ctx.runtime.present
    .filter((cardId) => ctx.world.cards[cardId] !== undefined)
    .map((cardId) => cardName(ctx.world, cardId));
}

function sceneTime(ctx: ToolContext): string {
  return formatClock(ctx.runtime.clockMinute);
}

// ---- Base tools ----

const recallParams = obj({
  kind: oneOf(["all", "memory", "world", "lore", "scene", "character", "beat"], {
    description: "要回想的范围。all 给概览，其余只看一层。",
  }),
  query: opt(str({ maxLength: 120, description: "关键词，可以留空。" })),
  limit: opt(int({ minimum: 1, maximum: 20, description: "最多返回几条，默认 6。" })),
});

interface RecallArgs {
  kind: "all" | "memory" | "world" | "lore" | "scene" | "character" | "beat";
  query?: string;
  limit?: number;
}

function recallTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "recall",
    label: "回想",
    description:
      "从世界资料里查出该记得的事：记忆、世界书、角色状态、当前场景、剧情节拍。写剧情前需要确认旧事时用它，不要凭空编造设定。",
    parameters: recallParams,
    executionMode: "parallel",
    async execute(_toolCallId, rawParams) {
      const args = rawParams as RecallArgs;
      const world = ctx.world;
      const session = ctx.session;
      const query = (args.query ?? "").trim().toLowerCase();
      const limit = clampInt(args.limit ?? 6, 1, 20);
      const kind = args.kind;
      const lines: string[] = [];
      const items: unknown[] = [];

      if (kind === "all" || kind === "scene" || kind === "world") {
        lines.push("【时间】" + sceneTime(ctx));
        lines.push("【场景】" + session.scene.location + (session.scene.time ? "（" + session.scene.time + "）" : ""));
        if (session.scene.summary) lines.push("【场面】" + session.scene.summary);
        const onStage = stageNames(ctx);
        lines.push("【在场】" + (onStage.length > 0 ? onStage.join("、") : "没有人"));
      }

      if (kind === "all" || kind === "character") {
        const people = cardList(world)
          .filter((card) => !query || card.name.toLowerCase().includes(query))
          .slice(0, limit);
        if (people.length > 0) lines.push("【角色】");
        for (const card of people) {
          const overlay = session.overlays[card.id];
          const place = ctx.runtime.present.includes(card.id) ? "在场" : "不在场";
          const affinity = overlay ? overlay.affinity : 0;
          const tags = overlay && overlay.tags.length > 0 ? "（" + overlay.tags.join("、") + "）" : "";
          const notes = overlay && overlay.notes.length > 0 ? " " + overlay.notes.slice(-2).join("；") : "";
          lines.push("- " + card.name + "（" + place + "，好感 " + affinity + tags + "）" + notes);
        }
        items.push(...people);
      }

      if (kind === "all" || kind === "memory" || kind === "world") {
        const facts = session.memory.facts
          .filter((fact) => {
            if (kind === "world" && fact.tier !== "world") return false;
            if (!query) return true;
            return factHaystack(fact, world).includes(query);
          })
          .slice()
          .sort((left, right) => scoreFact(right, query, world) - scoreFact(left, query, world) || right.updatedAt - left.updatedAt)
          .slice(0, kind === "all" ? Math.min(limit, 5) : limit);
        if (facts.length > 0) lines.push(kind === "world" ? "【世界事实】" : "【记忆】");
        for (const fact of facts) {
          const owner = fact.tier === "cast" && fact.owner ? "·" + cardName(world, fact.owner) : "";
          const softened = fact.softenedAt === null ? "" : "（已模糊）";
          lines.push("- [" + fact.id + "]" + owner + " " + fact.text + "（" + describeImportance(fact.importance) + softened + "）");
        }
        items.push(...facts);
      }

      if (kind === "all" || kind === "lore") {
        const entries = world.lorebook.entries
          .filter((entry) => {
            if (!query) return true;
            return [entry.content, entry.title, entry.keys.join(" ")].join(" ").toLowerCase().includes(query);
          })
          .slice()
          .sort((left, right) => scoreLore(right, query) - scoreLore(left, query))
          .slice(0, limit);
        if (entries.length > 0) lines.push("【世界书】");
        for (const entry of entries) lines.push("- [" + entry.id + "] " + entry.content);
        items.push(...entries);
      }

      if (kind === "all" || kind === "beat") {
        const beats = ctx.runtime.beats.slice(-Math.min(limit, 5)).reverse();
        if (beats.length > 0) lines.push("【前情节拍】");
        for (const beat of beats) lines.push("- [" + beat.kind + "] " + beat.summary);
        items.push(...beats);
      }

      if (lines.length === 0) return result("这里还没有值得回想的东西。", { kind, query, items: [] });
      return result(lines.join("\n"), { kind, query, items });
    },
  };
}

const rememberParams = obj({
  text: str({ minLength: 1, maxLength: MAX_MEMORY_TEXT, description: "要记住的一件事，写成完整短句。" }),
  subject: oneOf(["world", "character", "player"], { description: "世界事实、某个角色的认知、玩家留下的印象。" }),
  who: opt(str({ maxLength: 40, description: "subject 为 character 时写角色名。" })),
  importance: opt(int({ minimum: 1, maximum: 5, description: "重要度 1 到 5，默认 3。" })),
  tags: opt(str({ maxLength: 120, description: "逗号分隔的关键词，方便以后检索。" })),
  kind: opt(str({ maxLength: 20, description: "类型标签：event、promise、trait、secret 等。" })),
});

interface RememberArgs {
  text: string;
  subject: "world" | "character" | "player";
  who?: string;
  importance?: number;
  tags?: string;
  kind?: string;
}

/** Punctuation-free text, so two wordings of the same fact fold together. */
function foldFactText(value: string): string {
  return value
    .replace(/[\s，。、；：！？“”‘’（）()《》「」【】…,.;:!?"'~`\-]/g, "")
    .toLowerCase();
}

/** Existing fact that already says the same thing, if any. */
function findRepeatedFact(facts: readonly MemoryFact[], fact: MemoryFact): MemoryFact | undefined {
  const needle = foldFactText(fact.text);
  if (needle === "") return undefined;
  return facts.find((entry) => {
    if (entry.tier !== fact.tier || entry.owner !== fact.owner) return false;
    const hay = foldFactText(entry.text);
    if (hay === needle) return true;
    const [shorter, longer] = hay.length <= needle.length ? [hay, needle] : [needle, hay];
    // A short fragment is too ambiguous to count as a restatement.
    return shorter.length >= 16 && longer.includes(shorter);
  });
}

/** The fact to give up when memory is full: least important, softened first, then oldest. */
function leastValuableFact(facts: readonly MemoryFact[]): MemoryFact | undefined {
  let target: MemoryFact | undefined;
  for (const fact of facts) {
    if (!target) {
      target = fact;
      continue;
    }
    if (fact.importance !== target.importance) {
      if (fact.importance < target.importance) target = fact;
      continue;
    }
    const softened = (fact.softenedAt !== null ? 0 : 1) - (target.softenedAt !== null ? 0 : 1);
    if (softened < 0) {
      target = fact;
      continue;
    }
    if (softened === 0 && fact.updatedAt < target.updatedAt) target = fact;
  }
  return target;
}

function rememberTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "remember",
    label: "记下",
    description:
      "把一件对后续剧情有用的事写进长期记忆：答应过的事、受伤、秘密、许诺、关系变化。只写叙事里真实发生的东西。",
    parameters: rememberParams,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams) {
      const args = rawParams as RememberArgs;
      const world = ctx.world;
      const now = ctx.now();
      const tier: MemoryTier = args.subject === "character" ? "cast" : args.subject;
      let owner = "";
      if (tier === "cast") {
        const spoken = (args.who ?? "").trim();
        if (!spoken) return failure("subject 是 character 时必须写 who（角色名）。", { reason: "missing-who" });
        const cardId = resolveCardId(world, spoken);
        if (!cardId) {
          const names = cardList(world).map((card) => card.name).slice(0, 12);
          return failure("没有这个角色：" + spoken + "。可选：" + (names.length > 0 ? names.join("、") : "还没有角色卡"), {
            reason: "unknown-character",
            candidates: names,
          });
        }
        owner = cardId;
      }
      const importance = clampInt(args.importance ?? 3, 1, 5) / 5;
      const fact: MemoryFact = {
        id: createId("fact"),
        tier,
        owner,
        text: clip(args.text, MAX_MEMORY_TEXT),
        keywords: splitWords(args.tags, MAX_TAGS),
        importance,
        kind: clip(args.kind ?? "event", 20),
        createdAt: now,
        updatedAt: now,
        lastUsedTurn: ctx.session.meta.turn,
        softenedAt: null,
        softenedImportance: null,
        softReason: "",
      };
      // The same fact told again updates its entry instead of piling up a duplicate.
      const repeated = findRepeatedFact(ctx.session.memory.facts, fact);
      if (repeated) {
        repeated.text = fact.text;
        repeated.keywords = [...new Set([...repeated.keywords, ...fact.keywords])].slice(0, MAX_TAGS);
        repeated.importance = Math.max(repeated.importance, fact.importance);
        repeated.kind = fact.kind;
        repeated.updatedAt = now;
        repeated.lastUsedTurn = ctx.session.meta.turn;
        repeated.softenedAt = null;
        repeated.softenedImportance = null;
        repeated.softReason = "";
        ctx.log({
          at: now,
          kind: "memory.add",
          tool: "remember",
          payload: { id: repeated.id, tier: repeated.tier, owner: repeated.owner, text: repeated.text, importance: repeated.importance, updated: true },
        });
        const repeatedOwner = repeated.owner ? "（" + cardName(world, repeated.owner) + "）" : "";
        return result("已更新记下过的" + repeatedOwner + "：" + repeated.text, {
          id: repeated.id,
          tier: repeated.tier,
          owner: repeated.owner,
          updated: true,
        });
      }

      // Memory is bounded so a long session keeps loading: the weakest fact goes.
      const facts = ctx.session.memory.facts;
      const evicted = facts.length >= MAX_MEMORY_FACTS ? leastValuableFact(facts) : undefined;
      if (evicted) facts.splice(facts.indexOf(evicted), 1);
      facts.push(fact);
      ctx.log({
        at: now,
        kind: "memory.add",
        tool: "remember",
        payload: {
          id: fact.id,
          tier: fact.tier,
          owner: fact.owner,
          text: fact.text,
          importance: fact.importance,
          evicted: evicted?.id ?? "",
        },
      });
      const ownerLabel = fact.owner ? "（" + cardName(world, fact.owner) + "）" : "";
      const parts = ["已记下" + ownerLabel + "：" + fact.text];
      if (evicted) parts.push("记忆已满 " + MAX_MEMORY_FACTS + " 条，挤掉了较旧的一条（" + excerpt(evicted.text, 24) + "）");
      return result(parts.join("。"), { id: fact.id, tier: fact.tier, owner: fact.owner, evicted: evicted?.id ?? "" });
    },
  };
}

const setSceneParams = obj({
  place: str({ minLength: 1, maxLength: 80, description: "新的地点。" }),
  present: opt(arr(str({ maxLength: 40 }), { maxItems: 24, description: "此刻在场的角色名。" })),
  absent: opt(arr(str({ maxLength: 40 }), { maxItems: 24, description: "此刻离开的角色名。" })),
  mood: opt(str({ maxLength: 60, description: "场面的气氛，写进场面摘要。" })),
  summary: opt(str({ maxLength: MAX_BEAT_TEXT, description: "这一场的简短画面。" })),
  advanceMinutes: opt(int({ minimum: 0, maximum: 525_600, description: "顺带推进多少分钟，可省略。" })),
});

interface SetSceneArgs {
  place: string;
  present?: string[];
  absent?: string[];
  mood?: string;
  summary?: string;
  advanceMinutes?: number;
}

function setSceneTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "set_scene",
    label: "换场",
    description:
      "场景变了就换场：改地点、调整在场与离开的人、交代气氛，也可以顺带推进时间。别让对话悬在没有地面的空气里。",
    parameters: setSceneParams,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams) {
      const args = rawParams as SetSceneArgs;
      const world = ctx.world;
      const session = ctx.session;
      const runtime = ctx.runtime;
      const now = ctx.now();
      const unknown: string[] = [];

      session.scene.location = clip(args.place, 80);
      if (args.summary !== undefined) session.scene.summary = clip(args.summary, MAX_BEAT_TEXT);
      if (args.mood !== undefined) {
        const mood = clip(args.mood, 60);
        session.scene.summary = session.scene.summary ? session.scene.summary + "（" + mood + "）" : mood;
      }

      for (const spoken of args.present ?? []) {
        const cardId = resolveCardId(world, clip(spoken, 40));
        if (!cardId) {
          unknown.push(spoken);
          continue;
        }
        if (!runtime.present.includes(cardId)) runtime.present.push(cardId);
        const overlay = ensureOverlay(session, cardId, now);
        overlay.updatedAt = now;
      }
      for (const spoken of args.absent ?? []) {
        const cardId = resolveCardId(world, clip(spoken, 40));
        if (!cardId) {
          unknown.push(spoken);
          continue;
        }
        runtime.present = runtime.present.filter((entry) => entry !== cardId);
      }

      let advanced = 0;
      if (args.advanceMinutes !== undefined) {
        advanced = clampInt(args.advanceMinutes, 0, 525_600);
        runtime.clockMinute += advanced;
      }
      session.scene.time = sceneTime(ctx);

      ctx.log({
        at: now,
        kind: "scene.set",
        tool: "set_scene",
        payload: { place: session.scene.location, present: runtime.present.slice(), advanced },
      });

      const onStage = stageNames(ctx);
      const parts = ["已换场到「" + session.scene.location + "」"];
      parts.push("在场：" + (onStage.length > 0 ? onStage.join("、") : "没有人"));
      if (advanced > 0) parts.push("时间推进到 " + session.scene.time);
      if (unknown.length > 0) parts.push("没有找到这些角色：" + unknown.join("、"));
      return result(parts.join("。"), { place: session.scene.location, present: runtime.present.slice(), advanced, unknown });
    },
  };
}

const updateCharacterParams = obj({
  name: str({ minLength: 1, maxLength: 40, description: "角色名，会解析到对应的角色卡。" }),
  mood: opt(str({ maxLength: 60, description: "此刻的心情，写成标签。" })),
  note: opt(str({ maxLength: MAX_NOTE_TEXT, description: "补充说明：关系、秘密、正在做的事。" })),
  relationship: opt(str({ maxLength: MAX_NOTE_TEXT, description: "与玩家之间的关系描述，整段替换。" })),
  status: opt(oneOf(["present", "away", "gone"], { description: "在场、暂时离开、彻底离场。" })),
  affinityDelta: opt(int({ minimum: -30, maximum: 30, description: "好感变化量。" })),
});

interface UpdateCharacterArgs {
  name: string;
  mood?: string;
  note?: string;
  relationship?: string;
  status?: "present" | "away" | "gone";
  affinityDelta?: number;
}

function updateCharacterTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "update_character",
    label: "角色",
    description:
      "角色状态变化时更新它：心情、正在做的事、关系、好感增减、是否在场。关系要和角色做过的事对得上，不要空涨。",
    parameters: updateCharacterParams,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams) {
      const args = rawParams as UpdateCharacterArgs;
      const world = ctx.world;
      const session = ctx.session;
      const runtime = ctx.runtime;
      const now = ctx.now();
      const cardId = resolveCardId(world, clip(args.name, 40));
      if (!cardId) {
        const names = cardList(world).map((card) => card.name).slice(0, 12);
        return failure("没有这个角色：" + args.name + "。可选：" + (names.length > 0 ? names.join("、") : "还没有角色卡"), {
          reason: "unknown-character",
          candidates: names,
        });
      }
      const overlay = ensureOverlay(session, cardId, now);
      overlay.updatedAt = now;
      if (args.affinityDelta !== undefined) {
        const previous = overlay.affinity;
        const next = clampInt(previous + args.affinityDelta, -100, 100);
        if (next !== previous) {
          // Mirror the scene value into the world's long-term table and persist it.
          const relations = world.relations;
          overlay.affinity = next;
          world.relations = { ...normalizeRelations(relations), [cardId]: next };
          const warning = await commitAuthoring(ctx);
          if (warning) {
            // Both copies go back, so memory and the file still agree.
            overlay.affinity = previous;
            world.relations = relations;
            return failure("好感没有改成功。" + warning, { cardId, reason: "world-save" });
          }
        }
      }
      if (args.relationship !== undefined) overlay.relationship = clip(args.relationship, MAX_NOTE_TEXT);
      if (args.mood !== undefined) {
        const mood = clip(args.mood, 60);
        if (mood) overlay.tags = [mood, ...overlay.tags.filter((tag) => tag !== mood)].slice(0, 8);
      }
      if (args.note !== undefined) {
        const note = clip(args.note, MAX_NOTE_TEXT);
        if (note) overlay.notes = [...overlay.notes, note].slice(-8);
      }
      if (args.status !== undefined) {
        if (args.status === "present") {
          if (!runtime.present.includes(cardId)) runtime.present.push(cardId);
        } else {
          runtime.present = runtime.present.filter((entry) => entry !== cardId);
        }
      }
      ctx.log({
        at: now,
        kind: "character.update",
        tool: "update_character",
        payload: { cardId, name: cardName(world, cardId), affinity: overlay.affinity, status: args.status ?? "" },
      });
      return result("已更新 " + cardName(world, cardId) + "（好感 " + overlay.affinity + "）", {
        cardId,
        affinity: overlay.affinity,
        tags: overlay.tags,
      });
    },
  };
}

const recordBeatParams = obj({
  summary: str({ minLength: 1, maxLength: MAX_BEAT_TEXT, description: "这一拍发生了什么，一两句话。" }),
  kind: oneOf(["setup", "twist", "climax", "calm"], { description: "铺垫、转折、高潮、平静。" }),
});

interface RecordBeatArgs {
  summary: string;
  kind: BeatKind;
}

function recordBeatTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "record_beat",
    label: "节拍",
    description:
      "剧情走过一个段落就记一拍：用来压缩上下文、写前情提要、让很久之后还能接上。铺垫、转折、高潮、平静各记一次就够。",
    parameters: recordBeatParams,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams) {
      const args = rawParams as RecordBeatArgs;
      const now = ctx.now();
      const beat: BeatEntry = {
        id: createId("beat"),
        summary: clip(args.summary, MAX_BEAT_TEXT),
        kind: args.kind,
        at: now,
      };
      ctx.runtime.beats.push(beat);
      ctx.log({ at: now, kind: "beat.add", tool: "record_beat", payload: { id: beat.id, kind: beat.kind, summary: beat.summary } });
      return result("已记下一拍（" + beat.kind + "）：" + beat.summary, { id: beat.id, kind: beat.kind });
    },
  };
}

// ---- Deterministic dice ----

export interface RollSpec {
  count: number;
  sides: number;
  bonus: number;
  mode: "normal" | "adv" | "dis";
}

/** Parses 2d6+1, d20, d20adv, d20dis and plain modifiers such as +3. */
export function parseRoll(expression: string): RollSpec | null {
  const compact = expression.trim().toLowerCase().replace(/\s+/g, "");
  const dice = /^(\d{0,2})d(\d{1,4})(adv|dis)?([+-]\d{1,4})?$/.exec(compact);
  if (dice) {
    const countRaw = dice[1] ?? "";
    const sidesRaw = dice[2] ?? "";
    const modeRaw = dice[3] ?? "";
    const bonusRaw = dice[4] ?? "";
    const count = countRaw === "" ? 1 : Number(countRaw);
    const sides = Number(sidesRaw);
    if (count < 1 || count > 20 || sides < 2 || sides > 1000) return null;
    return {
      count,
      sides,
      bonus: bonusRaw === "" ? 0 : Number(bonusRaw),
      mode: modeRaw === "adv" ? "adv" : modeRaw === "dis" ? "dis" : "normal",
    };
  }
  const flat = /^([+-]\d{1,4})$/.exec(compact);
  if (flat) {
    const bonusRaw = flat[1] ?? "0";
    return { count: 0, sides: 0, bonus: Number(bonusRaw), mode: "normal" };
  }
  return null;
}

function mixSeed(seed: number, step: number): number {
  let value = (Math.trunc(seed) ^ Math.imul(Math.trunc(step) + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0aaad) >>> 0;
  value ^= value >>> 15;
  return value >>> 0;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1) >>> 0;
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface RollResult {
  expression: string;
  dice: number[];
  bonus: number;
  total: number;
  mode: RollSpec["mode"];
  seed: number;
  rolls: number;
}

/** Rolls once. The same session seed and roll counter always give the same dice. */
export function rollDice(spec: RollSpec, seed: number, rolls: number): RollResult {
  const step = rolls + 1;
  const random = createRandom(mixSeed(seed, step));
  const dice: number[] = [];
  for (let index = 0; index < spec.count; index += 1) {
    const first = 1 + Math.floor(random() * spec.sides);
    if (spec.mode === "normal") {
      dice.push(first);
      continue;
    }
    const second = 1 + Math.floor(random() * spec.sides);
    dice.push(spec.mode === "adv" ? Math.max(first, second) : Math.min(first, second));
  }
  const total = dice.reduce((sum, value) => sum + value, spec.bonus);
  return {
    expression: expressionFor(spec),
    dice,
    bonus: spec.bonus,
    total,
    mode: spec.mode,
    seed: mixSeed(seed, step),
    rolls: step,
  };
}

function expressionFor(spec: RollSpec): string {
  if (spec.count === 0) return (spec.bonus >= 0 ? "+" : "") + spec.bonus;
  const mode = spec.mode === "normal" ? "" : spec.mode;
  const bonus = spec.bonus === 0 ? "" : spec.bonus > 0 ? "+" + spec.bonus : String(spec.bonus);
  return spec.count + "d" + spec.sides + mode + bonus;
}

/** Outcome of a chance check; `free` is a plain roll with no success target. */
export type RollVerdict = "major-success" | "success" | "failure" | "major-failure" | "fatal" | "free";

/** One d100 check against a success chance the model declared before rolling. */
export interface CheckResult {
  /** Target after clamping to 1-99, so no call is a certainty. */
  chance: number;
  /** The d100 face. */
  roll: number;
  verdict: RollVerdict;
  /** Margin over the target on success, short of it on failure. Negative only when divine mode lifted a failed roll. */
  delta: number;
  /** True when developer mode overrode the dice. */
  divine: boolean;
  /** True when the caller declared this a check that can kill. */
  lethal: boolean;
}

/** A face this low or lower is a major success; this high or higher is a major failure. */
const MAJOR_SUCCESS_ROLL = 5;
const MAJOR_FAILURE_ROLL = 96;

/**
 * Judges one d100 check. The same seed and roll counter always give the same
 * face, so a save replays its checks exactly.
 */
export function judgeRoll(
  chance: number,
  seed: number,
  rolls: number,
  divine = false,
  lethal = false,
): { rolled: RollResult; check: CheckResult } {
  const target = clampInt(Math.round(chance), 1, 99);
  const rolled = rollDice({ count: 1, sides: 100, bonus: 0, mode: "normal" }, seed, rolls);
  const roll = rolled.total;
  let verdict: RollVerdict;
  let delta: number;
  if (roll <= target) {
    verdict = roll <= MAJOR_SUCCESS_ROLL ? "major-success" : "success";
    delta = target - roll;
  } else {
    verdict = roll >= MAJOR_FAILURE_ROLL ? "major-failure" : "failure";
    delta = roll - target;
  }
  // Divine mode: the player is a god here, so every declared action lands.
  if (divine) verdict = "major-success";
  // A lethal check that fails kills; divine mode lifts it to a major success first.
  else if (lethal && (verdict === "failure" || verdict === "major-failure")) verdict = "fatal";
  return { rolled, check: { chance: target, roll, verdict, delta, divine, lethal } };
}

/** Verdict as the model reads it back. */
function verdictPhrase(check: CheckResult): string {
  switch (check.verdict) {
    case "major-success":
      return check.divine ? "神力干预：大成功" : "大成功（高出 " + check.delta + "）";
    case "success":
      return "成功（高出 " + check.delta + "）";
    case "failure":
      return "失败（差 " + check.delta + "）";
    case "major-failure":
      return "大失败（差 " + check.delta + "）";
    case "fatal":
      return "致命失败（差 " + check.delta + "）";
    default:
      return "未判定";
  }
}

/** One sentence with the whole outcome, plus the cost the model must write out. */
function describeCheck(check: CheckResult, stakes: string): string {
  let line = "判定 1d100：掷出 " + check.roll + "，成功率 " + check.chance + "%，" + verdictPhrase(check) + "。";
  if (check.verdict === "fatal") line += "致命：该角色应当退场，用 slay_character 让他离开舞台。";
  if (stakes !== "") line += "代价：" + stakes + "。";
  return line;
}

/** Declared success chance of a call, clamped; undefined for a plain dice roll. */
function declaredChance(record: Record<string, unknown>): number | undefined {
  if (typeof record.chance !== "number" || !Number.isFinite(record.chance)) return undefined;
  return clampInt(Math.round(record.chance), 1, 99);
}

const rollParams = obj({
  chance: opt(
    num({
      minimum: 0,
      maximum: 100,
      description:
        "本次行动的成功概率，取 0-100 的整数。由你依据难度、角色能力与环境给出，掷骰前定下，掷骰之后不得修改；最终按 1-99 生效。不给此参数时退回纯点数模式，不作成败判定。",
    }),
  ),
  stakes: opt(
    str({ maxLength: 120, description: "失败的具体代价，最多 120 字；判定失败后必须把这一代价写进正文。" }),
  ),
  reason: opt(str({ maxLength: 120, description: "这次判定在赌什么，写清行动意图与想得到的结果。" })),
  lethal: opt(
    bool({
      description:
        "这次判定是否可能致命。为真且判定失败时，结果升级为致命失败，回执会要求用 slay_character 让该角色退场；神力干预下仍为大成功。",
    }),
  ),
  expression: opt(
    str({
      minLength: 1,
      maxLength: 20,
      description: "纯点数模式下的骰子表达式，如 2d6+1、d20、d20adv、d20dis，也可以只写 +3；给出 chance 时忽略本参数。",
    }),
  ),
});

function rollTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "roll",
    label: "检定",
    description:
      "结果不确定且会改变世界走向的行动先在这里掷骰：给出成功率，由 1d100 定出成败与大成功、大失败，再按结果书写。不给成功率时只掷骰面，用于天气与随机表。骰面由本工具决定，不许自己报点数。",
    parameters: rollParams,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams) {
      const args = rawParams as { chance?: number; stakes?: string; reason?: string; lethal?: boolean; expression?: string };
      const stakes = clip(args.stakes ?? "", 120);
      const reason = clip(args.reason ?? "", 120);
      const now = ctx.now();

      if (typeof args.chance === "number" && Number.isFinite(args.chance)) {
        const { rolled, check } = judgeRoll(
          args.chance,
          ctx.runtime.seed,
          ctx.runtime.rolls,
          ctx.runtime.devMode.on,
          args.lethal === true,
        );
        ctx.runtime.rolls += 1;
        ctx.log({
          at: now,
          kind: "roll",
          tool: "roll",
          payload: {
            expression: rolled.expression,
            dice: rolled.dice,
            bonus: rolled.bonus,
            total: rolled.total,
            reason,
            chance: check.chance,
            verdict: check.verdict,
            delta: check.delta,
            divine: check.divine,
            lethal: check.lethal,
            stakes,
          },
        });
        return result(describeCheck(check, stakes), { ...rolled, ...check, reason, stakes });
      }

      const expression = args.expression ?? "";
      const spec = parseRoll(expression);
      if (!spec) {
        return failure("看不懂这个骰子表达式：" + expression + "。需要判定成败时改传 chance（成功率 0-100）。", {
          expression,
          chance: null,
        });
      }
      const rolled = rollDice(spec, ctx.runtime.seed, ctx.runtime.rolls);
      ctx.runtime.rolls += 1;
      ctx.log({
        at: now,
        kind: "roll",
        tool: "roll",
        payload: {
          expression: rolled.expression,
          dice: rolled.dice,
          bonus: rolled.bonus,
          total: rolled.total,
          reason,
          chance: null,
          verdict: "free",
          delta: 0,
          divine: false,
          lethal: args.lethal === true,
          stakes,
        },
      });
      const detail = rolled.dice.length > 0 ? rolled.dice.join(" + ") : "";
      const bonus = rolled.bonus === 0 ? "" : rolled.bonus > 0 ? " + " + rolled.bonus : " - " + Math.abs(rolled.bonus);
      const line = "检定 " + rolled.expression + "：" + detail + bonus + " = " + rolled.total;
      return result(line, { ...rolled, chance: null, verdict: "free", delta: 0, divine: false, reason, stakes });
    },
  };
}

// ---- Authoring tools: the engine registers its own settings ----

/** Total authoring calls one agent response may spend. */
const AUTHORING_LIMIT = 4;
/** Longest text one field keeps; longer input is truncated, not rejected. */
const MAX_FIELD_TEXT = 2_000;
/** Schema ceiling, so over-long input reaches the truncation path. */
const MAX_FIELD_INPUT = 20_000;
/** Authoring tools share one counter per turn. */
const AUTHORING_LIMIT_MESSAGE = "本轮的设定改动已达上限，下一轮再继续。";

interface AuthoringBudget {
  turn: number;
  used: number;
}

const authoringBudgets = new WeakMap<ToolContext, AuthoringBudget>();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Counts authoring calls against the current turn; a new turn starts clean. */
function spendAuthoring(ctx: ToolContext): boolean {
  const turn = Math.trunc(ctx.session.meta.turn);
  let budget = authoringBudgets.get(ctx);
  if (!budget || budget.turn !== turn) {
    budget = { turn, used: 0 };
    authoringBudgets.set(ctx, budget);
  }
  if (budget.used >= AUTHORING_LIMIT) return false;
  budget.used += 1;
  return true;
}

/** Trims one field and records the label when it had to be shortened. */
function fieldText(value: string | undefined, label: string, notes: string[]): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= MAX_FIELD_TEXT) return trimmed;
  notes.push(label);
  return trimmed.slice(0, MAX_FIELD_TEXT);
}

function truncationNote(notes: readonly string[]): string {
  return notes.length > 0 ? "以下字段超过 " + MAX_FIELD_TEXT + " 字，已截断：" + notes.join("、") : "";
}

/** Writes the live world and redraws the sidebar; returns a warning or "". */
async function commitAuthoring(ctx: ToolContext): Promise<string> {
  try {
    await ctx.library.saveWorld();
  } catch (error) {
    return "世界文件没有保存：" + errorText(error);
  }
  try {
    ctx.library.refresh();
  } catch {
    // The sidebar redraws on the next change anyway.
  }
  return "";
}

/**
 * Asks the player before authored text is replaced for good.
 *
 * The written copy is the only copy: the world book and the card files keep no
 * earlier revision, so a whole-body rewrite is as irreversible as a deletion.
 */
function askOverwrite(
  ctx: ToolContext,
  input: { tool: string; label: string; summary: string; details: string },
  signal: AbortSignal | undefined,
): Promise<boolean> {
  return ctx.consent.request({ ...input, irreversible: true }, { signal });
}

function loreScopeLabel(entry: LoreEntry): string {
  if (entry.constant) return "始终注入";
  if (entry.keys.length === 0) return "没有触发词，只有被其他条目或发言提及时才出现";
  return "触发词：" + entry.keys.join("、");
}

function lorePlacementLabel(entry: LoreEntry): string {
  if (entry.position === "before_char") return "角色块之前";
  if (entry.position === "after_char") return "角色块之后";
  return "对话深度 " + entry.depth;
}

/** Finds one entry by id, then by title; stored ids drift when a file renumbers. */
function findLoreEntry(entries: readonly LoreEntry[], id?: string, title?: string): LoreEntry | undefined {
  const wantedId = (id ?? "").trim();
  const byId = wantedId ? entries.find((entry) => entry.id === wantedId) : undefined;
  if (byId) return byId;
  const wantedTitle = (title ?? "").trim().toLowerCase();
  if (!wantedTitle) return undefined;
  return entries.find((entry) => entry.title.trim().toLowerCase() === wantedTitle);
}

function loreCandidates(entries: readonly LoreEntry[]): string {
  const sample = entries.slice(0, 8).map((entry) => "[" + entry.id + "] " + (entry.title || "无标题"));
  return sample.length > 0 ? "现有条目：" + sample.join("；") : "世界书里还没有条目";
}

const writeLoreParams = obj({
  op: oneOf(["add", "update", "remove"], { description: "add 新增，update 改写，remove 停用。" }),
  id: opt(str({ maxLength: 80, description: "update 与 remove 必填；找不到时按 title 定位。" })),
  title: opt(str({ maxLength: 200, description: "条目标题。" })),
  triggers: opt(arr(str({ maxLength: 200 }), { maxItems: 16, description: "触发词，出现在正文里就会注入该条目。" })),
  content: opt(str({ maxLength: MAX_FIELD_INPUT, description: "条目正文，add 必填。" })),
  alwaysOn: opt(bool({ description: "始终注入，不看触发词。" })),
  placement: opt(oneOf(["before", "after"], { description: "注入位置：角色块之前或之后。" })),
  priority: opt(int({ minimum: 0, maximum: 10_000, description: "注入顺序，数字小的先注入。" })),
});

interface WriteLoreArgs {
  op: "add" | "update" | "remove";
  id?: string;
  title?: string;
  triggers?: string[];
  content?: string;
  alwaysOn?: boolean;
  placement?: "before" | "after";
  priority?: number;
}

function writeLoreTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "write_lore",
    label: "登记设定",
    description:
      "把地点、组织、规则、传说写进当前世界的世界书：剧情里新出现的东西用 add 登记，已有条目与剧情对不上时用 update 改写，过时的条目用 remove 停用。写的是世界共用的设定，不是这一场的临时印象。",
    parameters: writeLoreParams,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal) {
      const args = rawParams as WriteLoreArgs;
      if (!spendAuthoring(ctx)) return failure(AUTHORING_LIMIT_MESSAGE, { reason: "authoring-limit" });
      const now = ctx.now();
      const worldId = ctx.worldId || ctx.world.id;
      const notes: string[] = [];

      let loaded: { id: string; doc: LoreDocument };
      try {
        loaded = await ctx.library.loadBook();
      } catch (error) {
        return failure("读取世界书失败：" + errorText(error), { op: args.op, worldId });
      }
      const doc = loaded.doc;

      if (args.op === "add") {
        const content = fieldText(args.content, "正文", notes) ?? "";
        if (content === "") return failure("新增世界书条目需要 content（条目正文）。", { op: "add", worldId });
        const title = fieldText(args.title, "标题", notes) || clip(content, 40);
        const keys = (args.triggers ?? [])
          .map((key) => clip(key, 200))
          .filter((key) => key !== "")
          .slice(0, 16);
        const entry = defaultLoreEntry(createId("lore"), content, keys);
        entry.title = title;
        if (args.alwaysOn !== undefined) entry.constant = args.alwaysOn;
        if (args.placement !== undefined) {
          entry.position = args.placement === "before" ? "before_char" : "after_char";
        }
        if (args.priority !== undefined) entry.order = clampInt(args.priority, 0, 10_000);
        doc.entries.push(entry);

        let saved: { id: string; doc: LoreDocument };
        try {
          saved = await ctx.library.saveBook(doc);
        } catch (error) {
          return failure("写入世界书失败：" + errorText(error), { op: "add", worldId, title });
        }
        const created =
          saved.doc.entries
            .filter((item) => item.content === entry.content && item.title === entry.title)
            .pop() ?? entry;
        ctx.log({
          at: now,
          kind: "lore.write",
          tool: "write_lore",
          payload: { worldId, op: "add", id: created.id, title: created.title, constant: created.constant, keys: created.keys },
        });
        const parts = [
          "已写入《" + saved.doc.name + "》：新增条目「" + created.title + "」（id " + created.id + "）",
          "生效范围：" + loreScopeLabel(created) + "；注入位置：" + lorePlacementLabel(created) + "；顺序 " + created.order,
        ];
        const truncated = truncationNote(notes);
        if (truncated) parts.push(truncated);
        const warning = await commitAuthoring(ctx);
        if (warning) return failure(parts.join("。") + "。" + warning, { op: "add", id: created.id, title: created.title, reason: "world-save" });
        return result(parts.join("。"), { op: "add", id: created.id, title: created.title, bookId: saved.id });
      }

      const target = findLoreEntry(doc.entries, args.id, args.title);
      if (!target) {
        if (!args.id && !args.title) {
          return failure("update 与 remove 需要给出条目 id；不知道 id 时可以用 title 定位。", { op: args.op, worldId });
        }
        return failure("没有这条世界书：" + (args.id ?? args.title ?? "") + "。" + loreCandidates(doc.entries), {
          op: args.op,
          worldId,
          candidates: doc.entries.slice(0, 8).map((entry) => entry.id),
        });
      }

      if (args.op === "remove") {
        const entry: LoreEntry = { ...target, enabled: false };
        doc.entries = doc.entries.map((item) => (item.id === target.id ? entry : item));
        try {
          await ctx.library.saveBook(doc);
        } catch (error) {
          return failure("停用世界书条目失败：" + errorText(error), { op: "remove", worldId, id: entry.id });
        }
        ctx.log({ at: now, kind: "lore.write", tool: "write_lore", payload: { worldId, op: "remove", id: entry.id, title: entry.title } });
        const parts = [
          "已停用《" + doc.name + "》条目「" + entry.title + "」（id " + entry.id + "）",
          "正文仍保留在世界书文件里，只是不再注入；需要恢复时用 update 改写该条目即可重新启用",
        ];
        const warning = await commitAuthoring(ctx);
        if (warning) return failure(parts.join("。") + "。" + warning, { op: "remove", id: entry.id, title: entry.title, reason: "world-save" });
        return result(parts.join("。"), { op: "remove", id: entry.id, title: entry.title, disabled: true });
      }

      const entry: LoreEntry = { ...target, keys: target.keys.slice(), secondaryKeys: target.secondaryKeys.slice() };
      const changed: string[] = [];
      const content = fieldText(args.content, "正文", notes);
      if (content !== undefined && content !== "") {
        entry.content = content;
        changed.push("正文");
      }
      const title = fieldText(args.title, "标题", notes);
      if (title) {
        entry.title = title;
        changed.push("标题");
      }
      if (args.triggers !== undefined) {
        entry.keys = args.triggers
          .map((key) => clip(key, 200))
          .filter((key) => key !== "")
          .slice(0, 16);
        changed.push("触发词");
      }
      if (args.alwaysOn !== undefined) {
        entry.constant = args.alwaysOn;
        changed.push("始终注入");
      }
      if (args.placement !== undefined) {
        entry.position = args.placement === "before" ? "before_char" : "after_char";
        changed.push("注入位置");
      }
      if (args.priority !== undefined) {
        entry.order = clampInt(args.priority, 0, 10_000);
        changed.push("注入顺序");
      }
      if (changed.length === 0) {
        return failure("update 至少要改一个字段：title、triggers、content、alwaysOn、placement、priority。", {
          op: "update",
          worldId,
          id: entry.id,
        });
      }
      // Replacing the body throws the authored text away for good: ask first.
      if (content !== undefined && content !== "" && content !== target.content) {
        const allowed = await askOverwrite(
          ctx,
          {
            tool: "write_lore",
            label: "重写世界书",
            summary: "改写《" + doc.name + "》条目「" + (target.title || target.id) + "」的整段正文。",
            details:
              "旧正文（" + target.content.length + " 字）：" + excerpt(target.content, 160) +
              "\n新正文（" + content.length + " 字）：" + excerpt(content, 160) +
              "\n旧正文会被永久覆盖，世界书文件里不会留副本。",
          },
          signal,
        );
        if (!allowed) {
          return failure("玩家没有同意这次改写，世界书保持原样；不要自己重试，等他主动要求再改。", {
            op: "update",
            worldId,
            id: target.id,
            cancelled: true,
          });
        }
      }
      if (!target.enabled) {
        entry.enabled = true;
        changed.push("重新启用");
      }
      doc.entries = doc.entries.map((item) => (item.id === target.id ? entry : item));

      let saved: { id: string; doc: LoreDocument };
      try {
        saved = await ctx.library.saveBook(doc);
      } catch (error) {
        return failure("写入世界书失败：" + errorText(error), { op: "update", worldId, id: entry.id });
      }
      const stored =
        saved.doc.entries.find((item) => item.id === entry.id) ??
        saved.doc.entries.filter((item) => item.content === entry.content && item.title === entry.title).pop() ??
        entry;
      ctx.log({
        at: now,
        kind: "lore.write",
        tool: "write_lore",
        payload: { worldId, op: "update", id: stored.id, title: stored.title, changed },
      });
      const parts = [
        "已更新《" + saved.doc.name + "》条目「" + stored.title + "」（id " + stored.id + "）：改写了 " + changed.join("、"),
        "生效范围：" + loreScopeLabel(stored) + "；注入位置：" + lorePlacementLabel(stored),
      ];
      if (stored.id !== entry.id) parts.push("条目在文件里的 id 变了，请记新的 id " + stored.id);
      const truncated = truncationNote(notes);
      if (truncated) parts.push(truncated);
      const warning = await commitAuthoring(ctx);
      if (warning) return failure(parts.join("。") + "。" + warning, { op: "update", id: stored.id, title: stored.title, reason: "world-save" });
      return result(parts.join("。"), { op: "update", id: stored.id, title: stored.title, changed });
    },
  };
}

const createCharacterParams = obj({
  name: str({ minLength: 1, maxLength: 200, description: "角色名，与剧情里出现的名字一致。" }),
  description: opt(str({ maxLength: MAX_FIELD_INPUT, description: "身份、经历、外貌。" })),
  personality: opt(str({ maxLength: MAX_FIELD_INPUT, description: "性格，以及言行背后的动机。" })),
  scenario: opt(str({ maxLength: MAX_FIELD_INPUT, description: "首次登场时的处境。" })),
  speakingStyle: opt(str({ maxLength: MAX_FIELD_INPUT, description: "说话方式，写成短示范对白更清楚。" })),
  firstMessage: opt(str({ maxLength: MAX_FIELD_INPUT, description: "角色的第一句话，可省略。" })),
  tags: opt(arr(str({ maxLength: 20 }), { maxItems: 8, description: "标签，如阵营、职业。" })),
});

interface CreateCharacterArgs {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  speakingStyle?: string;
  firstMessage?: string;
  tags?: string[];
}

function createCharacterTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "create_character",
    label: "建档",
    description:
      "剧情里出现了会长期登场的角色，就给他建一张角色卡：姓名、身份经历、性格、处境、说话方式。建好后会自动加入当前世界与在场名单。一次性的路人不要建档。",
    parameters: createCharacterParams,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams) {
      const args = rawParams as CreateCharacterArgs;
      if (!spendAuthoring(ctx)) return failure(AUTHORING_LIMIT_MESSAGE, { reason: "authoring-limit" });
      const now = ctx.now();
      const notes: string[] = [];
      const name = fieldText(args.name, "姓名", notes) ?? "";
      if (name === "") return failure("建档需要 name（角色名）。", { reason: "missing-name" });

      const duplicate = cardList(ctx.world).find((card) => card.name.trim().toLowerCase() === name.toLowerCase());
      if (duplicate) {
        return failure(
          "已经有同名角色「" + duplicate.name + "」（id " + duplicate.id + "）：改动用 revise_character，不要重复建档。",
          { reason: "duplicate-card", cardId: duplicate.id },
        );
      }

      const patch: CardPatch = { name };
      const description = fieldText(args.description, "身份经历", notes);
      if (description !== undefined) patch.description = description;
      const personality = fieldText(args.personality, "性格", notes);
      if (personality !== undefined) patch.personality = personality;
      const scenario = fieldText(args.scenario, "处境", notes);
      if (scenario !== undefined) patch.scenario = scenario;
      const speakingStyle = fieldText(args.speakingStyle, "说话方式", notes);
      if (speakingStyle !== undefined) patch.speakingStyle = speakingStyle;
      const firstMessage = fieldText(args.firstMessage, "第一句话", notes);
      if (firstMessage !== undefined) patch.firstMessage = firstMessage;
      if (args.tags !== undefined) patch.tags = args.tags.map((tag) => clip(tag, 20)).filter((tag) => tag !== "").slice(0, MAX_TAGS);

      let card: CharacterCard;
      try {
        card = await ctx.library.saveCard(createId("card"), newCardPayload(patch));
      } catch (error) {
        return failure("创建角色卡失败：" + errorText(error), { name });
      }

      if (!ctx.session.meta.cast.includes(card.id)) ctx.session.meta.cast.push(card.id);
      if (!ctx.runtime.present.includes(card.id)) ctx.runtime.present.push(card.id);
      ensureOverlay(ctx.session, card.id, now).updatedAt = now;
      ctx.log({ at: now, kind: "card.create", tool: "create_character", payload: { worldId: ctx.worldId, cardId: card.id, name: card.name } });

      const parts = ["已为「" + card.name + "」建档（id " + card.id + "）", "角色已加入当前世界的角色卡与这一场的在场名单"];
      const truncated = truncationNote(notes);
      if (truncated) parts.push(truncated);
      const warning = await commitAuthoring(ctx);
      if (warning) return failure(parts.join("。") + "。" + warning, { cardId: card.id, name: card.name, reason: "world-save" });
      return result(parts.join("。"), { cardId: card.id, name: card.name, cast: ctx.session.meta.cast.slice() });
    },
  };
}

const reviseCharacterParams = obj({
  nameOrId: str({ minLength: 1, maxLength: 200, description: "按角色名或卡片 id 定位。" }),
  description: opt(str({ maxLength: MAX_FIELD_INPUT, description: "新的身份经历，整段替换。" })),
  personality: opt(str({ maxLength: MAX_FIELD_INPUT, description: "新的性格，整段替换。" })),
  scenario: opt(str({ maxLength: MAX_FIELD_INPUT, description: "新的处境，整段替换。" })),
  speakingStyle: opt(str({ maxLength: MAX_FIELD_INPUT, description: "新的说话方式，整段替换。" })),
  notes: opt(str({ maxLength: MAX_FIELD_INPUT, description: "档案补记：不影响既定字段，写给作者与旁白的备注。" })),
});

interface ReviseCharacterArgs {
  nameOrId: string;
  description?: string;
  personality?: string;
  scenario?: string;
  speakingStyle?: string;
  notes?: string;
}

function reviseCharacterTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "revise_character",
    label: "改档",
    description:
      "角色经历重大变化时改写他的档案：身份、立场、外貌、说话方式。只改传进来的字段，其余字段与扩展保持原样。改动应当是剧情已经发生的结果。",
    parameters: reviseCharacterParams,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal) {
      const args = rawParams as ReviseCharacterArgs;
      if (!spendAuthoring(ctx)) return failure(AUTHORING_LIMIT_MESSAGE, { reason: "authoring-limit" });
      const now = ctx.now();
      const notes: string[] = [];
      const spoken = clip(args.nameOrId, 80);
      const cardId = resolveCardId(ctx.world, spoken);
      const current = cardId ? ctx.world.cards[cardId] : undefined;
      if (!cardId || !current) {
        const names = cardList(ctx.world).map((card) => card.name).slice(0, 12);
        return failure("没有这个角色：" + spoken + "。可选：" + (names.length > 0 ? names.join("、") : "还没有角色卡"), {
          reason: "unknown-character",
          candidates: names,
        });
      }

      const patch: CardPatch = {};
      const changed: string[] = [];
      const description = fieldText(args.description, "身份经历", notes);
      if (description !== undefined) {
        patch.description = description;
        changed.push("身份经历");
      }
      const personality = fieldText(args.personality, "性格", notes);
      if (personality !== undefined) {
        patch.personality = personality;
        changed.push("性格");
      }
      const scenario = fieldText(args.scenario, "处境", notes);
      if (scenario !== undefined) {
        patch.scenario = scenario;
        changed.push("处境");
      }
      const speakingStyle = fieldText(args.speakingStyle, "说话方式", notes);
      if (speakingStyle !== undefined) {
        patch.speakingStyle = speakingStyle;
        changed.push("说话方式");
      }
      const note = fieldText(args.notes, "补记", notes);
      if (note !== undefined && note !== "") {
        patch.notes = note;
        changed.push("补记");
      }
      if (changed.length === 0) {
        return failure("revise_character 至少要改一个字段：description、personality、scenario、speakingStyle、notes。", {
          reason: "empty-patch",
          cardId,
        });
      }

      // The card file keeps no earlier revision, so a whole-field rewrite asks first.
      const replacedLabels: string[] = [];
      const replacedLines: string[] = [];
      const fieldPairs: Array<[string, string, string | undefined]> = [
        ["身份经历", current.description, patch.description],
        ["性格", current.personality, patch.personality],
        ["处境", current.scenario, patch.scenario],
        ["说话方式", current.exampleDialogue, patch.speakingStyle],
      ];
      for (const [label, before, after] of fieldPairs) {
        if (after === undefined || after === before) continue;
        replacedLabels.push(label);
        replacedLines.push(label + "：旧「" + excerpt(before, 120) + "」 → 新「" + excerpt(after, 120) + "」");
      }
      if (replacedLines.length > 0) {
        const allowed = await askOverwrite(
          ctx,
          {
            tool: "revise_character",
            label: "改写角色卡",
            summary: "改写「" + current.name + "」的角色卡：" + replacedLabels.join("、") + "。",
            details: replacedLines.join("\n") + "\n旧文本会被永久覆盖，角色卡文件里不会留副本。",
          },
          signal,
        );
        if (!allowed) {
          return failure("玩家没有同意这次改写，角色卡保持原样；不要自己重试，等他主动要求再改。", {
            cardId,
            name: current.name,
            cancelled: true,
          });
        }
      }

      let next: CharacterCard;
      try {
        next = await ctx.library.saveCard(cardId, patchCardPayload(current.raw ?? current, patch));
      } catch (error) {
        return failure("写入角色卡失败：" + errorText(error), { cardId, name: current.name });
      }

      // Drop overlay notes that only restate the card fields just replaced.
      const previous = [current.description, current.personality, current.scenario, current.exampleDialogue]
        .map((value) => value.trim())
        .filter((value) => value !== "");
      const overlay = ensureOverlay(ctx.session, next.id, now);
      overlay.updatedAt = now;
      let dropped = 0;
      if (previous.length > 0) {
        const before = overlay.notes.length;
        overlay.notes = overlay.notes.filter((entry) => {
          const line = entry.trim();
          if (line === "") return false;
          return !previous.some((old) => old === line || (line.length > 12 && old.includes(line)));
        });
        dropped = before - overlay.notes.length;
      }
      if (patch.notes) overlay.notes = [...overlay.notes, clip(patch.notes, MAX_NOTE_TEXT)].slice(-8);
      ctx.log({
        at: now,
        kind: "card.revise",
        tool: "revise_character",
        payload: { worldId: ctx.worldId, cardId: next.id, name: next.name, changed, droppedNotes: dropped },
      });

      const parts = ["已更新「" + next.name + "」的档案（id " + next.id + "）：改写了 " + changed.join("、"), "其余字段与未知扩展保持原样"];
      if (dropped > 0) parts.push("清掉了 " + dropped + " 条与旧设定重复的当前状态备注");
      const truncated = truncationNote(notes);
      if (truncated) parts.push(truncated);
      const warning = await commitAuthoring(ctx);
      if (warning) return failure(parts.join("。") + "。" + warning, { cardId: next.id, name: next.name, reason: "world-save" });
      return result(parts.join("。"), { cardId: next.id, name: next.name, changed, droppedNotes: dropped });
    },
  };
}

/** Card tag that marks a character as gone; the library editor reads it from here. */
const DECEASED_TAG = "已故";

const slayCharacterParams = obj({
  nameOrId: str({ minLength: 1, maxLength: 200, description: "按角色名或卡片 id 定位要退场的角色。" }),
  cause: str({ minLength: 1, maxLength: 200, description: "死因，一句话写清他是怎么死的。" }),
  note: opt(str({ maxLength: 200, description: "留给他人的余波：谁在场、留下了什么、之后怎么处理。" })),
});

interface SlayCharacterArgs {
  nameOrId: string;
  cause: string;
  note?: string;
}

/** Death is final: the cast loses the id, the overlay keeps the record, the card keeps a tag. */
function slayCharacterTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "slay_character",
    label: "陨落",
    description:
      "角色真的死了就用它完成退场登记：从在场名单移除、留下死亡记录、给角色卡打上「已故」。只在致命判定失败、或剧情里不可逆的致命结果已经发生之后调用，不要用它制造戏剧性。",
    parameters: slayCharacterParams,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams) {
      const args = rawParams as SlayCharacterArgs;
      if (!spendAuthoring(ctx)) return failure(AUTHORING_LIMIT_MESSAGE, { reason: "authoring-limit" });
      const now = ctx.now();
      const spoken = clip(args.nameOrId, 80);
      const cardId = resolveCardId(ctx.world, spoken);
      const card = cardId ? ctx.world.cards[cardId] : undefined;
      if (!cardId || !card) {
        const names = cardList(ctx.world).map((item) => item.name).slice(0, 12);
        return failure("没有这个角色：" + spoken + "。可选：" + (names.length > 0 ? names.join("、") : "还没有角色卡"), {
          reason: "unknown-character",
          candidates: names,
        });
      }

      const existing = ctx.session.overlays[cardId];
      if (existing?.deceased === true) {
        const recorded = existing.deathCause ?? "没有写明";
        return result(
          "「" + card.name + "」已经退场，死亡记录不会再写一遍（死因：" + recorded + "）。他不再出场、不再说话，也不会再被代演；要让他回来，只能用神力改写这个角色。",
          { cardId, name: card.name, deceased: true, repeat: true },
        );
      }

      const cause = clip(args.cause, 200) || "没有写明";
      const note = clip(args.note ?? "", 200);
      const turn = Math.trunc(ctx.session.meta.turn);
      const tags = card.tags.includes(DECEASED_TAG) ? card.tags.slice() : [...card.tags, DECEASED_TAG];
      let saved: CharacterCard;
      try {
        saved = await ctx.library.saveCard(cardId, patchCardPayload(card.raw ?? card, { tags }));
      } catch (error) {
        return failure("给角色卡打上已故标记失败：" + errorText(error), { cardId, name: card.name });
      }

      const overlay = ensureOverlay(ctx.session, cardId, now);
      overlay.deceased = true;
      overlay.deathCause = cause;
      overlay.diedAtTurn = turn;
      if (note !== "") overlay.deathNote = note;
      overlay.updatedAt = now;
      ctx.session.meta.cast = ctx.session.meta.cast.filter((id) => id !== cardId);
      ctx.runtime.present = ctx.runtime.present.filter((id) => id !== cardId);
      ctx.log({
        at: now,
        kind: "card.revise",
        tool: "slay_character",
        payload: { worldId: ctx.worldId, cardId, name: saved.name, cause, note, turn, cast: ctx.session.meta.cast.slice() },
      });

      const parts = [
        "「" + saved.name + "」已退场（死因：" + cause + "）",
        "已从这一场的在场名单移除：他不再出场、不再说话，也不会再出现在提示词里",
        "角色卡保留在资料库，标签加上了「" + DECEASED_TAG + "」",
      ];
      if (note !== "") parts.push("余波：" + note);
      parts.push("要让他回来，只能在开发者模式里用神力改写这个角色");
      const warning = await commitAuthoring(ctx);
      if (warning) return failure(parts.join("。") + "。" + warning, { cardId, name: saved.name, reason: "world-save" });
      return result(parts.join("。") + "。", {
        cardId,
        name: saved.name,
        deceased: true,
        cause,
        note,
        turn,
        cast: ctx.session.meta.cast.slice(),
        present: ctx.runtime.present.slice(),
      });
    },
  };
}

// ---- Base tool set ----

/** Tools every session has. */
export function baseTools(ctx: ToolContext): AgentTool<any>[] {
  return [
    recallTool(ctx),
    rememberTool(ctx),
    setSceneTool(ctx),
    updateCharacterTool(ctx),
    recordBeatTool(ctx),
    rollTool(ctx),
    writeLoreTool(ctx),
    createCharacterTool(ctx),
    reviseCharacterTool(ctx),
    slayCharacterTool(ctx),
  ];
}
// ---- Divine tools: mounted only while developer mode is open ----

function divineGuard(ctx: ToolContext): string | null {
  return ctx.runtime.devMode.on ? null : "神力没有回应：开发者模式尚未开启，需要玩家在界面里亲手打开。";
}

function parseClockMinute(label: string): number | null {
  const matched = /^第\s*(\d+)\s*天\s*(\d{1,2}):(\d{2})$/.exec(label.trim());
  if (!matched) return null;
  const day = Number(matched[1]);
  const hour = Number(matched[2]);
  const minute = Number(matched[3]);
  if (!Number.isFinite(day) || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return Math.max(0, (day - 1) * 1440 + hour * 60 + minute);
}

function locateFacts(session: SessionState, id: string | undefined, query: string | undefined, world: World): MemoryFact[] {
  if (id) return session.memory.facts.filter((fact) => fact.id === id);
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) return [];
  return session.memory.facts.filter((fact) => factHaystack(fact, world).includes(needle));
}

function locateLore(entries: readonly LoreEntry[], id: string | undefined, query: string | undefined): LoreEntry[] {
  if (id) return entries.filter((entry) => entry.id === id);
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) return [];
  return entries.filter((entry) =>
    [entry.content, entry.title, entry.keys.join(" ")].join(" ").toLowerCase().includes(needle),
  );
}

const rewritePatch = obj({
  text: opt(str({ maxLength: MAX_MEMORY_TEXT, description: "新的正文。" })),
  note: opt(str({ maxLength: MAX_NOTE_TEXT, description: "角色的补充说明。" })),
  relationship: opt(str({ maxLength: MAX_NOTE_TEXT, description: "角色与玩家的关系描述。" })),
  name: opt(str({ maxLength: 40, description: "target 为 character 时按名字定位角色。" })),
  importance: opt(int({ minimum: 1, maximum: 5, description: "记忆重要度。" })),
  tags: opt(arr(str({ maxLength: 20 }), { maxItems: MAX_TAGS, description: "替换关键词或角色标签。" })),
  keys: opt(arr(str({ maxLength: 30 }), { maxItems: 12, description: "世界书触发词。" })),
  affinity: opt(int({ minimum: -100, maximum: 100, description: "好感的直接设定值。" })),
  pinned: opt(bool({ description: "记忆提到最高重要度，或世界书改为常驻。" })),
  delete: opt(bool({ description: "删除目标。不可逆，需要确认。" })),
  revive: opt(
    bool({ description: "target 为 character 时把已故角色拉回来：清除死亡标记，放回在场名单，并去掉角色卡上的「已故」。" }),
  ),
  key: opt(str({ maxLength: 60, description: "target 为 flag 时的键名。" })),
  value: opt(union([str({ maxLength: 200 }), num(), bool()], { description: "target 为 flag 时的值。" })),
  minute: opt(int({ minimum: 0, maximum: 525_600_000, description: "target 为 clock 时直接设定的分钟数。" })),
  advanceMinutes: opt(int({ minimum: -525_600, maximum: 525_600, description: "target 为 clock 时推进的分钟数，可为负。" })),
});

const rewriteWorldParams = obj({
  target: oneOf(["memory", "character", "clock", "flag", "lore"], { description: "要改动的世界资料。" }),
  id: opt(str({ maxLength: 80, description: "记忆或世界书的条目 id，优先于 query。" })),
  query: opt(str({ maxLength: 120, description: "按内容查找唯一目标。" })),
  patch: rewritePatch,
  reason: str({ minLength: 2, maxLength: 200, description: "为什么改，写给玩家看的理由。" }),
});

interface RewriteWorldArgs {
  target: "memory" | "character" | "clock" | "flag" | "lore";
  id?: string;
  query?: string;
  patch: {
    text?: string;
    note?: string;
    name?: string;
    relationship?: string;
    importance?: number;
    tags?: string[];
    keys?: string[];
    affinity?: number;
    pinned?: boolean;
    delete?: boolean;
    revive?: boolean;
    key?: string;
    value?: FlagValue;
    minute?: number;
    advanceMinutes?: number;
  };
  reason: string;
}

function rewriteWorldTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "rewrite_world",
    label: "改写世界",
    description:
      "以神力直接改写世界资料：记忆、角色状态、时钟、标记、世界书。只有开发者模式开启时存在。删除不可逆，必须先让玩家确认。",
    parameters: rewriteWorldParams,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal) {
      const args = rawParams as RewriteWorldArgs;
      const closed = divineGuard(ctx);
      if (closed) return failure(closed, { reason: "devmode-off" });

      const world = ctx.world;
      const session = ctx.session;
      const runtime = ctx.runtime;
      const now = ctx.now();
      const reason = clip(args.reason, 200);
      const patch = args.patch ?? {};

      if (args.target === "memory") {
        const hits = locateFacts(session, args.id, args.query, world);
        if (hits.length === 0) return failure("找不到要改写的记忆。", { target: "memory" });
        if (hits.length > 1) {
          return failure("命中多条记忆，请用 id 指定：" + hits.slice(0, 6).map((fact) => fact.id).join("、"), {
            target: "memory",
            candidates: hits.slice(0, 6).map((fact) => fact.id),
          });
        }
        const fact = hits[0] as MemoryFact;
        if (patch.delete === true) {
          const allowed = await ctx.consent.request(
            {
              tool: "rewrite_world",
              label: "抹掉记忆",
              summary: "以神力抹掉一条记忆：" + fact.text,
              details: "条目 " + fact.id + " 删除后无法恢复。理由：" + reason,
              irreversible: true,
            },
            { signal },
          );
          if (!allowed) return failure("神力被收回，这条记忆还在。", { target: "memory", cancelled: true });
          session.memory.facts = session.memory.facts.filter((entry) => entry.id !== fact.id);
          ctx.log({ at: now, kind: "memory.rewrite", tool: "rewrite_world", payload: { id: fact.id, deleted: true, reason } });
          return result("已抹掉记忆（" + fact.id + "）。", { target: "memory", id: fact.id, deleted: true });
        }
        if (patch.text !== undefined) fact.text = clip(patch.text, MAX_MEMORY_TEXT);
        if (patch.importance !== undefined) fact.importance = clampInt(patch.importance, 1, 5) / 5;
        if (patch.pinned === true) fact.importance = 1;
        if (patch.tags !== undefined) fact.keywords = patch.tags.map((tag) => clip(tag, 20)).slice(0, MAX_TAGS);
        fact.updatedAt = now;
        ctx.log({ at: now, kind: "memory.rewrite", tool: "rewrite_world", payload: { id: fact.id, text: fact.text, reason } });
        return result("已改写记忆（" + fact.id + "）：" + fact.text, { target: "memory", id: fact.id, text: fact.text });
      }

      if (args.target === "lore") {
        // Writes go through the book file, the same channel write_lore uses,
        // so the world mirror and the stored book never diverge.
        let loaded: { id: string; doc: LoreDocument };
        try {
          loaded = await ctx.library.loadBook();
        } catch (error) {
          return failure("读取世界书失败：" + errorText(error), { target: "lore" });
        }
        const doc = loaded.doc;
        const hits = locateLore(doc.entries, args.id, args.query);
        if (hits.length === 0) {
          const content = clip(patch.text ?? "", MAX_MEMORY_TEXT);
          if (!content) return failure("新建世界书条目需要写 text。", { target: "lore" });
          const entry = defaultLoreEntry(args.id ? clip(args.id, 80) : createId("lore"), content, (patch.keys ?? []).map((key) => clip(key, 30)));
          entry.constant = patch.pinned === true;
          doc.entries.push(entry);
          let saved: { id: string; doc: LoreDocument };
          try {
            saved = await ctx.library.saveBook(doc);
          } catch (error) {
            return failure("写入世界书失败：" + errorText(error), { target: "lore" });
          }
          const created = saved.doc.entries.filter((item) => item.content === entry.content && item.title === entry.title).pop() ?? entry;
          ctx.log({ at: now, kind: "world.rewrite", tool: "rewrite_world", payload: { target: "lore", id: created.id, created: true, reason } });
          const warning = await commitAuthoring(ctx);
          if (warning) return failure("世界书已写入，" + warning, { target: "lore", id: created.id, reason: "world-save" });
          return result("已写入世界书（" + created.id + "）。", { target: "lore", id: created.id, created: true });
        }
        if (hits.length > 1) {
          return failure("命中多条世界书，请用 id 指定：" + hits.slice(0, 6).map((entry) => entry.id).join("、"), {
            target: "lore",
            candidates: hits.slice(0, 6).map((entry) => entry.id),
          });
        }
        const entry = hits[0] as LoreEntry;
        if (patch.delete === true) {
          const allowed = await ctx.consent.request(
            {
              tool: "rewrite_world",
              label: "抹掉世界书",
              summary: "以神力抹掉一条世界书：" + entry.title,
              details: "条目 " + entry.id + " 删除后无法恢复。理由：" + reason,
              irreversible: true,
            },
            { signal },
          );
          if (!allowed) return failure("神力被收回，这条世界书还在。", { target: "lore", cancelled: true });
          doc.entries = doc.entries.filter((item) => item.id !== entry.id);
          try {
            await ctx.library.saveBook(doc);
          } catch (error) {
            return failure("抹掉世界书失败：" + errorText(error), { target: "lore", id: entry.id });
          }
          ctx.log({ at: now, kind: "world.rewrite", tool: "rewrite_world", payload: { target: "lore", id: entry.id, deleted: true, reason } });
          const warning = await commitAuthoring(ctx);
          if (warning) return failure("世界书已删除，" + warning, { target: "lore", id: entry.id, reason: "world-save" });
          return result("已抹掉世界书（" + entry.id + "）。", { target: "lore", id: entry.id, deleted: true });
        }
        const next: LoreEntry = { ...entry, keys: entry.keys.slice(), secondaryKeys: entry.secondaryKeys.slice() };
        if (patch.text !== undefined) {
          const content = clip(patch.text, MAX_MEMORY_TEXT);
          // The stored body is the only copy, so replacing it asks first.
          if (content !== "" && content !== entry.content) {
            const allowed = await askOverwrite(
              ctx,
              {
                tool: "rewrite_world",
                label: "重写世界书",
                summary: "以神力改写世界书条目「" + entry.title + "」的整段正文。",
                details:
                  "旧正文（" + entry.content.length + " 字）：" + excerpt(entry.content, 160) +
                  "\n新正文（" + content.length + " 字）：" + excerpt(content, 160) +
                  "\n理由：" + reason,
              },
              signal,
            );
            if (!allowed) return failure("神力被收回，这条世界书还在。", { target: "lore", cancelled: true });
            next.content = content;
            next.title = clip(content, 40);
          }
        }
        if (patch.keys !== undefined) next.keys = patch.keys.map((key) => clip(key, 30)).slice(0, 12);
        if (patch.pinned !== undefined) next.constant = patch.pinned;
        doc.entries = doc.entries.map((item) => (item.id === entry.id ? next : item));
        let saved: { id: string; doc: LoreDocument };
        try {
          saved = await ctx.library.saveBook(doc);
        } catch (error) {
          return failure("写入世界书失败：" + errorText(error), { target: "lore", id: entry.id });
        }
        const stored =
          saved.doc.entries.find((item) => item.id === entry.id) ??
          saved.doc.entries.filter((item) => item.content === next.content).pop() ??
          next;
        ctx.log({ at: now, kind: "world.rewrite", tool: "rewrite_world", payload: { target: "lore", id: stored.id, content: stored.content, reason } });
        const warning = await commitAuthoring(ctx);
        if (warning) return failure("世界书已改写，" + warning, { target: "lore", id: stored.id, reason: "world-save" });
        return result("已改写世界书（" + stored.id + "）。", { target: "lore", id: stored.id, content: stored.content });
      }

      if (args.target === "character") {
        const spoken = clip(args.id ?? patch.name ?? args.query ?? "", 40);
        const cardId = spoken ? resolveCardId(world, spoken) : undefined;
        if (patch.delete === true) {
          if (!cardId) return failure("找不到这个角色：" + spoken, { target: "character" });
          const card = world.cards[cardId] as CharacterCard;
          const allowed = await ctx.consent.request(
            {
              tool: "rewrite_world",
              label: "抹掉角色",
              summary: "以神力让一个角色从世界里消失：" + card.name,
              details: "角色卡、关系值与在场记录会一起删除。理由：" + reason,
              irreversible: true,
            },
            { signal },
          );
          if (!allowed) return failure("神力被收回，角色还在。", { target: "character", cancelled: true });
          const removedRelation = world.relations ? world.relations[cardId] : undefined;
          const removedOverlay = session.overlays[cardId];
          const cast = session.meta.cast.slice();
          const present = runtime.present.slice();
          delete world.cards[cardId];
          if (world.relations) delete world.relations[cardId];
          delete session.overlays[cardId];
          session.meta.cast = session.meta.cast.filter((id) => id !== cardId);
          runtime.present = runtime.present.filter((id) => id !== cardId);
          const warning = await commitAuthoring(ctx);
          if (warning) {
            // The card file still exists, so the world must keep it too.
            world.cards[cardId] = card;
            if (world.relations && removedRelation !== undefined) world.relations[cardId] = removedRelation;
            if (removedOverlay) session.overlays[cardId] = removedOverlay;
            session.meta.cast = cast;
            runtime.present = present;
            return failure("神力没有落定，角色还在。" + warning, { target: "character", cardId, reason: "world-save" });
          }
          ctx.log({ at: now, kind: "world.rewrite", tool: "rewrite_world", payload: { target: "character", cardId, deleted: true, reason } });
          return result("已抹掉角色 " + card.name + "。", { target: "character", cardId, deleted: true });
        }
        if (!cardId) return failure("找不到这个角色：" + spoken, { target: "character" });
        if (patch.revive === true) {
          const before = session.overlays[cardId];
          const previous = before ? cloneOverlay(before) : null;
          const cast = session.meta.cast.slice();
          const present = runtime.present.slice();
          const restore = () => {
            if (previous) session.overlays[cardId] = previous;
            else delete session.overlays[cardId];
            session.meta.cast = cast;
            runtime.present = present;
          };
          const alive = ensureOverlay(session, cardId, now);
          const wasDead = alive.deceased === true;
          delete alive.deceased;
          delete alive.deathCause;
          delete alive.diedAtTurn;
          delete alive.deathNote;
          alive.updatedAt = now;
          if (!session.meta.cast.includes(cardId)) session.meta.cast.push(cardId);
          if (!runtime.present.includes(cardId)) runtime.present.push(cardId);
          const card = world.cards[cardId] as CharacterCard;
          if (card.tags.includes(DECEASED_TAG)) {
            try {
              await ctx.library.saveCard(cardId, patchCardPayload(card.raw ?? card, { tags: card.tags.filter((tag) => tag !== DECEASED_TAG) }));
            } catch (error) {
              restore();
              return failure("清除角色卡上的已故标记失败：" + errorText(error), { target: "character", cardId });
            }
          }
          const warning = await commitAuthoring(ctx);
          if (warning) {
            restore();
            return failure("神力没有落定，角色还留在原地。" + warning, { target: "character", cardId, reason: "world-save" });
          }
          ctx.log({
            at: now,
            kind: "world.rewrite",
            tool: "rewrite_world",
            payload: { target: "character", cardId, revived: wasDead, reason },
          });
          return result(
            "已以神力把「" + cardName(world, cardId) + "」放回在场名单：死亡标记清除，角色卡上的「" + DECEASED_TAG + "」也去掉了。",
            { target: "character", cardId, revived: wasDead },
          );
        }
        const overlay = ensureOverlay(session, cardId, now);
        overlay.updatedAt = now;
        if (patch.affinity !== undefined) {
          const previous = overlay.affinity;
          const next = clampInt(patch.affinity, -100, 100);
          if (next !== previous) {
            const relations = world.relations;
            overlay.affinity = next;
            world.relations = { ...normalizeRelations(relations), [cardId]: next };
            const warning = await commitAuthoring(ctx);
            if (warning) {
              overlay.affinity = previous;
              world.relations = relations;
              return failure("神力没有落定，好感没有变。" + warning, { target: "character", cardId, reason: "world-save" });
            }
          }
        }
        if (patch.relationship !== undefined) overlay.relationship = clip(patch.relationship, MAX_NOTE_TEXT);
        if (patch.note !== undefined) {
          const note = clip(patch.note, MAX_NOTE_TEXT);
          if (note) overlay.notes = [...overlay.notes, note].slice(-8);
        }
        if (patch.tags !== undefined) overlay.tags = patch.tags.map((tag) => clip(tag, 20)).slice(0, MAX_TAGS);
        ctx.log({ at: now, kind: "world.rewrite", tool: "rewrite_world", payload: { target: "character", cardId, reason } });
        return result("已改写角色 " + cardName(world, cardId) + "。", { target: "character", cardId });
      }

      if (args.target === "clock") {
        if (patch.minute !== undefined) runtime.clockMinute = clampInt(patch.minute, 0, 525_600_000);
        if (patch.advanceMinutes !== undefined) {
          runtime.clockMinute = clampInt(runtime.clockMinute + patch.advanceMinutes, 0, 525_600_000);
        }
        session.scene.time = sceneTime(ctx);
        ctx.log({ at: now, kind: "world.rewrite", tool: "rewrite_world", payload: { target: "clock", minute: runtime.clockMinute, reason } });
        return result("世界时间现在是 " + session.scene.time + "。", { target: "clock", minute: runtime.clockMinute });
      }

      const key = clip(patch.key ?? args.id ?? "", 60);
      if (!key) return failure("要改世界标记，得给出 key。", { target: "flag" });
      if (patch.delete === true) {
        delete runtime.flags[key];
        ctx.log({ at: now, kind: "world.rewrite", tool: "rewrite_world", payload: { target: "flag", key, removed: true, reason } });
        return result("已抹掉标记 " + key + "。", { target: "flag", key, removed: true });
      }
      if (patch.value === undefined) return failure("设置标记需要 value。", { target: "flag" });
      runtime.flags[key] = patch.value;
      ctx.log({ at: now, kind: "world.rewrite", tool: "rewrite_world", payload: { target: "flag", key, value: patch.value, reason } });
      return result("已设置标记 " + key + " = " + String(patch.value) + "。", { target: "flag", key, value: patch.value });
    },
  };
}

const rewindParams = obj({
  turns: int({ minimum: 1, maximum: 10, description: "回到几轮之前。" }),
  keepMemory: opt(bool({ description: "是否保留这段时间写下的记忆，默认保留。" })),
  reason: opt(str({ maxLength: 200, description: "为什么倒流。" })),
});

interface RewindArgs {
  turns: number;
  keepMemory?: boolean;
  reason?: string;
}

function rewindTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "rewind",
    label: "时光倒流",
    description:
      "把世界退回若干轮之前重来。不可逆，必须先让玩家确认。保留记忆的话，角色会记得被抹掉的时间线。",
    parameters: rewindParams,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal) {
      const args = rawParams as RewindArgs;
      const closed = divineGuard(ctx);
      if (closed) return failure(closed, { reason: "devmode-off" });

      const session = ctx.session;
      const turns = session.turns;
      if (turns.length === 0) return failure("这个世界还没有可以回退的轮次。", { reason: "no-snapshot" });

      const wanted = clampInt(args.turns, 1, 10);
      const index = Math.max(0, turns.length - wanted);
      const snapshot = turns[index] as TurnSnapshot;
      const actual = turns.length - index;
      const keepMemory = args.keepMemory !== false;

      const allowed = await ctx.consent.request(
        {
          tool: "rewind",
          label: "时光倒流",
          summary: "把世界退回 " + actual + " 轮之前。",
          details:
            "回到第 " + snapshot.turn + " 轮开始处" +
            (keepMemory ? "，这段时间的记忆会保留。" : "，这段时间的记忆会一起消失。") +
            (args.reason ? " 理由：" + clip(args.reason, 200) : ""),
          irreversible: true,
        },
        { signal },
      );
      if (!allowed) return failure("神力被收回，时间没有动。", { cancelled: true });

      const outcome = ctx.snapshots.rewind(snapshot, { keepMemory });
      if (!outcome.ok) return failure("回退失败：" + (outcome.reason ?? "宿主拒绝了这次操作"), { reason: outcome.reason ?? "host-refused" });

      if (!keepMemory) session.memory.facts = snapshot.memory.facts.map((fact) => ({ ...fact, keywords: [...fact.keywords] }));
      session.scene = { ...snapshot.scene };
      const clock = parseClockMinute(snapshot.scene.time);
      if (clock !== null) ctx.runtime.clockMinute = clock;
      ctx.log({
        at: ctx.now(),
        kind: "time.rewind",
        tool: "rewind",
        payload: { snapshot: snapshot.id, turns: actual, keepMemory, removedTurns: outcome.removedTurns },
      });
      // The running turn already saw the old context, so it ends here.
      return result(
        "时间倒流了 " + actual + " 轮" + (keepMemory ? "，记忆留着。" : "，这段时间的记忆一起消失了。") +
          "本轮到此为止：这一轮的正文不要再往下写，下一轮从倒流点重新开始。",
        { snapshot: snapshot.id, turns: actual, keepMemory, removedTurns: outcome.removedTurns },
        true,
      );
    },
  };
}

const oracleParams = obj({
  op: oneOf(["stats", "set_section", "set_flag", "set_confirm", "dump"], { description: "要做什么。" }),
  key: opt(str({ maxLength: 60, description: "章节名或标记名。" })),
  value: opt(union([str({ maxLength: 2_000 }), num(), bool()], { description: "要写入的值。" })),
  clear: opt(bool({ description: "删除该章节或标记。" })),
  level: opt(oneOf(["auto", "semi", "strict"], { description: "确认档位。" })),
});

interface OracleArgs {
  op: "stats" | "set_section" | "set_flag" | "set_confirm" | "dump";
  key?: string;
  value?: string | number | boolean;
  clear?: boolean;
  level?: "auto" | "semi" | "strict";
}

function oracleTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "oracle",
    label: "神谕",
    description:
      "神谕控制台：查看运行状态、改写提示词章节、设置世界标记、调整确认档位、导出世界。只在开发者模式里存在。",
    parameters: oracleParams,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal) {
      const args = rawParams as OracleArgs;
      const closed = divineGuard(ctx);
      if (closed) return failure(closed, { reason: "devmode-off" });

      const world = ctx.world;
      const session = ctx.session;
      const runtime = ctx.runtime;
      const now = ctx.now();

      if (args.op === "stats") {
        const snapshot = {
          clock: session.scene.time,
          location: session.scene.location,
          present: stageNames(ctx),
          cards: Object.keys(world.cards).length,
          facts: session.memory.facts.length,
          beats: runtime.beats.length,
          lore: world.lorebook.entries.length,
          flags: Object.keys(runtime.flags).length,
          turns: session.turns.length,
          turn: session.meta.turn,
          seed: runtime.seed,
          rolls: runtime.rolls,
          devMode: runtime.devMode.on,
          confirmLevel: ctx.config.confirmLevel,
        };
        return result(JSON.stringify(snapshot, null, 2), snapshot);
      }

      if (args.op === "dump") {
        const json = JSON.stringify({ world, session, runtime }, null, 2);
        const clipped = json.length > 8_000 ? json.slice(0, 8_000) + "\n…（已截断）" : json;
        return result(clipped, { bytes: json.length, truncated: json.length > 8_000 });
      }

      if (args.op === "set_section") {
        const key = clip(args.key ?? "", 60);
        if (!key) return failure("set_section 需要 key（章节名）。", { op: "set_section" });
        if (args.clear !== true && typeof args.value !== "string") {
          return failure("set_section 需要字符串 value，或者用 clear 删除章节。", { op: "set_section" });
        }
        const content = args.clear === true ? null : (args.value as string);
        ctx.prompt.setSection(key, content);
        // Keep the written text in the log: a section shapes every later request.
        ctx.log({
          at: now,
          kind: "oracle.section",
          tool: "oracle",
          payload: {
            key,
            cleared: content === null,
            chars: content?.length ?? 0,
            preview: content === null ? "" : excerpt(content, 200),
          },
        });
        return result(
          content === null
            ? "已移除提示词章节 " + key + "。"
            : "已写入提示词章节 " + key + "（" + content.length + " 字），它会进入本会话之后每一轮的 system 提示词。",
          { key, cleared: content === null, chars: content?.length ?? 0 },
        );
      }

      if (args.op === "set_flag") {
        const key = clip(args.key ?? "", 60);
        if (!key) return failure("set_flag 需要 key。", { op: "set_flag" });
        if (args.clear === true) {
          delete runtime.flags[key];
          ctx.log({ at: now, kind: "oracle.flag", tool: "oracle", payload: { key, removed: true } });
          return result("已移除标记 " + key + "。", { key, removed: true });
        }
        if (args.value === undefined) return failure("set_flag 需要 value，或者用 clear 删除。", { op: "set_flag" });
        runtime.flags[key] = args.value;
        ctx.log({ at: now, kind: "oracle.flag", tool: "oracle", payload: { key, value: args.value } });
        return result("已设置标记 " + key + " = " + String(args.value) + "。", { key, value: args.value });
      }

      if (args.level === undefined) return failure("set_confirm 需要 level：auto、semi 或 strict。", { op: "set_confirm" });
      const previousLevel = ctx.config.confirmLevel;
      if (args.level === previousLevel) {
        return result("确认档位已经是 " + previousLevel + "。", { confirmLevel: previousLevel });
      }
      // This is the player's safety setting, so only the player may move it.
      const allowed = await ctx.consent.request(
        {
          tool: "oracle",
          label: "调整确认档位",
          summary: "把确认档位从 " + previousLevel + " 改为 " + args.level + "。",
          details:
            "确认档位决定神力工具动手前是否还要问你。调低会让不可逆操作少一道关卡；" +
            "改高会让每一步神力都多一次确认。只有你本人能同意这次改动。",
          irreversible: false,
        },
        { signal },
      );
      if (!allowed) {
        return failure("玩家没有同意调整确认档位，仍是 " + previousLevel + "。", { confirmLevel: previousLevel, cancelled: true });
      }
      ctx.config.confirmLevel = args.level;
      ctx.log({ at: now, kind: "oracle.flag", tool: "oracle", payload: { confirmLevel: args.level, previous: previousLevel } });
      return result("确认档位已改为 " + args.level + "（原为 " + previousLevel + "）。", { confirmLevel: args.level });
    },
  };
}

/** Divine tools. The host mounts these only while developer mode is open. */
export function divineTools(ctx: ToolContext): AgentTool<any>[] {
  return [rewriteWorldTool(ctx), rewindTool(ctx), oracleTool(ctx)];
}

/** Full tool set for one session, in the order the model should read them. */
export function toolsetFor(ctx: ToolContext, divine: boolean): AgentTool<any>[] {
  const base = baseTools(ctx);
  return divine ? [...base, ...divineTools(ctx)] : base;
}

// ---- Names, labels and UI summaries ----

export const BASE_TOOL_NAMES = [
  "recall",
  "remember",
  "set_scene",
  "update_character",
  "record_beat",
  "roll",
  "write_lore",
  "create_character",
  "revise_character",
  "slay_character",
] as const;
export const DIVINE_TOOL_NAMES = ["rewrite_world", "rewind", "oracle"] as const;

/** Technical names: developer mode and internal notices. */
export const TOOL_LABELS: Record<string, string> = {
  recall: "回想",
  remember: "记下",
  set_scene: "换场",
  update_character: "改变",
  record_beat: "节拍",
  roll: "检定",
  write_lore: "登记设定",
  create_character: "建档",
  revise_character: "改档",
  slay_character: "陨落",
  rewrite_world: "改写世界",
  rewind: "时光倒流",
  oracle: "神谕控制台",
};

/** Immersive names: the transcript never shows a tool identifier. */
export const NARRATIVE_LABELS: Record<string, string> = {
  recall: "追忆",
  remember: "铭刻",
  set_scene: "场景转换",
  update_character: "人物变化",
  record_beat: "剧情推进",
  roll: "命运裁决",
  write_lore: "世界补完",
  create_character: "人物出场",
  revise_character: "人物蜕变",
  slay_character: "谢幕",
  rewrite_world: "神迹",
  rewind: "回溯",
  oracle: "神谕",
};

/** Technical label, or the narrative one when divine is set. */
export function toolLabel(name: string, divine: boolean): string {
  const table = divine ? NARRATIVE_LABELS : TOOL_LABELS;
  return table[name] ?? name;
}

/** Resolves a raw tool name or a display label back to the tool name. */
export function toolKey(nameOrLabel: string): string {
  const value = nameOrLabel.trim();
  if (value in TOOL_LABELS) return value;
  for (const [key, label] of Object.entries(TOOL_LABELS)) {
    if (label === value) return key;
  }
  for (const [key, label] of Object.entries(NARRATIVE_LABELS)) {
    if (label === value) return key;
  }
  return value;
}

export function isDivineTool(name: string): boolean {
  return (DIVINE_TOOL_NAMES as readonly string[]).includes(name);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function shortText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}

/** One line for the transcript, e.g. "记下：她答应明天再来". */
export function toolSummary(name: string, args: unknown, divine = false): string {
  if (divine) return toolNarrativeSummary(name, args);
  const record = asRecord(args);
  const label = TOOL_LABELS[name] ?? name;
  switch (name) {
    case "recall": {
      const query = shortText(record.query, 24);
      const kind = shortText(record.kind, 12);
      return label + "：" + (query || kind || "总览");
    }
    case "remember":
      return label + "：" + shortText(record.text, 30);
    case "set_scene":
      return label + "：" + shortText(record.place, 24);
    case "update_character":
      return label + "：" + shortText(record.name, 20);
    case "record_beat":
      return label + "：" + shortText(record.summary, 26);
    case "roll": {
      const chance = declaredChance(record);
      if (chance === undefined) return label + "：" + shortText(record.expression, 16);
      const stake = shortText(record.stakes, 20);
      return label + "：成功率 " + chance + "%" + (stake !== "" ? " · " + stake : "");
    }
    case "write_lore":
      return label + "：" + shortText(record.op, 8) + (record.title ? " · " + shortText(record.title, 20) : "");
    case "create_character":
      return label + "：" + shortText(record.name, 20);
    case "revise_character":
      return label + "：" + shortText(record.nameOrId, 20);
    case "slay_character":
      return label + "：" + shortText(record.nameOrId, 20);
    case "rewrite_world":
      return label + "：" + shortText(record.target, 12) + (record.reason ? "（" + shortText(record.reason, 24) + "）" : "");
    case "rewind":
      return label + "：" + String(record.turns ?? "?") + " 轮";
    case "oracle":
      return label + "：" + shortText(record.op, 12);
    default:
      return label;
  }
}

// ---- Immersive summaries ----

/** Card ids and hash-like tokens never reach the immersive transcript. */
function looksLikeId(value: string): boolean {
  return /^(card[-_]|[0-9a-f]{8}-)/i.test(value) || /^[a-z0-9_-]{20,}$/i.test(value);
}

/** A quoted name for a narrative line; ids degrade to nothing. */
function quoted(value: unknown, max: number): string {
  const text = shortText(value, max);
  return looksLikeId(text) ? "" : text;
}

const WORLD_TARGET_NARRATIVE: Record<string, string> = {
  memory: "改写了一段该被记住的往事",
  lore: "改写了世界的记载",
  character: "改写了某个人的命运",
  clock: "拨动了世界的时间",
  flag: "埋下了一条无人知晓的暗线",
};

const ORACLE_NARRATIVE: Record<string, string> = {
  stats: "神谕清点了这一场戏",
  set_section: "神谕改写了世界的规则",
  set_flag: "神谕动了动看不见的线",
  set_confirm: "神谕校准了裁决的尺度",
  dump: "神谕摊开了全部记录",
};

function worldNarrative(target: string, reason: string): string {
  const base = WORLD_TARGET_NARRATIVE[target] ?? "世界被改写了";
  return reason ? base + "：" + reason : base;
}

/** One phrase per tool, built from the value that actually changed. */
function narrativeTail(name: string, raw: string): string {
  const value = looksLikeId(raw) ? "" : raw;
  switch (name) {
    case "recall":
      return value ? "关于「" + value + "」的旧事" : "把旧事翻了一遍";
    case "remember":
      return value ? "记住了「" + value + "」" : "把一件事记了下来";
    case "set_scene":
      return value ? "转到了「" + value + "」" : "换了地方";
    case "update_character":
      return value ? value + "起了变化" : "有人起了变化";
    case "record_beat":
      return value ? "推进到「" + value + "」" : "故事往前挪了一步";
    case "roll":
      return value ? "命运掷出了 " + value : "听凭命运裁决";
    case "write_lore":
      return value ? "补上了关于「" + value + "」的记载" : "世界补上了一角";
    case "create_character":
      return value ? value + "登场" : "有新面孔登场";
    case "revise_character":
      return value ? value + "蜕变了" : "有人蜕变了";
    case "slay_character":
      return value ? value + "退场了" : "有人退场了";
    default:
      return value;
  }
}

/** Immersive phrasing for a declared success chance. */
function oddsPhrase(chance: number): string {
  if (chance <= 25) return "把命押在这一手上";
  if (chance <= 45) return "成败难料";
  if (chance <= 70) return "颇有几分胜算";
  return "几乎十拿九稳";
}

/** Immersive line for a judged roll: the odds and the stake, never dice notation. */
function rollNarrative(chance: number | undefined, stakes: string): string {
  if (chance === undefined) return narrativeTail("roll", "");
  const base = "命运开始裁决：" + oddsPhrase(chance);
  return stakes !== "" ? base + "，赌注是" + stakes : base;
}

/** Immersive summary: a line of story instead of a tool call. */
export function toolNarrativeSummary(name: string, args: unknown): string {
  const record = asRecord(args);
  switch (name) {
    case "recall":
      return narrativeTail("recall", quoted(record.query, 24) || quoted(record.kind, 12));
    case "remember":
      return narrativeTail("remember", shortText(record.text, 30));
    case "set_scene":
      return narrativeTail("set_scene", quoted(record.place, 24));
    case "update_character":
      return narrativeTail("update_character", quoted(record.name, 20));
    case "record_beat":
      return narrativeTail("record_beat", shortText(record.summary, 26));
    case "roll":
      return rollNarrative(declaredChance(record), quoted(record.stakes, 22));
    case "write_lore":
      return narrativeTail("write_lore", quoted(record.title, 24));
    case "create_character":
      return narrativeTail("create_character", quoted(record.name, 20));
    case "revise_character":
      return narrativeTail("revise_character", quoted(record.nameOrId, 20));
    case "slay_character":
      return narrativeTail("slay_character", quoted(record.nameOrId, 20));
    case "rewrite_world":
      return worldNarrative(String(record.target ?? ""), shortText(record.reason, 24));
    case "rewind": {
      const turns = Number(record.turns);
      return Number.isFinite(turns) && turns > 0 ? "时间倒退了 " + Math.trunc(turns) + " 轮" : "时间被拨了回去";
    }
    case "oracle":
      return ORACLE_NARRATIVE[String(record.op ?? "")] ?? "神谕低语了一声";
    default:
      return "";
  }
}

/** Immersive line built from a technical summary such as "建档：某角色". */
export function toolNarrativeLine(name: string, line: string): string {
  const text = line.trim();
  if (text === "") return "";
  const cut = text.indexOf("：");
  const tail = (cut >= 0 ? text.slice(cut + 1) : text).trim();
  if (name === "rewrite_world") {
    const match = /^([a-z_]+)(?:（(.*)）)?$/.exec(tail);
    return worldNarrative(match?.[1] ?? "", (match?.[2] ?? "").trim());
  }
  if (name === "rewind") return tail === "" ? "时间被拨了回去" : "时间倒退了 " + tail;
  if (name === "oracle") return ORACLE_NARRATIVE[tail.replace(/[（(].*$/, "").trim()] ?? "神谕低语了一声";
  if (name === "write_lore") {
    const parts = tail
      .split("·")
      .map((part) => part.trim())
      .filter((part) => part !== "" && !/^(add|update|remove)$/i.test(part));
    return narrativeTail("write_lore", parts[parts.length - 1] ?? "");
  }
  if (name === "roll") {
    const match = /成功率\s*(\d+)/.exec(tail);
    if (!match) return narrativeTail("roll", tail);
    const stake = tail.includes("·") ? tail.slice(tail.indexOf("·") + 1).trim() : "";
    return rollNarrative(clampInt(Number(match[1]), 1, 99), looksLikeId(stake) ? "" : stake);
  }
  return narrativeTail(name, tail);
}

