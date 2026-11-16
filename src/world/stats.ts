/**
 * Session usage numbers for the rail panel.
 *
 * Everything here comes from what the provider or the prompt builder actually
 * produced. A number that was never reported stays `null` or absent so the
 * panel can print an em dash instead of a zero that looks measured.
 */

/** One section of the system prompt, measured in characters and estimated tokens. */
export interface ContextSectionStat {
  title: string;
  chars: number;
  tokens: number;
}

/** Token counts of a single assistant turn, exactly as the provider reported them. */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Usage of one session: cumulative totals, the last turn, and the context mix. */
export interface SessionStats {
  turns: number;
  cumulative: { input: number; output: number; cacheRead: number; cacheWrite: number };
  lastTurn: TurnUsage | null;
  /** cacheRead / (input + cacheRead); null when the endpoint never reported usage. */
  cacheHitRate: number | null;
  context: ContextSectionStat[];
  contextTotalChars: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** A non-negative token count, or 0 when the field is missing or not a number. */
function tokenOf(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** A stored count; only used to recover shape, never to invent a value. */
function countOf(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

export function emptySessionStats(): SessionStats {
  return {
    turns: 0,
    cumulative: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    lastTurn: null,
    cacheHitRate: null,
    context: [],
    contextTotalChars: 0,
  };
}

/** Restores a stored record; unknown or older shapes fall back to empty defaults. */
export function normalizeSessionStats(value: unknown): SessionStats {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return emptySessionStats();
  const cumulative = asRecord(record.cumulative);
  const last = asRecord(record.lastTurn);
  const context: ContextSectionStat[] = [];
  for (const item of Array.isArray(record.context) ? record.context : []) {
    const entry = asRecord(item);
    const title = typeof entry.title === "string" ? entry.title : "";
    if (title === "") continue;
    context.push({
      title,
      chars: countOf(entry.chars),
      tokens: countOf(entry.tokens),
    });
  }
  const total = countOf(record.contextTotalChars);
  const rate = record.cacheHitRate;
  return {
    turns: countOf(record.turns),
    cumulative: {
      input: countOf(cumulative.input),
      output: countOf(cumulative.output),
      cacheRead: countOf(cumulative.cacheRead),
      cacheWrite: countOf(cumulative.cacheWrite),
    },
    lastTurn:
      Object.keys(last).length === 0
        ? null
        : {
            input: countOf(last.input),
            output: countOf(last.output),
            cacheRead: countOf(last.cacheRead),
            cacheWrite: countOf(last.cacheWrite),
            total: countOf(last.total),
          },
    cacheHitRate: typeof rate === "number" && Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : null,
    context,
    contextTotalChars: total > 0 ? total : context.reduce((sum, item) => sum + item.chars, 0),
  };
}

/** Cache hit rate from the reported counts; null means the endpoint stayed silent. */
export function cacheHitRateOf(input: number, cacheRead: number): number | null {
  const fresh = Math.max(0, input);
  const cached = Math.max(0, cacheRead);
  const seen = fresh + cached;
  if (seen <= 0) return null;
  return Math.min(1, Math.max(0, cached / seen));
}

/**
 * Folds one turn of Pi `Usage` into the session. Without a report only the turn
 * counter moves, so no zero is ever recorded as a measurement.
 */
export function accumulateUsage(stats: SessionStats, usage: unknown): SessionStats {
  const turns = stats.turns + 1;
  if (usage === null || usage === undefined || typeof usage !== "object") {
    return { ...stats, turns, lastTurn: null };
  }
  const record = usage as Record<string, unknown>;
  const input = tokenOf(record.input);
  const output = tokenOf(record.output);
  const cacheRead = tokenOf(record.cacheRead);
  const cacheWrite = tokenOf(record.cacheWrite);
  const reported = tokenOf(record.totalTokens);
  const total = reported > 0 ? reported : input + output + cacheRead + cacheWrite;
  const cumulative = {
    input: stats.cumulative.input + input,
    output: stats.cumulative.output + output,
    cacheRead: stats.cumulative.cacheRead + cacheRead,
    cacheWrite: stats.cumulative.cacheWrite + cacheWrite,
  };
  return {
    ...stats,
    turns,
    cumulative,
    lastTurn: { input, output, cacheRead, cacheWrite, total },
    cacheHitRate: cacheHitRateOf(cumulative.input, cumulative.cacheRead),
  };
}

/** CJK, kana, Hangul and fullwidth forms count as one token per character. */
function isWideChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x3ffff)
  );
}

/**
 * Character-based token estimate for display: one wide character counts as one
 * token, four narrow ones as one. This is an approximation, not a tokenizer.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += isWideChar(char) ? 1 : 0.25;
  return Math.round(tokens);
}

/** Measures assembled prompt sections in their real order; empty bodies drop out. */
export function sectionsToStats(
  sections: readonly { title: string; body: string }[],
): ContextSectionStat[] {
  const stats: ContextSectionStat[] = [];
  for (const section of sections) {
    const body = section.body.trim();
    if (body === "") continue;
    stats.push({ title: section.title, chars: body.length, tokens: estimateTokens(body) });
  }
  return stats;
}
