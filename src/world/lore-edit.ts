// Filtering, sorting and scroll math for the world book manager.
//
// Everything here works on normalized entries; the document itself lives in
// lore-doc.ts and knows how to write the original JSON back to disk.

import { compareEntries } from "./lorebook";
import type { LoreEntry, LoreSkipReason } from "./types";

/** One toolbar filter chip. */
export type LoreFilter =
  | "enabled"
  | "disabled"
  | "constant"
  | "probability"
  | "group"
  | "nokey"
  | "regex"
  | "overbudget";

/** Chips in the order the toolbar shows them. */
export const LORE_FILTERS: ReadonlyArray<{ id: LoreFilter; label: string }> = [
  { id: "enabled", label: "启用" },
  { id: "disabled", label: "停用" },
  { id: "constant", label: "常驻" },
  { id: "probability", label: "概率<100" },
  { id: "group", label: "有组" },
  { id: "nokey", label: "无键" },
  { id: "regex", label: "正则" },
  { id: "overbudget", label: "超预算" },
];

/** Fields the sort select can order by. */
export type LoreSortKey =
  | "order"
  | "custom"
  | "title"
  | "tokens"
  | "depth"
  | "uid"
  | "trigger"
  | "relevance";

export const LORE_SORTS: ReadonlyArray<{ id: LoreSortKey; label: string }> = [
  { id: "order", label: "排序值" },
  { id: "custom", label: "手动顺序" },
  { id: "title", label: "标题" },
  { id: "tokens", label: "字符数" },
  { id: "depth", label: "深度" },
  { id: "uid", label: "条目编号" },
  { id: "trigger", label: "触发概率" },
  { id: "relevance", label: "相关度" },
];

export type LoreSortDir = "asc" | "desc";

/** Search text, chips, sort field and direction. */
export interface LoreView {
  query: string;
  filters: LoreFilter[];
  sort: LoreSortKey;
  dir: LoreSortDir;
}

/** Extra inputs the filters and sort need. */
export interface LoreFilterOptions {
  budgetChars: number;
  /** Scanned text for the relevance sort; omitted keeps the static heuristic. */
  haystack?: string;
}

/** Enabled entries that do not fit the budget, in injection order. */
export function budgetOverflow(
  entries: readonly LoreEntry[],
  budgetChars: number,
): Set<string> {
  const budget = Number.isFinite(budgetChars) ? Math.max(0, Math.floor(budgetChars)) : 0;
  const overflow = new Set<string>();
  let used = 0;
  for (const entry of sortEntries(entries.filter((item) => item.enabled), "order", "asc")) {
    const chars = entry.content.length;
    if (used + chars > budget) overflow.add(entry.id);
    else used += chars;
  }
  return overflow;
}

/** Sorts a copy; ties fall back to the book order so results stay stable. */
export function sortEntries(
  rows: readonly LoreEntry[],
  sort: LoreSortKey,
  dir: LoreSortDir,
  haystack?: string,
): LoreEntry[] {
  const sign = dir === "desc" ? -1 : 1;
  if (sort === "custom") {
    const index = new Map(rows.map((row, position) => [row.id, position]));
    return [...rows].sort(
      (left, right) => ((index.get(left.id) ?? 0) - (index.get(right.id) ?? 0)) * sign,
    );
  }
  return [...rows].sort((left, right) => {
    const primary = compareBySort(left, right, sort, haystack);
    if (primary !== 0) return primary * sign;
    return compareEntries(left, right);
  });
}

function compareBySort(
  left: LoreEntry,
  right: LoreEntry,
  sort: LoreSortKey,
  haystack?: string,
): number {
  switch (sort) {
    case "order":
      return left.order - right.order;
    case "title":
      return left.title.localeCompare(right.title);
    case "tokens":
      return left.content.length - right.content.length;
    case "depth":
      return left.depth - right.depth;
    case "uid":
      return uidOf(left) - uidOf(right);
    case "trigger":
      return triggerOf(left) - triggerOf(right);
    case "relevance":
      return relevanceOf(left, haystack) - relevanceOf(right, haystack);
    case "custom":
      return 0;
    default:
      return 0;
  }
}

function uidOf(entry: LoreEntry): number {
  const parsed = Number.parseInt(entry.id, 10);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function triggerOf(entry: LoreEntry): number {
  const chance = entry.useProbability ? Math.max(0, Math.min(100, entry.probability)) : 100;
  return chance + Math.min(5, entry.keys.length) * 2;
}

function relevanceOf(entry: LoreEntry, haystack?: string): number {
  let score = entry.enabled ? 0 : -100;
  if (entry.constant) score += 60;
  if (haystack && haystack !== "") {
    const text = entry.caseSensitive ? haystack : haystack.toLowerCase();
    for (const key of entry.keys) {
      const needle = entry.caseSensitive ? key.trim() : key.trim().toLowerCase();
      if (needle !== "" && text.includes(needle)) score += 25;
    }
  }
  score += Math.min(entry.keys.length, 5) * 4;
  if (entry.useProbability) score += entry.probability / 20;
  return score;
}

/** Query words (all must hit) plus chips (all must pass), then sorted. */
export function filterRows(
  rows: readonly LoreEntry[],
  view: LoreView,
  options: LoreFilterOptions,
): LoreEntry[] {
  const terms = view.query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term !== "");
  const overflow = view.filters.includes("overbudget")
    ? budgetOverflow(rows, options.budgetChars)
    : null;
  const matched = rows.filter((row) => {
    if (terms.length > 0) {
      const haystack = [row.title, row.keys.join(" "), row.secondaryKeys.join(" "), row.content]
        .join("\n")
        .toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return false;
    }
    for (const filter of view.filters) {
      if (!passesFilter(row, filter, overflow)) return false;
    }
    return true;
  });
  return sortEntries(matched, view.sort, view.dir, options.haystack);
}

function passesFilter(
  entry: LoreEntry,
  filter: LoreFilter,
  overflow: ReadonlySet<string> | null,
): boolean {
  switch (filter) {
    case "enabled":
      return entry.enabled;
    case "disabled":
      return !entry.enabled;
    case "constant":
      return entry.constant;
    case "probability":
      return entry.useProbability && entry.probability < 100;
    case "group":
      return entry.group.trim() !== "";
    case "nokey":
      return entry.keys.every((key) => key.trim() === "");
    case "regex":
      return entry.useRegex;
    case "overbudget":
      return overflow ? overflow.has(entry.id) : false;
    default:
      return true;
  }
}

/** Index range to render, padded by the overscan rows above and below. */
export function visibleRange(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  overscan = 8,
): { start: number; end: number } {
  const height = rowHeight > 0 ? rowHeight : 44;
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const size = Number.isFinite(viewport) ? Math.max(0, viewport) : 0;
  const pad = Math.max(0, Math.floor(overscan));
  return {
    start: Math.max(0, Math.floor(top / height) - pad),
    end: Math.ceil((top + size) / height) + pad,
  };
}

/** Keeps a cursor index inside the list; -1 when there is nothing to select. */
export function clampSelection(index: number, count: number): number {
  if (count <= 0) return -1;
  if (!Number.isFinite(index)) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(index)));
}

/** Skip reasons plus the "did not match at all" case. */
export type LoreSkipLabel = LoreSkipReason | "miss";

/** Short label for a skipped entry. */
export function skipReasonText(reason: LoreSkipLabel): string {
  switch (reason) {
    case "disabled":
      return "未启用";
    case "cooldown":
      return "冷却中";
    case "delay":
      return "延迟未到";
    case "no-key":
      return "无键";
    case "selective":
      return "次级键否决";
    case "probability":
      return "概率未中";
    case "group":
      return "组内落选";
    case "budget":
      return "预算不足";
    case "miss":
      return "未命中";
    default:
      return "未命中";
  }
}

/** One sentence explaining why an entry stayed out. */
export function skipReasonHint(reason: LoreSkipLabel): string {
  switch (reason) {
    case "disabled":
      return "这一条被停用了，不会参与触发。";
    case "cooldown":
      return "这一条还在冷却，等冷却结束才会再次触发。";
    case "delay":
      return "延迟未到：条目要等开场若干轮之后才开始判断。";
    case "no-key":
      return "主键没有命中，也没有设置常驻。";
    case "selective":
      return "主键命中了，但次级键按当前逻辑拒绝了这一轮。";
    case "probability":
      return "概率判定没有通过，换个随机结果会命中。";
    case "group":
      return "同一个组里已经有别的条目先入选了。";
    case "budget":
      return "字符预算已经用尽，这一条放不进这一轮。";
    case "miss":
      return "本轮扫描的文本里找不到它的主键。";
    default:
      return "这一条没有进入提示词。";
  }
}

/** Title for an untitled entry, taken from its first key or content. */
export function suggestTitle(entry: LoreEntry): string {
  const key = entry.keys.find((item) => item.trim() !== "");
  if (key) return key.trim().slice(0, 40);
  const line = entry.content
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item !== "");
  if (line) return line.slice(0, 24);
  return "未命名条目";
}
