// World book documents: parse, merge and edit SillyTavern-shaped lorebooks.
//
// A document keeps the original on-disk JSON next to the normalized entries,
// so saving never drops fields the app does not understand and a broken file
// is reported instead of being silently emptied.

import { normalizeLoreEntry } from "./card";
import { budgetOverflow, sortEntries, type LoreSortDir, type LoreSortKey } from "./lore-edit";
import {
  createId,
  DEFAULT_LORE_BUDGET_CHARS,
  DEFAULT_SCAN_DEPTH,
  type Lorebook,
  type LoreEntry,
  type LorePosition,
} from "./types";

type Raw = Record<string, unknown>;

function isDict(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDict(value: unknown): Raw {
  return isDict(value) ? value : {};
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One world book plus the raw entries it came from. */
export interface LoreDocument {
  name: string;
  /** Original on-disk object; unknown top-level keys survive a save. */
  raw: Raw;
  entries: LoreEntry[];
  /** Original entry objects keyed by their on-disk slot. */
  rawEntries: Record<string, Raw>;
  /** On-disk slot for each normalized entry id. */
  rawKeys: Record<string, string>;
  scanDepth: number;
  budgetChars: number;
  recursive: boolean;
}

/** Parse outcome: an error keeps the caller from overwriting a broken book. */
export type ParseLoreResult =
  | { ok: true; doc: LoreDocument }
  | { ok: false; error: string };

/** An empty document for a brand new book. */
export function emptyLoreDocument(name: string): LoreDocument {
  return {
    name: name.trim() || "世界书",
    raw: {},
    entries: [],
    rawEntries: {},
    rawKeys: {},
    scanDepth: DEFAULT_SCAN_DEPTH,
    budgetChars: DEFAULT_LORE_BUDGET_CHARS,
    recursive: true,
  };
}

const BOOK_KEYS = ["name", "scan_depth", "scanDepth", "token_budget", "budgetChars", "recursive_scanning"];

/** Parses stored JSON; failures return an error and never an empty book. */
export function parseLoreDocument(
  text: string,
  fallbackId: string,
  fallbackName: string,
): ParseLoreResult {
  const source = typeof text === "string" ? text.trim() : "";
  if (source === "") return { ok: true, doc: emptyLoreDocument(fallbackName) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    return { ok: false, error: "世界书 JSON 解析失败：" + errorText(error) };
  }
  return loreDocumentFromRaw(parsed, fallbackId, fallbackName);
}

/** Builds a document from already parsed JSON. */
export function loreDocumentFromRaw(
  parsed: unknown,
  fallbackId: string,
  fallbackName: string,
): ParseLoreResult {
  if (Array.isArray(parsed)) return buildDocument(parsed, {}, fallbackId, fallbackName);
  if (!isDict(parsed)) return { ok: false, error: "世界书内容不是 JSON 对象或条目数组" };
  if (parsed.entries !== undefined) {
    if (!isDict(parsed.entries) && !Array.isArray(parsed.entries)) {
      return { ok: false, error: "世界书 entries 必须是数组或对象" };
    }
    return buildDocument(parsed.entries, parsed, fallbackId, fallbackName);
  }
  const looksLikeBook = BOOK_KEYS.some((key) => Object.prototype.hasOwnProperty.call(parsed, key));
  const values = Object.values(parsed);
  const hasEntries = values.some((value) => isDict(value));
  if (!looksLikeBook && hasEntries) {
    // Legacy shape: the file is a bare id-to-entry map. Object values become
    // entries, anything else stays as book metadata so nothing is dropped.
    const collection: Raw = {};
    const book: Raw = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isDict(value)) collection[key] = value;
      else book[key] = value;
    }
    return buildDocument(collection, book, fallbackId, fallbackName);
  }
  return buildDocument(undefined, parsed, fallbackId, fallbackName);
}

function buildDocument(
  collection: unknown,
  book: Raw,
  fallbackId: string,
  fallbackName: string,
): ParseLoreResult {
  const doc = emptyLoreDocument(textOf(book.name) || fallbackName);
  doc.raw = { ...book };
  doc.scanDepth = Math.max(0, Math.floor(numberOf(book.scan_depth ?? book.scanDepth, DEFAULT_SCAN_DEPTH)));
  doc.budgetChars = Math.max(
    0,
    Math.floor(numberOf(book.token_budget ?? book.budgetChars, DEFAULT_LORE_BUDGET_CHARS)),
  );
  doc.recursive = book.recursive_scanning !== false && book.recursive !== false;

  const pairs: [string, unknown][] = Array.isArray(collection)
    ? collection.map((item, index) => [String(index), item])
    : isDict(collection)
      ? Object.entries(collection)
      : [];
  if (pairs.length > 0 && pairs.every(([, value]) => !isDict(value))) {
    return { ok: false, error: "世界书 entries 里没有可识别的条目" };
  }

  const used = new Set<string>();
  pairs.forEach(([key, value], index) => {
    if (!isDict(value)) return;
    const entry = normalizeLoreEntry(value, key !== "" ? key : `${fallbackId}_${index}`);
    let id = entry.id;
    if (used.has(id)) {
      id = key !== "" ? key : `${fallbackId}_${index}`;
      while (used.has(id)) id = `${id}_${index}`;
      entry.id = id;
    }
    used.add(id);
    doc.entries.push(entry);
    doc.rawEntries[key] = value;
    doc.rawKeys[id] = key;
  });
  return { ok: true, doc };
}

/** Highest numeric uid used by the stored entries. */
function maxUid(doc: LoreDocument): number {
  let max = 0;
  const consider = (value: unknown): void => {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/.test(value.trim())
          ? Number(value.trim())
          : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 0) max = Math.max(max, Math.floor(parsed));
  };
  for (const [key, raw] of Object.entries(doc.rawEntries)) {
    consider(key);
    consider(raw.uid);
    consider(raw.id);
  }
  return max;
}

/** Position number used by the SillyTavern format. */
export function stPositionNumber(position: LorePosition): number {
  if (position === "before_char") return 0;
  if (position === "after_char") return 1;
  return 4;
}

/**
 * Writes one normalized entry back into the SillyTavern shape. Fields the app
 * does not know stay untouched: outletName, triggers, character filters,
 * match_* rules, ignore_budget, vectorized, automation_id and any other
 * extension sub-key.
 */
export function stEntryFields(
  entry: LoreEntry,
  original: Raw = {},
  uid: unknown = 0,
): Raw {
  const extensions = asDict(original.extensions);
  return {
    ...original,
    uid,
    key: entry.keys.slice(),
    keys: entry.keys.slice(),
    secondary_keys: entry.secondaryKeys.slice(),
    comment: entry.title,
    content: entry.content,
    constant: entry.constant,
    selective: entry.selective,
    enabled: entry.enabled,
    insertion_order: entry.order,
    position: stPositionNumber(entry.position),
    case_sensitive: entry.caseSensitive,
    extensions: {
      ...extensions,
      position: entry.position,
      depth: entry.depth,
      role: entry.depthRole,
      probability: entry.probability,
      useProbability: entry.useProbability,
      useRegex: entry.useRegex,
      exclude_recursion: entry.excludeRecursion,
      prevent_recursion: entry.preventRecursion,
      delay: entry.delay,
      cooldown: entry.cooldown,
      sticky: entry.sticky,
      group: entry.group,
      group_weight: entry.groupWeight,
      group_override: entry.groupOverride,
      scan_depth: entry.scanDepth ?? undefined,
    },
  };
}

/** Builds the on-disk object, keeping every unknown top-level key. */
export function mergeLoreDocument(doc: LoreDocument): Raw {
  const entries: Raw = {};
  let nextUid = maxUid(doc) + 1;
  for (const entry of doc.entries) {
    const key = doc.rawKeys[entry.id];
    const original = key !== undefined ? doc.rawEntries[key] : undefined;
    let outKey = key;
    let uid: unknown;
    if (outKey !== undefined) {
      uid =
        original && original.uid !== undefined
          ? original.uid
          : /^\d+$/.test(outKey)
            ? Number(outKey)
            : nextUid++;
    } else {
      uid = nextUid;
      outKey = String(nextUid);
      nextUid += 1;
    }
    let finalKey = outKey;
    while (Object.prototype.hasOwnProperty.call(entries, finalKey)) {
      finalKey = String(nextUid);
      uid = nextUid;
      nextUid += 1;
    }
    entries[finalKey] = stEntryFields(entry, original ?? {}, uid);
  }
  return {
    ...doc.raw,
    name: doc.name,
    entries,
    extensions: asDict(doc.raw.extensions),
    scan_depth: doc.scanDepth,
    token_budget: doc.budgetChars,
    recursive_scanning: doc.recursive,
  };
}

/** A book view of the document, for activation previews. */
export function loreDocumentToBook(doc: LoreDocument, id: string): Lorebook {
  return {
    id,
    name: doc.name,
    entries: doc.entries.slice(),
    scanDepth: doc.scanDepth,
    budgetChars: doc.budgetChars,
    recursive: doc.recursive,
  };
}

/** Lookup table by entry id. */
export function loreIndex(entries: readonly LoreEntry[]): Map<string, LoreEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

/** Copies one entry under a fresh id; keys are cloned too. */
export function cloneEntry(entry: LoreEntry, entries: readonly LoreEntry[] = []): LoreEntry {
  const taken = new Set(entries.map((item) => item.id));
  let id = createId("lore");
  while (taken.has(id)) id = createId("lore");
  const title =
    entry.title.trim() === ""
      ? ""
      : entry.title.endsWith("（副本）")
        ? entry.title
        : entry.title + "（副本）";
  return { ...entry, id, title, keys: entry.keys.slice(), secondaryKeys: entry.secondaryKeys.slice() };
}

/** Rewrites the order field to follow the current sort, 10 apart. */
export function applySortAsOrder(
  entries: readonly LoreEntry[],
  sort: LoreSortKey,
  dir: LoreSortDir,
): LoreEntry[] {
  return sortEntries(entries, sort, dir).map((entry, index) => ({ ...entry, order: index * 10 }));
}

export function setEnabled(entry: LoreEntry, enabled: boolean): LoreEntry {
  return { ...entry, enabled };
}

export function assignGroup(entry: LoreEntry, group: string): LoreEntry {
  return { ...entry, group: group.trim() };
}

export function clearGroup(entry: LoreEntry): LoreEntry {
  return { ...entry, group: "" };
}

export function shiftOrder(entry: LoreEntry, delta: number): LoreEntry {
  const value = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return { ...entry, order: Math.max(0, entry.order + value) };
}

/** Moves the selected entries one slot up or down, keeping their order. */
export function moveEntries(
  entries: readonly LoreEntry[],
  ids: ReadonlySet<string>,
  delta: -1 | 1,
): LoreEntry[] {
  const list = [...entries];
  const moving = list.filter((entry) => ids.has(entry.id));
  if (moving.length === 0) return list;
  const rest = list.filter((entry) => !ids.has(entry.id));
  const first = list.findIndex((entry) => ids.has(entry.id));
  const anchor = list.slice(0, Math.max(0, first)).filter((entry) => !ids.has(entry.id)).length;
  const target = Math.min(rest.length - moving.length, Math.max(0, anchor + delta));
  return [...rest.slice(0, target), ...moving, ...rest.slice(target)];
}

/** Moves entries into another document; ids are made unique on the target. */
export function moveEntriesToBook(
  source: LoreDocument,
  target: LoreDocument,
  ids: ReadonlySet<string>,
): { source: LoreDocument; target: LoreDocument; moved: LoreEntry[] } {
  const moving = source.entries.filter((entry) => ids.has(entry.id));
  const remaining = source.entries.filter((entry) => !ids.has(entry.id));
  const taken = new Set(target.entries.map((entry) => entry.id));
  const moved: LoreEntry[] = [];
  for (const entry of moving) {
    let id = entry.id;
    while (taken.has(id)) id = createId("lore");
    taken.add(id);
    const copy: LoreEntry = {
      ...entry,
      id,
      keys: entry.keys.slice(),
      secondaryKeys: entry.secondaryKeys.slice(),
    };
    moved.push(copy);
  }
  return {
    source: { ...source, entries: remaining },
    target: { ...target, entries: [...target.entries, ...moved] },
    moved,
  };
}

/** Counts and character usage shown above the entry list. */
export interface LoreBookStats {
  count: number;
  enabled: number;
  disabled: number;
  /** Content characters of the enabled entries. */
  chars: number;
  /** Enabled entries that do not fit the budget. */
  overBudget: number;
}

export function bookStats(
  entries: readonly LoreEntry[],
  budgetChars: number,
): LoreBookStats {
  let enabled = 0;
  let chars = 0;
  for (const entry of entries) {
    if (!entry.enabled) continue;
    enabled += 1;
    chars += entry.content.length;
  }
  return {
    count: entries.length,
    enabled,
    disabled: entries.length - enabled,
    chars,
    overBudget: budgetOverflow(entries, budgetChars).size,
  };
}
