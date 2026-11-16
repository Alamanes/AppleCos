// Structured reply blocks: the model answers with a single JSON object that
// holds an ordered list of narration, speech and thought blocks. Parsing lives
// here so the live stream, the replay and the archive fallback share one shape.

export type BlockKind = "narration" | "speech" | "thought";

export interface Block {
  kind: BlockKind;
  speaker?: string;
  text: string;
}

/** Live text of the block still being written, safe to show already. */
export interface BlockPreview {
  kind: BlockKind;
  speaker?: string;
  text: string;
}

/** Incremental reader for one structured reply. */
export interface BlockStream {
  push(delta: string): Block[];
  /** Decoded prefix of the open block; null when nothing is settled yet. */
  preview(): BlockPreview | null;
  finish(): Block[];
}

const KINDS: readonly BlockKind[] = ["narration", "speech", "thought"];

function isKind(value: unknown): value is BlockKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** Normalizes one raw entry; null when it carries no usable text. */
function toBlock(entry: unknown): Block | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (text === "") return null;
  const block: Block = { kind: isKind(record.kind) ? record.kind : "narration", text };
  const speaker = typeof record.speaker === "string" ? record.speaker.trim() : "";
  if (speaker !== "") block.speaker = speaker;
  return block;
}

/** Drops code fences so a wrapped answer reads as plain JSON. */
function stripFences(raw: string): string {
  return raw.replace(/```[A-Za-z0-9_-]*/g, "").trim();
}

/** Index just past the object opening at `start`, or -1 while it is unclosed. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The outermost JSON object of the text, fence and prose removed. */
function outermostObject(raw: string): string | null {
  const text = stripFences(raw);
  const start = text.indexOf("{");
  if (start < 0) return null;
  const end = matchBrace(text, start);
  if (end < 0) return null;
  return text.slice(start, end);
}

/** Restores the escapes a truncated string still carries. */
function unescapeLoose(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) break;
    index += 1;
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") continue;
    else if (next === "u") {
      const code = Number.parseInt(value.slice(index + 1, index + 5), 16);
      if (Number.isFinite(code)) {
        out += String.fromCharCode(code);
        index += 4;
      }
    } else out += next;
  }
  // A stream cut mid-string leaves its closing quote and any JSON tail behind.
  return out.replace(/["\]}\s]+$/, "").trim();
}

/**
 * Turns whatever a cut-off tail still holds into a block, so a truncated
 * answer keeps its last line instead of dropping it.
 */
function salvageTail(raw: string): Block | null {
  const text = stripFences(raw).replace(/^[\s[{,]+/, "");
  if (text === "") return null;

  const kindMatch = /"kind"\s*:\s*"(narration|speech|thought)"/.exec(text);
  const speakerMatch = /"speaker"\s*:\s*"([^"]*)"/.exec(text);
  const kind = kindMatch && isKind(kindMatch[1]) ? kindMatch[1] : "narration";

  const key = /"text"\s*:\s*"/.exec(text);
  const body =
    key === null
      ? text.replace(/[{}\[\]"]/g, "").trim()
      : unescapeLoose(text.slice(key.index + key[0].length));

  if (body === "") return null;
  const block: Block = { kind, text: body };
  const speaker = (speakerMatch?.[1] ?? "").trim();
  if (speaker !== "") block.speaker = speaker;
  return block;
}

const HEX_DIGITS = "0123456789abcdefABCDEF";

/**
 * Incremental decoder for the block object that is still being written. It
 * walks the JSON one character at a time, so a value split across deltas is
 * never shown half-decoded: partially arrived escapes, \uXXXX runs and
 * surrogate pairs stay pending until they are complete.
 */
function createBlockScanner() {
  // Structural position: which part of the block object is being read.
  let phase:
    | "key"
    | "keyString"
    | "colon"
    | "value"
    | "valueString"
    | "after"
    | "skip"
    | "scalar"
    | "ended" = "key";
  let name = ""; // field name of the value being read
  let nameEscape = false;
  let target = ""; // field whose string value is open
  let depth = 0; // nesting depth while skipping a non-string value
  let skipInString = false;
  let skipEscape = false;

  // Decoding state of the open string value.
  let buf: string[] = [];
  let text: string[] = []; // aliases the text buffer while it is open
  let escaped = false;
  let hex: string | null = null; // hex digits collected after \u
  let lead: number | null = null; // high surrogate waiting for its pair
  let carry = ""; // high code unit held back across a delta boundary
  let kindValue = "";
  let speakerValue = "";
  let ended = false;

  /** An unpaired high surrogate is never shown; drop it. */
  const dropLead = (): void => {
    lead = null;
  };

  const emitCode = (code: number): void => {
    if (code >= 0xdc00 && code <= 0xdfff && lead !== null) {
      const high = lead;
      lead = null;
      buf.push(String.fromCodePoint(((high - 0xd800) << 10) + (code - 0xdc00) + 0x10000));
      return;
    }
    dropLead();
    if (code >= 0xd800 && code <= 0xdbff) {
      lead = code;
      return;
    }
    // An unpaired low surrogate is never shown; illegal JSON stays readable.
    if (code >= 0xdc00 && code <= 0xdfff) return;
    buf.push(String.fromCharCode(code));
  };

  /** Reads one character inside a string value; true when it closed it. */
  const stringChar = (char: string): boolean => {
    if (hex !== null) {
      if (HEX_DIGITS.includes(char)) {
        hex += char;
        if (hex.length === 4) {
          const code = Number.parseInt(hex, 16);
          hex = null;
          emitCode(code);
        }
        return false;
      }
      // Invalid hex: keep what arrived as literal text and read the rest again.
      buf.push("u" + hex);
      hex = null;
      return stringChar(char);
    }
    if (escaped) {
      escaped = false;
      if (char === "u") {
        hex = "";
        return false;
      }
      dropLead();
      if (char === "n") buf.push("\n");
      else if (char === "t") buf.push("\t");
      else if (char === "r") buf.push("\r");
      else if (char === "b") buf.push("\b");
      else if (char === "f") buf.push("\f");
      else buf.push(char); // quote, backslash, slash and unknown escapes
      return false;
    }
    if (char === "\\") {
      escaped = true;
      return false;
    }
    if (char === '"') return true;
    dropLead();
    buf.push(char);
    return false;
  };

  const startString = (): void => {
    target = name;
    buf = [];
    escaped = false;
    hex = null;
    lead = null;
    if (target === "text") text = buf;
  };

  const closeString = (): void => {
    escaped = false;
    hex = null;
    dropLead();
    if (target === "kind") kindValue = buf.join("").trim();
    else if (target === "speaker") speakerValue = buf.join("").trim();
  };

  const feed = (chunk: string): void => {
    // A high code unit at the very end waits for the next delta.
    if (carry !== "") {
      const first = chunk.charCodeAt(0);
      if (!(first >= 0xdc00 && first <= 0xdfff)) carry = "";
    }
    let source = carry + chunk;
    carry = "";
    if (source !== "") {
      const last = source.charCodeAt(source.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        carry = source.slice(-1);
        source = source.slice(0, -1);
      }
    }
    for (const char of source) {
      if (ended) return;
      if (phase === "keyString") {
        if (nameEscape) {
          name += char;
          nameEscape = false;
        } else if (char === "\\") nameEscape = true;
        else if (char === '"') phase = "colon";
        else name += char;
        continue;
      }
      if (phase === "valueString") {
        if (stringChar(char)) {
          closeString();
          phase = "after";
        }
        continue;
      }
      if (phase === "skip") {
        if (skipInString) {
          if (skipEscape) skipEscape = false;
          else if (char === "\\") skipEscape = true;
          else if (char === '"') skipInString = false;
        } else if (char === '"') skipInString = true;
        else if (char === "{" || char === "[") depth += 1;
        else if (char === "}" || char === "]") {
          depth -= 1;
          if (depth <= 0) phase = "after";
        }
        continue;
      }
      if (char === '"') {
        if (phase === "key" || phase === "after") {
          name = "";
          nameEscape = false;
          phase = "keyString";
        } else if (phase === "value") {
          startString();
          phase = "valueString";
        }
        continue;
      }
      if (char === ":") {
        if (phase === "colon") phase = "value";
        continue;
      }
      if (char === ",") {
        if (phase === "after" || phase === "scalar") phase = "key";
        continue;
      }
      if (char === "{") {
        if (phase === "value") {
          depth = 1;
          skipInString = false;
          skipEscape = false;
          phase = "skip";
        }
        continue;
      }
      if (char === "[") {
        if (phase === "value") {
          depth = 1;
          skipInString = false;
          skipEscape = false;
          phase = "skip";
        }
        continue;
      }
      if (char === "}") {
        ended = true;
        return;
      }
      if (char === " " || char === "\n" || char === "\r" || char === "\t") continue;
      if (phase === "value") phase = "scalar";
    }
  };

  /** Settled prefix, trimmed the way toBlock trims a finished block. */
  const decode = (): BlockPreview | null => {
    const value = text.join("").trim();
    if (value === "") return null;
    const preview: BlockPreview = { kind: isKind(kindValue) ? kindValue : "narration", text: value };
    const speaker = speakerValue.trim();
    if (speaker !== "") preview.speaker = speaker;
    return preview;
  };

  return {
    feed,
    preview(): BlockPreview | null {
      return ended ? null : decode();
    },
    /** The open block as a block, for a reply that stopped mid-object. */
    settle(): Block | null {
      const preview = decode();
      if (!preview) return null;
      const block: Block = { kind: preview.kind, text: preview.text };
      if (preview.speaker !== undefined) block.speaker = preview.speaker;
      return block;
    },
  };
}

/**
 * Reads a complete answer. Returns null when there is no blocks array, when
 * every entry is empty, or when the text is not a JSON object at all.
 */
export function parseBlocks(raw: string): Block[] | null {
  const source = outermostObject(raw);
  if (source === null) return null;
  const parsed = parseJson(source) as { blocks?: unknown } | undefined;
  const entries = parsed && typeof parsed === "object" ? parsed.blocks : undefined;
  if (!Array.isArray(entries)) return null;
  const blocks: Block[] = [];
  for (const entry of entries) {
    const block = toBlock(entry);
    if (block) blocks.push(block);
  }
  return blocks.length === 0 ? null : blocks;
}

/**
 * Incremental parser for one streamed reply. Each push returns only the blocks
 * completed by that delta; a half-written object waits for the next one.
 */
export function createBlockStream(): BlockStream {
  let buffer = "";
  let cursor = 0;
  let started = false;
  let closed = false;
  /** Block start the preview scanner sits on, and how far it has read. */
  let anchor = -1;
  let scanned = 0;
  let scanner = createBlockScanner();

  /** Finds the blocks array, or the first bare block object. */
  const locate = (): void => {
    const array = /"blocks"\s*:\s*\[/.exec(buffer);
    if (array) {
      cursor = array.index + array[0].length;
      started = true;
      return;
    }
    if (/"blocks"\s*:/.test(buffer)) return; // array bracket not here yet

    const first = buffer.search(/[\[{]/);
    if (first < 0) return;
    if (buffer[first] === "[") {
      cursor = first + 1;
      started = true;
      return;
    }
    // A bare object becomes a candidate only once it closes and reads as a block.
    const end = matchBrace(buffer, first);
    if (end < 0) return;
    if (toBlock(parseJson(buffer.slice(first, end))) === null) return;
    cursor = first;
    started = true;
  };

  /** Pulls every closed block object out of the buffer. */
  const drain = (): Block[] => {
    const out: Block[] = [];
    if (!started) locate();
    if (!started) return out;
    while (!closed) {
      while (cursor < buffer.length && buffer[cursor] !== "{" && buffer[cursor] !== "]") {
        cursor += 1;
      }
      if (cursor >= buffer.length) break;
      if (buffer[cursor] === "]") {
        closed = true;
        cursor += 1;
        break;
      }
      const end = matchBrace(buffer, cursor);
      if (end < 0) break;
      const chunk = buffer.slice(cursor, end);
      cursor = end;
      const block = toBlock(parseJson(chunk));
      if (block) out.push(block);
    }
    return out;
  };

  /**
   * Keeps the preview scanner on the open block, reading only what the last
   * delta added. False when no block object is currently open.
   */
  const sync = (): boolean => {
    if (!started || cursor >= buffer.length || buffer[cursor] !== "{") return false;
    if (anchor !== cursor) {
      anchor = cursor;
      scanned = cursor;
      scanner = createBlockScanner();
    }
    if (scanned < buffer.length) {
      scanner.feed(buffer.slice(scanned));
      scanned = buffer.length;
    }
    return true;
  };

  return {
    push(delta: string): Block[] {
      buffer += delta;
      return drain();
    },
    preview(): BlockPreview | null {
      if (closed) return null;
      return sync() ? scanner.preview() : null;
    },
    finish(): Block[] {
      const out = drain();
      if (closed) return out;
      // The live decoder owns the escapes, so a cut-off block keeps exactly
      // the text the preview already showed.
      const pending = sync() ? scanner.settle() : null;
      closed = true;
      // A reply that never opened a blocks array still gets its text shown.
      if (!started) {
        const whole = parseBlocks(buffer);
        if (whole) {
          out.push(...whole);
          return out;
        }
      }
      if (pending) {
        out.push(pending);
        return out;
      }
      const salvaged = salvageTail(buffer.slice(cursor));
      if (salvaged) out.push(salvaged);
      return out;
    },
  };
}

/** Plain text of a reply, for copying and for the transcript archive. */
export function blocksToText(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "speech") {
        return block.speaker ? `${block.speaker}：${block.text}` : block.text;
      }
      if (block.kind === "thought") {
        return block.speaker ? `${block.speaker}（心声）：${block.text}` : block.text;
      }
      return block.text;
    })
    .join("\n\n");
}
