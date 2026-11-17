// Character card normalization: V1/V2/V3 in, one flat card out.
// The source JSON is kept untouched so play never rewrites a card.

import {
  createId,
  DEFAULT_LORE_BUDGET_CHARS,
  DEFAULT_PLAYER_NAME,
  DEFAULT_SCAN_DEPTH,
  type CharacterCard,
  type CharacterOverlay,
  type Lorebook,
  type LoreDepthRole,
  type LoreEntry,
  type LorePosition,
  type PlayerIdentity,
  type SelectiveLogic,
} from "./types";

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDict(value: unknown): Dict {
  return isDict(value) ? value : {};
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numOf(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function listOf(value: unknown): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) if (typeof item === "string") out.push(item);
  return out;
}

/** Position numbers from the legacy format, plus the V2 strings. */
function positionOf(value: unknown): LorePosition {
  if (value === "before_char" || value === "after_char" || value === "at_depth") return value;
  const code = numOf(value, 0);
  if (code === 1) return "after_char";
  if (code >= 4) return "at_depth";
  return "before_char";
}

/** Role of an "at depth" injection: text or the legacy number. */
function depthRoleOf(value: unknown): LoreDepthRole {
  if (value === "system" || value === "user" || value === "assistant") return value;
  const code = numOf(value, 0);
  if (code === 1) return "user";
  if (code === 2) return "assistant";
  return "system";
}

function selectiveLogicOf(value: unknown): SelectiveLogic {
  const code = numOf(value, 0);
  if (code === 1 || code === 2 || code === 3) return code;
  return 0;
}

/** Normalizes one entry from either an array or an id-keyed object. */
export function normalizeLoreEntry(raw: unknown, fallbackId: string): LoreEntry {
  const record = asDict(raw);
  const ext = asDict(record.extensions);
  const scanDepthRaw = ext.scan_depth ?? record.scan_depth ?? record.scanDepth;

  return {
    id: textOf(record.id ?? record.uid ?? record.entry_id) || fallbackId || createId("lore"),
    title: textOf(record.comment ?? record.name ?? record.title),
    keys: listOf(record.keys ?? record.key ?? ext.keys),
    secondaryKeys: listOf(
      record.secondary_keys ?? record.secondaryKeys ?? record.keysecondary ?? ext.secondary_keys,
    ),
    content: textOf(record.content),
    enabled: record.enabled !== false && record.disable !== true,
    constant: boolOf(record.constant, false),
    selective: boolOf(record.selective, true),
    selectiveLogic: selectiveLogicOf(ext.selectiveLogic ?? record.selectiveLogic ?? record.selective_logic),
    order: numOf(record.insertion_order ?? record.order ?? record.insertionOrder, 0),
    position: positionOf(record.position ?? ext.position),
    depth: numOf(ext.depth ?? record.depth, 4),
    depthRole: depthRoleOf(ext.role ?? record.role),
    probability: Math.min(100, Math.max(0, numOf(ext.probability ?? record.probability, 100))),
    useProbability: boolOf(ext.useProbability ?? ext.use_probability ?? record.useProbability, true),
    useRegex: boolOf(ext.useRegex ?? ext.use_regex ?? record.useRegex, false),
    caseSensitive: boolOf(record.case_sensitive ?? record.caseSensitive ?? ext.case_sensitive, false),
    excludeRecursion: boolOf(ext.exclude_recursion ?? ext.excludeRecursion ?? record.excludeRecursion, false),
    preventRecursion: boolOf(ext.prevent_recursion ?? ext.preventRecursion ?? record.preventRecursion, false),
    delay: Math.max(0, numOf(ext.delay ?? record.delay, 0)),
    cooldown: Math.max(0, numOf(ext.cooldown ?? record.cooldown, 0)),
    sticky: Math.max(0, numOf(ext.sticky ?? record.sticky, 0)),
    group: textOf(ext.group ?? record.group),
    groupWeight: Math.max(1, numOf(ext.group_weight ?? ext.groupWeight ?? record.groupWeight, 100)),
    groupOverride: boolOf(ext.group_override ?? ext.groupOverride ?? record.groupOverride, false),
    scanDepth:
      typeof scanDepthRaw === "number" && Number.isFinite(scanDepthRaw) && scanDepthRaw >= 0
        ? Math.floor(scanDepthRaw)
        : null,
  };
}

/** Reads entries from an array or from an id-keyed object, the two ST shapes. */
export function entriesToArray(raw: unknown): LoreEntry[] {
  if (Array.isArray(raw)) {
    return raw.map((item, index) => normalizeLoreEntry(item, `entry_${index}`));
  }
  if (isDict(raw)) {
    return Object.entries(raw).map(([key, value]) => normalizeLoreEntry(value, key));
  }
  return [];
}

/** Writes entries back as an id-keyed object, the object half of the pair. */
export function entriesToObject(
  entries: readonly LoreEntry[],
  keyBy: "id" | "index" = "id",
): Record<string, LoreEntry> {
  const out: Record<string, LoreEntry> = {};
  entries.forEach((entry, index) => {
    out[keyBy === "index" ? String(index) : entry.id] = entry;
  });
  return out;
}

/** Normalizes an embedded or standalone book. */
export function normalizeBook(raw: unknown, bookId: string, bookName: string): Lorebook | null {
  if (!isDict(raw)) return null;
  const entries = entriesToArray(raw.entries);
  if (entries.length === 0) return null;
  return {
    id: textOf(raw.id) || bookId,
    name: textOf(raw.name) || bookName,
    entries,
    scanDepth: Math.max(0, numOf(raw.scan_depth ?? raw.scanDepth, DEFAULT_SCAN_DEPTH)),
    budgetChars: Math.max(0, numOf(raw.token_budget ?? raw.budgetChars, DEFAULT_LORE_BUDGET_CHARS)),
    recursive: raw.recursive_scanning !== false && raw.recursive !== false,
  };
}

/** Options for card normalization. */
export interface NormalizeCardOptions {
  id?: string;
  /** Book id for the embedded world book. */
  bookId?: string;
}

/** Normalizes V1, V2 or V3 card JSON into the flat card the app uses. */
export function normalizeCard(raw: unknown, options: NormalizeCardOptions = {}): CharacterCard {
  const record = asDict(raw);
  const specField = textOf(record.spec);
  const wrapped = specField === "chara_card_v2" || specField === "chara_card_v3";
  const data = wrapped ? asDict(record.data) : record;
  const spec: CharacterCard["spec"] =
    specField === "chara_card_v3" ? "v3" : specField === "chara_card_v2" ? "v2" : "v1";
  const name = textOf(data.name) || "未命名角色";
  const id = options.id || textOf(record.id) || createId("card");
  const book = normalizeBook(
    data.character_book ?? data.characterBook,
    options.bookId ?? `${id}_book`,
    `${name} 的世界书`,
  );

  return {
    id,
    spec,
    name,
    description: textOf(data.description),
    personality: textOf(data.personality),
    scenario: textOf(data.scenario),
    firstMessage: textOf(data.first_mes ?? data.firstMessage ?? data.first_message),
    exampleDialogue: textOf(data.mes_example ?? data.example_dialogue ?? data.exampleDialogue),
    creatorNotes: textOf(data.creator_notes ?? data.creatorNotes),
    systemPrompt: textOf(data.system_prompt ?? data.systemPrompt),
    postHistoryInstructions: textOf(
      data.post_history_instructions ?? data.postHistoryInstructions,
    ),
    alternateGreetings: listOf(data.alternate_greetings ?? data.alternateGreetings),
    tags: listOf(data.tags),
    creator: textOf(data.creator),
    version: textOf(data.character_version ?? data.characterVersion),
    lorebook: book,
    raw,
  };
}

/** Fresh overlay for a card that joins a session. */
export function createOverlay(cardId: string, now = Date.now()): CharacterOverlay {
  return { cardId, affinity: 0, tags: [], notes: [], relationship: "", updatedAt: now };
}

/** Values available to card macros. */
export interface MacroContext {
  char: string;
  user: string;
  persona: string;
  description: string;
  personality: string;
  scenario: string;
  original: string;
  random: () => number;
  now: Date;
}

/** Builds the macro context for one card seen by one player. */
export function macroContext(
  card: CharacterCard,
  player: PlayerIdentity,
  overrides: Partial<MacroContext> = {},
): MacroContext {
  return {
    char: card.name,
    // A world without a written player still needs a name for {{user}}.
    user: player.name.trim() || DEFAULT_PLAYER_NAME,
    persona: player.persona,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    original: card.description,
    random: Math.random,
    now: new Date(),
    ...overrides,
  };
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function pickFrom(list: string, random: () => number): string {
  const items = list
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (items.length === 0) return "";
  const index = Math.min(items.length - 1, Math.floor(random() * items.length));
  return items[index] ?? "";
}

/** Expands card macros; unknown macros stay verbatim so nothing is lost. */
export function applyMacros(text: string, context: MacroContext): string {
  if (!text.includes("{{")) return text;
  return text.replace(/\{\{([\s\S]*?)\}\}/g, (whole, body: string) => {
    const inner = body.trim();
    if (inner === "") return "";
    if (inner.startsWith("//")) return "";
    switch (inner) {
      case "char":
        return context.char;
      case "user":
        return context.user;
      case "persona":
        return context.persona;
      case "description":
        return context.description;
      case "personality":
        return context.personality;
      case "scenario":
        return context.scenario;
      case "original":
        return context.original;
      case "newline":
        return "\n";
      case "time":
        return `${pad(context.now.getHours())}:${pad(context.now.getMinutes())}`;
      case "date":
        return `${context.now.getFullYear()}-${pad(context.now.getMonth() + 1)}-${pad(context.now.getDate())}`;
      case "random":
        return String(Math.floor(context.random() * 100));
      default:
        break;
    }
    if (inner.startsWith("random::") || inner.startsWith("pick::")) {
      return pickFrom(inner.slice(inner.indexOf("::") + 2), context.random);
    }
    return whole;
  });
}

/** Layer one card's world book over the session book, keeping ids unique. */
export function mergeCardBooks(book: Lorebook, cards: readonly CharacterCard[]): Lorebook {
  const entries: LoreEntry[] = [...book.entries];
  const seen = new Set(entries.map((entry) => entry.id));
  cards.forEach((card, index) => {
    if (!card.lorebook) return;
    const offset = (index + 1) * 0.001;
    for (const entry of card.lorebook.entries) {
      const id = `${card.id}:${entry.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({
        ...entry,
        id,
        title: entry.title === "" ? card.name : `${card.name} · ${entry.title}`,
        order: entry.order + offset,
        keys: [...entry.keys],
        secondaryKeys: [...entry.secondaryKeys],
      });
    }
  });
  return { ...book, entries };
}
