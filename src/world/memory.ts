// Layered memory: world facts, cast facts and player facts.
// Edits are copy-on-write and softening keeps a fact recoverable.

import { createId, type MemoryFact, type MemoryState, type MemoryTier } from "./types";

/** Options for writing a fact. */
export interface MemoryWriteOptions {
  owner?: string;
  keywords?: string[];
  importance?: number;
  kind?: string;
  now?: number;
  turn?: number;
}

/** Options for reading facts. */
export interface MemoryQuery {
  /** Free text; matched against the fact body and its keywords. */
  text?: string;
  tiers?: readonly MemoryTier[];
  /** Card id; use "" for world and player facts. */
  owner?: string;
  includeSoftened?: boolean;
  limit?: number;
}

/** Options for the prompt-ready summary. */
export interface MemorySummaryOptions {
  budgetChars?: number;
  tiers?: readonly MemoryTier[];
  /** Card id, when only one character's memory is wanted. */
  owner?: string;
  /** Display names for cast ids, so the summary reads naturally. */
  names?: Record<string, string>;
  includeSoftened?: boolean;
}

/** Empty layered memory. */
export function emptyMemory(): MemoryState {
  return { facts: [] };
}

function clampImportance(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/** Splits text into searchable terms; Chinese runs become bigrams. */
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const part of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (part === "") continue;
    if (/^[\u4e00-\u9fff]+$/.test(part) && part.length > 2) {
      for (let index = 0; index + 2 <= part.length; index += 1) {
        out.add(part.slice(index, index + 2));
      }
      continue;
    }
    out.add(part);
  }
  return [...out];
}

/** How much two facts overlap; used to update instead of duplicating. */
function textOverlap(left: string, right: string): number {
  const a = new Set(tokenize(left));
  if (a.size === 0) return 0;
  const b = new Set(tokenize(right));
  let shared = 0;
  for (const term of b) if (a.has(term)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

/**
 * Adds one fact. A restatement of a fact already known for the same owner
 * updates it instead of piling up a near duplicate in the prompt.
 */
export function rememberFact(
  memory: MemoryState,
  tier: MemoryTier,
  text: string,
  options: MemoryWriteOptions = {},
): { memory: MemoryState; fact: MemoryFact } {
  const now = options.now ?? Date.now();
  const body = text.trim();
  const owner = options.owner ?? "";
  const importance = clampImportance(options.importance ?? 0.5);
  const incoming = options.keywords ? [...options.keywords] : [];

  const existing = memory.facts.find(
    (fact) =>
      fact.tier === tier &&
      fact.owner === owner &&
      fact.softenedAt === null &&
      (fact.text === body || textOverlap(fact.text, body) >= 0.8),
  );
  if (existing) {
    const fact: MemoryFact = {
      ...existing,
      // The newer wording wins; the older keywords stay searchable.
      text: body,
      keywords: [...new Set([...existing.keywords, ...incoming])].slice(0, 24),
      importance: Math.max(existing.importance, importance),
      kind: options.kind ?? existing.kind,
      updatedAt: now,
      lastUsedTurn: options.turn ?? existing.lastUsedTurn,
    };
    return { memory: { facts: memory.facts.map((item) => (item.id === fact.id ? fact : item)) }, fact };
  }

  const fact: MemoryFact = {
    id: createId("mem"),
    tier,
    owner,
    text: body,
    keywords: incoming,
    importance,
    kind: options.kind ?? "event",
    createdAt: now,
    updatedAt: now,
    lastUsedTurn: options.turn ?? 0,
    softenedAt: null,
    softenedImportance: null,
    softReason: "",
  };
  return { memory: { facts: [...memory.facts, fact] }, fact };
}

/** Patches one active fact. Unknown ids are ignored. */
export function updateFact(
  memory: MemoryState,
  id: string,
  patch: Partial<Pick<MemoryFact, "text" | "importance" | "keywords" | "kind">>,
  now = Date.now(),
): MemoryState {
  return {
    facts: memory.facts.map((fact) => {
      if (fact.id !== id) return fact;
      return {
        ...fact,
        text: patch.text !== undefined ? patch.text.trim() : fact.text,
        importance: patch.importance !== undefined ? clampImportance(patch.importance) : fact.importance,
        keywords: patch.keywords !== undefined ? [...patch.keywords] : fact.keywords,
        kind: patch.kind !== undefined ? patch.kind : fact.kind,
        updatedAt: now,
      };
    }),
  };
}

/** Softens a fact: it leaves the prompt but stays recoverable. */
export function softenFact(
  memory: MemoryState,
  id: string,
  reason: string,
  now = Date.now(),
): MemoryState {
  return {
    facts: memory.facts.map((fact) => {
      if (fact.id !== id || fact.softenedAt !== null) return fact;
      return {
        ...fact,
        softenedAt: now,
        softenedImportance: fact.importance,
        softReason: reason,
        importance: clampImportance(fact.importance * 0.4),
        updatedAt: now,
      };
    }),
  };
}

/** Brings a softened fact back with its original weight. */
export function restoreFact(memory: MemoryState, id: string, now = Date.now()): MemoryState {
  return {
    facts: memory.facts.map((fact) => {
      if (fact.id !== id || fact.softenedAt === null) return fact;
      return {
        ...fact,
        softenedAt: null,
        importance: clampImportance(fact.softenedImportance ?? fact.importance),
        softenedImportance: null,
        softReason: "",
        updatedAt: now,
      };
    }),
  };
}

/** Removes a fact for good; used by rewind and by explicit drops. */
export function dropFact(memory: MemoryState, id: string): MemoryState {
  return { facts: memory.facts.filter((fact) => fact.id !== id) };
}

/** Scores and returns facts, best first. */
export function queryMemory(memory: MemoryState, query: MemoryQuery = {}): MemoryFact[] {
  const terms = query.text ? tokenize(query.text) : [];
  const tiers = query.tiers && query.tiers.length > 0 ? new Set<MemoryTier>(query.tiers) : null;
  const scored: { fact: MemoryFact; score: number }[] = [];

  for (const fact of memory.facts) {
    if (!query.includeSoftened && fact.softenedAt !== null) continue;
    if (tiers && !tiers.has(fact.tier)) continue;
    if (query.owner !== undefined && fact.owner !== query.owner) continue;
    let score = fact.importance * 2 + 1;
    if (terms.length > 0) {
      const haystack = `${fact.text} ${fact.keywords.join(" ")}`.toLowerCase();
      let hits = 0;
      for (const term of terms) if (haystack.includes(term)) hits += 1;
      if (hits === 0) continue;
      score += hits * 1.5;
    }
    scored.push({ fact, score });
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.fact.updatedAt - left.fact.updatedAt;
  });
  const limit = query.limit ?? 20;
  return scored.slice(0, Math.max(0, limit)).map((item) => item.fact);
}

/** Marks facts as used at a turn, which nudges recency ordering. */
export function markUsed(memory: MemoryState, ids: readonly string[], turn: number): MemoryState {
  const used = new Set(ids);
  if (used.size === 0) return memory;
  return {
    facts: memory.facts.map((fact) =>
      used.has(fact.id) ? { ...fact, lastUsedTurn: turn } : fact,
    ),
  };
}

/** Groups facts into the three tiers, best first inside each tier. */
export function groupMemory(
  memory: MemoryState,
  options: MemorySummaryOptions = {},
): { tier: MemoryTier; owner: string; facts: MemoryFact[] }[] {
  const allowed = options.tiers && options.tiers.length > 0 ? new Set<MemoryTier>(options.tiers) : null;
  const buckets = new Map<string, { tier: MemoryTier; owner: string; facts: MemoryFact[] }>();
  for (const fact of memory.facts) {
    if (!options.includeSoftened && fact.softenedAt !== null) continue;
    if (allowed && !allowed.has(fact.tier)) continue;
    if (options.owner !== undefined && fact.owner !== options.owner) continue;
    const key = `${fact.tier}:${fact.owner}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.facts.push(fact);
    else buckets.set(key, { tier: fact.tier, owner: fact.owner, facts: [fact] });
  }
  const order: Record<MemoryTier, number> = { world: 0, player: 1, cast: 2 };
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      facts: [...bucket.facts].sort(
        (left, right) => right.importance - left.importance || right.updatedAt - left.updatedAt,
      ),
    }))
    .sort((left, right) => {
      const byTier = order[left.tier] - order[right.tier];
      return byTier !== 0 ? byTier : left.owner.localeCompare(right.owner);
    });
}

/** Summary text plus how many facts the budget left out. */
export interface MemorySummary {
  text: string;
  /** Facts that exist but did not fit; callers can tell the model they exist. */
  omitted: number;
}

/** Renders layered memory for the prompt inside a character budget. */
export function summarizeMemoryReport(
  memory: MemoryState,
  options: MemorySummaryOptions = {},
): MemorySummary {
  const budget = options.budgetChars ?? 1600;
  if (budget <= 0) return { text: "", omitted: 0 };
  const groups = groupMemory(memory, options);
  const blocks: string[] = [];
  let used = 0;
  let shown = 0;

  for (const group of groups) {
    const heading =
      group.tier === "world"
        ? "世界"
        : group.tier === "player"
          ? `玩家 · ${options.names?.[group.owner] ?? "玩家"}`
          : `角色 · ${options.names?.[group.owner] ?? group.owner}`;
    const lines: string[] = [];
    for (const fact of group.facts) {
      const line = `- ${fact.text}`;
      if (used + line.length + heading.length + 4 > budget) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 0) continue;
    const block = `[${heading}]\n${lines.join("\n")}`;
    if (used + block.length > budget && blocks.length > 0) continue;
    blocks.push(block);
    shown += lines.length;
    used += block.length;
  }

  const total = groups.reduce((sum, group) => sum + group.facts.length, 0);
  return { text: blocks.join("\n\n"), omitted: Math.max(0, total - shown) };
}

/** Renders layered memory for the prompt inside a character budget. */
export function summarizeMemory(memory: MemoryState, options: MemorySummaryOptions = {}): string {
  return summarizeMemoryReport(memory, options).text;
}

/** Character count of everything the summary could show. */
export function memoryChars(memory: MemoryState, options: MemorySummaryOptions = {}): number {
  return summarizeMemory(memory, { ...options, budgetChars: Number.MAX_SAFE_INTEGER }).length;
}

/** Number of active facts per tier. */
export function memoryCounts(memory: MemoryState): Record<MemoryTier, number> {
  const counts: Record<MemoryTier, number> = { world: 0, cast: 0, player: 0 };
  for (const fact of memory.facts) if (fact.softenedAt === null) counts[fact.tier] += 1;
  return counts;
}
