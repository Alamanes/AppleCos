// Plain-data world types: cards, lorebooks, layered memory and sessions.
// Everything here survives a JSON round-trip, so storage stays a thin layer.

/** Id helper shared by every world module. */
export function createId(prefix: string): string {
  const api = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (api && typeof api.randomUUID === "function") return `${prefix}_${api.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Default character budget for lore injected in one request. */
export const DEFAULT_LORE_BUDGET_CHARS = 1200;
/** Default number of recent messages scanned for key triggers. */
export const DEFAULT_SCAN_DEPTH = 4;
/** Default recursive lore passes after the first one. */
export const DEFAULT_MAX_RECURSION = 3;
/** Session format version, bumped when the stored shape changes. */
export const SESSION_VERSION = 1;

/** The one person the user plays. Never merged into a character card. */
export interface PlayerIdentity {
  name: string;
  /** Who the player is, in their own words. */
  description: string;
  /** Standing instructions the player wants applied to their character. */
  persona: string;
}

/** Name used while a world or session carries no player identity yet. */
export const DEFAULT_PLAYER_NAME = "玩家";

/** Fresh player identity; description and persona stay empty on purpose. */
export function defaultPlayer(): PlayerIdentity {
  return { name: DEFAULT_PLAYER_NAME, description: "", persona: "" };
}

/** Normalizes a stored or partial player, so worlds without one keep working. */
export function normalizePlayer(raw: unknown, patch?: Partial<PlayerIdentity>): PlayerIdentity {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const stored = (key: keyof PlayerIdentity): string => {
    const value = record[key];
    return typeof value === "string" ? value : "";
  };
  const pick = (key: keyof PlayerIdentity, fallback: string): string => {
    const patched = patch?.[key];
    if (typeof patched === "string") return patched;
    const value = stored(key);
    return value !== "" ? value : fallback;
  };
  return {
    name: pick("name", DEFAULT_PLAYER_NAME),
    description: pick("description", ""),
    persona: pick("persona", ""),
  };
}

/** Long-term affection every card holds toward the current player. */
export type WorldRelations = Record<string, number>;

/** Drops unusable entries and clamps the rest into the affinity range. */
export function normalizeRelations(raw: unknown): WorldRelations {
  const out: WorldRelations = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [cardId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[cardId] = Math.max(-100, Math.min(100, Math.trunc(value)));
  }
  return out;
}

/** Reads one card's stored affection; missing or invalid entries read as neutral. */
export function relationOf(raw: unknown, cardId: string): number {
  if (typeof raw !== "object" || raw === null) return 0;
  const value = (raw as Record<string, unknown>)[cardId];
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, Math.trunc(value)));
}

/** Selective logic between primary and secondary keys, matching SillyTavern. */
export type SelectiveLogic = 0 | 1 | 2 | 3;

/** Where an entry is injected relative to the character block. */
export type LorePosition = "before_char" | "after_char" | "at_depth";

/** Role used for an "at depth" injection. */
export type LoreDepthRole = "system" | "user" | "assistant";

/** Why an entry ended up in the prompt. */
export type LoreActivationReason = "constant" | "sticky" | "keyword" | "recursive";

/** Why an entry was left out. */
export type LoreSkipReason =
  | "disabled"
  | "delay"
  | "cooldown"
  | "probability"
  | "group"
  | "budget"
  | "no-key"
  | "selective";

/** One lorebook entry, normalized from the many card formats in the wild. */
export interface LoreEntry {
  id: string;
  /** Human label shown in the activation log. */
  title: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  /** Always active, regardless of keys. */
  constant: boolean;
  selective: boolean;
  selectiveLogic: SelectiveLogic;
  /** Lower orders are injected first and win the character budget. */
  order: number;
  position: LorePosition;
  /** Distance from the end of the transcript for "at_depth"; 0 means last. */
  depth: number;
  depthRole: LoreDepthRole;
  /** 0..100 chance of activation when useProbability is on. */
  probability: number;
  useProbability: boolean;
  /** Keys are regular expressions instead of literal text. */
  useRegex: boolean;
  caseSensitive: boolean;
  /** This entry's content never triggers other entries. */
  excludeRecursion: boolean;
  /** This entry only fires on the first pass, never recursively. */
  preventRecursion: boolean;
  /** Turns to wait before the entry may fire. */
  delay: number;
  /** Turns to wait after firing before it may fire again. */
  cooldown: number;
  /** Turns the entry stays active after firing. */
  sticky: number;
  /** Only one entry of a group fires per turn. */
  group: string;
  groupWeight: number;
  /** This entry wins its group whenever it matches. */
  groupOverride: boolean;
  /** Per-entry scan depth; null uses the book default. */
  scanDepth: number | null;
}

/** A world book, either authored in the app or embedded in a card. */
export interface Lorebook {
  id: string;
  name: string;
  entries: LoreEntry[];
  /** Recent messages scanned for keys; 0 scans the whole history. */
  scanDepth: number;
  /** Character budget for entries injected in one request. */
  budgetChars: number;
  /** Let activated entries trigger other entries. */
  recursive: boolean;
}

/** Per-entry counters carried between turns. */
export interface LoreEntryRuntime {
  /** Turn before which the entry is forced active; 0 means inactive. */
  stickyUntil: number;
  /** Turn before which the entry may not fire; 0 means ready. */
  cooldownUntil: number;
  /** Last turn the entry fired. */
  lastTurn: number;
  /** Lifetime activation count. */
  hits: number;
}

/** Sticky and cooldown state for one book at one turn. */
export interface LoreRuntimeState {
  /** Turn the state was produced for. */
  turn: number;
  entries: Record<string, LoreEntryRuntime>;
}

/** One activation, kept for the log and the prompt inspector. */
export interface LoreActivationRecord {
  entryId: string;
  title: string;
  reason: LoreActivationReason;
  round: number;
  position: LorePosition;
  chars: number;
}

/** One rejection, kept so the user can see why an entry stayed out. */
export interface LoreSkipRecord {
  entryId: string;
  title: string;
  reason: LoreSkipReason;
}

/** What the lorebook did this turn. */
export interface LoreActivationLog {
  turn: number;
  rounds: number;
  budgetChars: number;
  usedChars: number;
  activated: LoreActivationRecord[];
  skipped: LoreSkipRecord[];
}

/** An entry destined for a fixed distance from the end of the transcript. */
export interface LoreDepthInjection {
  entryId: string;
  content: string;
  depth: number;
  role: LoreDepthRole;
}

/** Where the activated entries go in the request. */
export interface LorePlacements {
  before: string[];
  after: string[];
  depth: LoreDepthInjection[];
}

/** Everything a lorebook pass returns; the caller owns persistence. */
export interface LoreActivationResult {
  entries: LoreEntry[];
  placements: LorePlacements;
  log: LoreActivationLog;
  runtime: LoreRuntimeState;
  /** Before and after entries joined into one block, for simple callers. */
  text: string;
}

/** Mutable state layered over an immutable card. */
export interface CharacterOverlay {
  cardId: string;
  /** How the character currently feels about the player, -100..100. */
  affinity: number;
  /** Live labels such as "受伤" or "开始信任玩家". */
  tags: string[];
  /** Short narrator notes about the character's current situation. */
  notes: string[];
  /** Free-form relationship text handed to the model. */
  relationship: string;
  updatedAt: number;
  /** Set once the character has died; a dead character never returns to the cast. */
  deceased?: boolean;
  /** How the character died, as recorded at the moment of death. */
  deathCause?: string;
  /** Turn the death was recorded in. */
  diedAtTurn?: number;
  /** What the death left behind for the others. */
  deathNote?: string;
}

/** Entry shape of a card's embedded book, the on-disk SillyTavern form. */
export interface StCardEntry {
  id?: number | string;
  keys?: string[];
  secondary_keys?: string[];
  content?: string;
  comment?: string;
  enabled?: boolean;
  constant?: boolean;
  selective?: boolean;
  insertion_order?: number;
  position?: string | number;
  case_sensitive?: boolean | null;
  extensions?: Record<string, unknown>;
}

/** A card's embedded book; entries come as an array or an id-keyed object. */
export interface StCardBook {
  name?: string;
  entries?: Record<string, StCardEntry> | StCardEntry[];
  extensions?: Record<string, unknown>;
}

/** Data block shared by V2 and V3 cards, in their on-disk snake_case. */
export interface CardV2Data {
  name: string;
  description: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  alternate_greetings?: string[];
  tags?: string[];
  creator?: string;
  character_version?: string;
  extensions?: Record<string, unknown>;
  character_book?: StCardBook;
}

/** V1 card: the same fields at the top level, with no envelope. */
export type CardV1 = CardV2Data;

/** V3 adds a few optional fields over V2. */
export interface CardV3Data extends CardV2Data {
  nickname?: string;
  group_only_greetings?: string[];
  creator_notes_multilingual?: Record<string, string>;
  source?: string[];
  creation_date?: number;
  modification_date?: number;
}

/** V2 card envelope. */
export interface CardV2 {
  spec: "chara_card_v2";
  spec_version?: string;
  data: CardV2Data;
}

/** V3 card envelope. */
export interface CardV3 {
  spec: "chara_card_v3";
  spec_version?: string;
  data: CardV3Data;
}

/** Any card shape accepted on import. */
export type CardSource = CardV1 | CardV2 | CardV3 | Record<string, unknown>;

/** Normalized character card; the raw source is kept untouched. */
export interface CharacterCard {
  id: string;
  spec: "v1" | "v2" | "v3";
  name: string;
  description: string;
  personality: string;
  scenario: string;
  /** Opening line of the character. */
  firstMessage: string;
  /** Example dialogue, kept verbatim for style guidance. */
  exampleDialogue: string;
  creatorNotes: string;
  systemPrompt: string;
  /** Instructions appended after the transcript. */
  postHistoryInstructions: string;
  alternateGreetings: string[];
  tags: string[];
  creator: string;
  version: string;
  /** The card's own world book, merged into the session book on demand. */
  lorebook: Lorebook | null;
  /** Original JSON, never rewritten by play. */
  raw: unknown;
}

/** Memory tiers: the setting, the cast, and the player. */
export type MemoryTier = "world" | "cast" | "player";

/** One remembered fact. */
export interface MemoryFact {
  id: string;
  tier: MemoryTier;
  /** Card id for cast facts; empty for world and player facts. */
  owner: string;
  text: string;
  keywords: string[];
  /** 0..1, drives summary priority. */
  importance: number;
  /** Free label such as "event", "trait" or "promise". */
  kind: string;
  createdAt: number;
  updatedAt: number;
  /** Turn the fact was last retrieved. */
  lastUsedTurn: number;
  /** Null while active; a timestamp once softened. */
  softenedAt: number | null;
  /** Importance before softening, restored on revival. */
  softenedImportance: number | null;
  /** Why it was softened, shown to the user. */
  softReason: string;
}

/** Layered memory for one session. */
export interface MemoryState {
  facts: MemoryFact[];
}

/** Who spoke a stored line. */
export type WorldMessageRole = "system" | "user" | "assistant";

/** One transcript line as the world sees it. */
export interface WorldMessage {
  id: string;
  role: WorldMessageRole;
  /** Display name: the narrator, a cast member, or the player. */
  speaker: string;
  content: string;
  /** Turn the line belongs to. */
  turn: number;
  timestamp: number;
  /** Hidden lines stay in state but never reach the model. */
  hidden: boolean;
  /** Card that spoke, when a cast member did. */
  cardId: string;
}

/** Lightweight message shape; the agent adapters convert to and from Pi. */
export type LightAgentMessage = WorldMessage;

/** The stage the scene currently stands on. */
export interface SceneState {
  location: string;
  time: string;
  /** One-line state of play, refreshed by the narrator. */
  summary: string;
}

/** Session header. */
export interface SessionMeta {
  id: string;
  worldId: string;
  title: string;
  /** Cards in play, first is the focus of the opening line. */
  cast: string[];
  playerName: string;
  /** Turns completed so far, starting at 1 once play begins. */
  turn: number;
  createdAt: number;
  updatedAt: number;
}

/** One snapshot per completed turn, used by rewind. */
export interface TurnSnapshot {
  id: string;
  turn: number;
  createdAt: number;
  summary: string;
  /** Ids of the messages that exist at this turn. */
  messageIds: string[];
  scene: SceneState;
  memory: MemoryState;
  lore: LoreRuntimeState;
  loreLog: LoreActivationLog;
}

/** A session is the whole mutable side of a world: transcript, memory, state. */
export interface SessionState {
  version: number;
  meta: SessionMeta;
  player: PlayerIdentity;
  messages: WorldMessage[];
  memory: MemoryState;
  /** Per-character mutable state, keyed by card id. */
  overlays: Record<string, CharacterOverlay>;
  scene: SceneState;
  lore: LoreRuntimeState;
  loreLog: LoreActivationLog;
  turns: TurnSnapshot[];
}

/** A world is the authored setting sessions run inside. */
export interface World {
  id: string;
  name: string;
  /** Short pitch for the world list. */
  summary: string;
  /** Long-form setting text injected before the cast block. */
  setting: string;
  /** Rules that hold for the whole world, injected after the setting. */
  rules: string;
  /** Default player identity for new sessions. */
  player: PlayerIdentity;
  /** Card id of the narrator; its card supplies the world's voice. */
  narratorId: string;
  /** Every card that belongs to the world, keyed by card id. */
  cards: Record<string, CharacterCard>;
  /** Long-term affection toward the current player, keyed by card id. */
  relations?: WorldRelations;
  /** Lorebook shared by every session of the world. */
  lorebook: Lorebook;
  createdAt: number;
  updatedAt: number;
}
