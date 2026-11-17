// Lorebook activation: constants, key triggers, recursion, probability,
// groups, sticky and cooldown, all under one character budget.
//
// The pass is pure: state goes in, the next state and a log come out.

import {
  DEFAULT_LORE_BUDGET_CHARS,
  DEFAULT_MAX_RECURSION,
  DEFAULT_SCAN_DEPTH,
  type LoreActivationLog,
  type LoreActivationReason,
  type LoreActivationResult,
  type Lorebook,
  type LoreEntry,
  type LoreEntryRuntime,
  type LorePlacements,
  type LoreRuntimeState,
  type LoreSkipReason,
  type WorldMessage,
} from "./types";

/** Tuning knobs for one activation pass. */
export interface LoreActivationOptions {
  /** Random source for probability and group weights; injectable for tests. */
  random?: () => number;
  /** Extra text appended to every scan, such as a pending player line. */
  extraText?: string;
  /** Recursive passes after the first; defaults to 3. */
  maxRecursion?: number;
}

interface Candidate {
  entry: LoreEntry;
  reason: LoreActivationReason;
}

const EMPTY_ENTRY_RUNTIME: LoreEntryRuntime = Object.freeze({
  stickyUntil: 0,
  cooldownUntil: 0,
  lastTurn: 0,
  hits: 0,
});

/** Fresh runtime state for a new book. */
export function emptyLoreRuntime(turn = 0): LoreRuntimeState {
  return { turn, entries: {} };
}

/** Orders entries the way the book expects: explicit order, then title, then id. */
export function compareEntries(left: LoreEntry, right: LoreEntry): number {
  if (left.order !== right.order) return left.order - right.order;
  const byTitle = left.title.localeCompare(right.title);
  if (byTitle !== 0) return byTitle;
  return left.id.localeCompare(right.id);
}

/** Runs one activation pass for the given turn. */
export function activateLore(
  book: Lorebook,
  messages: readonly WorldMessage[],
  runtime: LoreRuntimeState,
  turn: number,
  options: LoreActivationOptions = {},
): LoreActivationResult {
  const random = options.random ?? Math.random;
  const maxRecursion = Math.max(0, options.maxRecursion ?? DEFAULT_MAX_RECURSION);
  const budgetChars = Math.max(0, book.budgetChars);
  const entries = [...book.entries].sort(compareEntries);

  const log: LoreActivationLog = {
    turn,
    rounds: 0,
    budgetChars,
    usedChars: 0,
    activated: [],
    skipped: [],
  };
  const placements: LorePlacements = { before: [], after: [], depth: [] };
  const runtimeEntries: Record<string, LoreEntryRuntime> = { ...runtime.entries };
  const active = new Map<string, LoreEntry>();
  const skipReasons = new Map<string, LoreSkipReason>();
  const scanCache = new Map<number, string>();
  // Regexes are compiled once per pass rather than once per key test.
  const keyCache = createKeyMatchCache();
  // A group may contribute only one active entry for the whole pass.
  const consumedGroups = new Set<string>();

  const stateOf = (entry: LoreEntry): LoreEntryRuntime =>
    runtimeEntries[entry.id] ?? EMPTY_ENTRY_RUNTIME;

  const skip = (entry: LoreEntry, reason: LoreSkipReason): void => {
    if (skipReasons.has(entry.id)) return;
    skipReasons.set(entry.id, reason);
    log.skipped.push({ entryId: entry.id, title: entry.title, reason });
  };

  const scanFor = (entry: LoreEntry): string => {
    const depth = entry.scanDepth ?? book.scanDepth;
    const cached = scanCache.get(depth);
    if (cached !== undefined) return cached;
    const text = buildScanText(messages, depth, options.extraText);
    scanCache.set(depth, text);
    return text;
  };

  let recursionText = "";
  for (let round = 0; round <= maxRecursion; round += 1) {
    if (!book.recursive && round > 0) break;
    log.rounds = round + 1;
    const candidates: Candidate[] = [];

    for (const entry of entries) {
      if (active.has(entry.id)) continue;
      if (!entry.enabled) {
        if (round === 0) skip(entry, "disabled");
        continue;
      }
      if (round > 0 && entry.preventRecursion) continue;

      const state = stateOf(entry);
      if (round === 0) {
        if (turn < state.stickyUntil) {
          candidates.push({ entry, reason: "sticky" });
          continue;
        }
        if (turn < state.cooldownUntil) {
          skip(entry, "cooldown");
          continue;
        }
        if (entry.delay > 0 && turn <= entry.delay) {
          skip(entry, "delay");
          continue;
        }
        if (entry.constant) {
          candidates.push({ entry, reason: "constant" });
          continue;
        }
      }

      const haystack = recursionText === "" ? scanFor(entry) : `${scanFor(entry)}\n${recursionText}`;
      const outcome = evaluateKeys(entry, haystack, keyCache);
      if (outcome.matched) {
        candidates.push({ entry, reason: round === 0 ? "keyword" : "recursive" });
      } else if (round === 0) {
        skip(entry, skipReasonFor(entry, outcome));
      }
    }

    const grouped = resolveGroups(candidates, random, skip, consumedGroups);
    const rolled = grouped.filter((candidate) => {
      const entry = candidate.entry;
      if (candidate.reason === "sticky" || candidate.reason === "constant") return true;
      if (!entry.useProbability || entry.probability >= 100) return true;
      if (random() * 100 < Math.max(0, entry.probability)) return true;
      skip(entry, "probability");
      return false;
    });

    rolled.sort((left, right) => compareEntries(left.entry, right.entry));
    const fired: LoreEntry[] = [];
    for (const candidate of rolled) {
      const entry = candidate.entry;
      const chars = entry.content.length;
      if (log.usedChars + chars > budgetChars) {
        skip(entry, "budget");
        continue;
      }
      log.usedChars += chars;
      active.set(entry.id, entry);
      fired.push(entry);
      log.activated.push({
        entryId: entry.id,
        title: entry.title,
        reason: candidate.reason,
        round,
        position: entry.position,
        chars,
      });
      runtimeEntries[entry.id] = nextRuntime(stateOf(entry), entry, turn);
      place(entry, placements);
    }

    if (fired.length === 0) break;
    const triggerable = fired.filter((entry) => !entry.excludeRecursion);
    if (triggerable.length === 0) break;
    recursionText = `${recursionText}\n${triggerable.map((entry) => entry.content).join("\n")}`.trim();
  }

  const text = [...placements.before, ...placements.after].join("\n\n");
  return {
    entries: [...active.values()],
    placements,
    log,
    runtime: { turn, entries: runtimeEntries },
    text,
  };
}

/** Result of a single-entry dry run, shown in the detail panel. */
export interface LoreEntryExplanation {
  entryId: string;
  title: string;
  activated: boolean;
  reason: LoreActivationReason | null;
  skip: LoreSkipReason | null;
  chars: number;
  usedChars: number;
  budgetChars: number;
  rounds: number;
}

/** Dry-runs one entry against the given transcript, deterministically. */
export function explainEntry(
  book: Lorebook,
  entry: LoreEntry,
  messages: readonly WorldMessage[],
  turn: number,
  options: LoreActivationOptions = {},
): LoreEntryExplanation {
  const random = options.random ?? (() => 0.5);
  const result = activateLore(
    { ...book, entries: [entry], recursive: false },
    messages,
    emptyLoreRuntime(turn),
    turn,
    { ...options, random },
  );
  const fired = result.log.activated.find((record) => record.entryId === entry.id);
  const skipped = result.log.skipped.find((record) => record.entryId === entry.id);
  return {
    entryId: entry.id,
    title: entry.title,
    activated: fired !== undefined,
    reason: fired ? fired.reason : null,
    skip: skipped ? skipped.reason : null,
    chars: entry.content.length,
    usedChars: result.log.usedChars,
    budgetChars: result.log.budgetChars,
    rounds: result.log.rounds,
  };
}

/** Dry-runs the whole book with fixed randomness so reports stay stable. */
export function previewActivation(
  book: Lorebook,
  messages: readonly WorldMessage[],
  turn: number,
  options: LoreActivationOptions = {},
): LoreActivationResult {
  return activateLore(book, messages, emptyLoreRuntime(turn), turn, {
    ...options,
    random: () => 0.5,
  });
}

/** Builds the text scanned for one depth. 0 scans the whole transcript. */
export function buildScanText(
  messages: readonly WorldMessage[],
  depth: number,
  extraText?: string,
): string {
  const usable = messages.filter((message) => !message.hidden && message.role !== "system");
  const slice = depth > 0 ? usable.slice(-depth) : usable;
  const parts = slice.map((message) =>
    message.speaker ? `${message.speaker}: ${message.content}` : message.content,
  );
  if (extraText && extraText.trim() !== "") parts.push(extraText.trim());
  return parts.join("\n");
}

/** Regexes compiled during one activation pass, keyed by entry and key. */
export interface KeyMatchCache {
  regex: Map<string, RegExp | null>;
}

/** Fresh cache for one pass. */
export function createKeyMatchCache(): KeyMatchCache {
  return { regex: new Map() };
}

/** Longest key pattern accepted as a regular expression. */
const MAX_REGEX_KEY_CHARS = 200;
/** Cap on the text one pattern may scan, bounding catastrophic backtracking. */
const MAX_REGEX_HAYSTACK_CHARS = 20_000;
/** Nested quantifiers such as (a+)+ turn a key into a backtracking trap. */
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)\s*[+*{]/;

/**
 * Whether a key may be compiled at all. Activation runs on the UI thread every
 * turn, so a pathological pattern is dropped instead of risking a freeze.
 */
function usablePattern(needle: string): boolean {
  if (needle.length > MAX_REGEX_KEY_CHARS) return false;
  return !NESTED_QUANTIFIER.test(needle);
}

function compileKey(entry: LoreEntry, needle: string): RegExp | null {
  if (!usablePattern(needle)) return null;
  try {
    return new RegExp(needle, entry.caseSensitive ? "" : "i");
  } catch {
    return null;
  }
}

function compiledKey(entry: LoreEntry, needle: string, cache?: KeyMatchCache): RegExp | null {
  if (!cache) return compileKey(entry, needle);
  const slot = `${entry.id}\u0000${needle}`;
  const cached = cache.regex.get(slot);
  if (cached !== undefined) return cached;
  const compiled = compileKey(entry, needle);
  cache.regex.set(slot, compiled);
  return compiled;
}

/** Literal or regular-expression hit, honouring the entry's case setting. */
function keyHit(
  entry: LoreEntry,
  key: string,
  haystack: string,
  cache?: KeyMatchCache,
): boolean {
  const needle = key.trim();
  if (needle === "") return false;
  if (entry.useRegex) {
    const regex = compiledKey(entry, needle, cache);
    if (regex === null) return false;
    const text =
      haystack.length > MAX_REGEX_HAYSTACK_CHARS
        ? haystack.slice(0, MAX_REGEX_HAYSTACK_CHARS)
        : haystack;
    return regex.test(text);
  }
  if (entry.caseSensitive) return haystack.includes(needle);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Which half of the key test decided the outcome. */
export interface KeyMatchOutcome {
  matched: boolean;
  primary: boolean;
}

/** Primary keys gate the entry; secondary keys refine it through selectiveLogic. */
export function evaluateKeys(
  entry: LoreEntry,
  haystack: string,
  cache?: KeyMatchCache,
): KeyMatchOutcome {
  if (entry.keys.length === 0) return { matched: false, primary: false };
  const primary = entry.keys.some((key) => keyHit(entry, key, haystack, cache));
  if (!primary) return { matched: false, primary: false };
  const secondary = entry.secondaryKeys.filter((key) => key.trim() !== "");
  if (!entry.selective || secondary.length === 0) return { matched: true, primary: true };
  const hits = secondary.filter((key) => keyHit(entry, key, haystack, cache)).length;
  switch (entry.selectiveLogic) {
    // AND ANY: at least one secondary key present.
    case 0:
      return { matched: hits > 0, primary: true };
    // NOT ALL: not every secondary key present.
    case 1:
      return { matched: hits < secondary.length, primary: true };
    // NOT ANY: no secondary key present.
    case 2:
      return { matched: hits === 0, primary: true };
    // AND ALL: every secondary key present.
    case 3:
      return { matched: hits === secondary.length, primary: true };
    default:
      return { matched: hits > 0, primary: true };
  }
}

/** Boolean form of the key test, kept for callers outside the pass. */
export function matchesKeys(
  entry: LoreEntry,
  haystack: string,
  cache?: KeyMatchCache,
): boolean {
  return evaluateKeys(entry, haystack, cache).matched;
}

/** Keeps one entry per group for the whole pass; override entries win outright. */
function resolveGroups(
  candidates: Candidate[],
  random: () => number,
  skip: (entry: LoreEntry, reason: LoreSkipReason) => void,
  consumed: Set<string>,
): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  const loose: Candidate[] = [];
  for (const candidate of candidates) {
    const group = candidate.entry.group.trim();
    if (group === "") {
      loose.push(candidate);
      continue;
    }
    if (consumed.has(group)) {
      skip(candidate.entry, "group");
      continue;
    }
    const list = groups.get(group);
    if (list) list.push(candidate);
    else groups.set(group, [candidate]);
  }
  for (const [group, list] of groups) {
    const only = list[0];
    if (!only) continue;
    if (list.length === 1) {
      loose.push(only);
      consumed.add(group);
      continue;
    }
    const forced = list
      .filter((candidate) => candidate.entry.groupOverride || candidate.reason === "sticky")
      .sort((left, right) => compareEntries(left.entry, right.entry));
    const winner = forced.length > 0 ? forced[0] : weightedPick(list, random);
    if (!winner) continue;
    loose.push(winner);
    consumed.add(group);
    for (const other of list) {
      if (other !== winner) skip(other.entry, "group");
    }
  }
  return loose;
}

/** Distinguishes "no primary key" from "secondary keys rejected the line". */
function skipReasonFor(entry: LoreEntry, outcome: KeyMatchOutcome): LoreSkipReason {
  const hasSecondary = entry.secondaryKeys.some((key) => key.trim() !== "");
  return outcome.primary && entry.selective && hasSecondary ? "selective" : "no-key";
}

/** Picks one candidate by group weight. */
function weightedPick(list: readonly Candidate[], random: () => number): Candidate | undefined {
  if (list.length === 0) return undefined;
  let total = 0;
  for (const candidate of list) total += Math.max(1, candidate.entry.groupWeight);
  let roll = random() * total;
  for (const candidate of list) {
    roll -= Math.max(1, candidate.entry.groupWeight);
    if (roll < 0) return candidate;
  }
  return list[list.length - 1];
}

/** Sticky and cooldown bookkeeping for a freshly fired entry. */
function nextRuntime(
  state: LoreEntryRuntime,
  entry: LoreEntry,
  turn: number,
): LoreEntryRuntime {
  const next: LoreEntryRuntime = { ...state };
  next.lastTurn = turn;
  next.hits = state.hits + 1;
  if (entry.sticky > 0) next.stickyUntil = Math.max(state.stickyUntil, turn + entry.sticky);
  if (entry.cooldown > 0) next.cooldownUntil = Math.max(state.cooldownUntil, turn + entry.cooldown);
  return next;
}

/** Records an entry in the placement it asks for. */
function place(entry: LoreEntry, placements: LorePlacements): void {
  if (entry.position === "before_char") {
    placements.before.push(entry.content);
    return;
  }
  if (entry.position === "after_char") {
    placements.after.push(entry.content);
    return;
  }
  placements.depth.push({
    entryId: entry.id,
    content: entry.content,
    depth: entry.depth,
    role: entry.depthRole,
  });
}

/** Reads a book's defaults, filling anything a partial object left out. */
export function normalizeLorebook(
  raw: Partial<Lorebook> & { entries?: LoreEntry[] },
  fallbackId: string,
  fallbackName: string,
): Lorebook {
  return {
    id: raw.id && raw.id !== "" ? raw.id : fallbackId,
    name: raw.name && raw.name !== "" ? raw.name : fallbackName,
    entries: Array.isArray(raw.entries) ? raw.entries : [],
    scanDepth: typeof raw.scanDepth === "number" ? raw.scanDepth : DEFAULT_SCAN_DEPTH,
    budgetChars:
      typeof raw.budgetChars === "number" ? raw.budgetChars : DEFAULT_LORE_BUDGET_CHARS,
    recursive: raw.recursive !== false,
  };
}
