// Session lifecycle: create, restore, snapshot every turn, rewind.
// State is plain data and every helper is copy-on-write, so a rewind is pure.

import { createOverlay } from "./card";
import { emptyLoreRuntime } from "./lorebook";
import { emptyMemory } from "./memory";
import {
  createId,
  normalizePlayer,
  relationOf,
  SESSION_VERSION,
  type CharacterOverlay,
  type LoreActivationLog,
  type LoreActivationResult,
  type LoreEntryRuntime,
  type LoreRuntimeState,
  type MemoryFact,
  type MemoryState,
  type PlayerIdentity,
  type SceneState,
  type SessionMeta,
  type SessionState,
  type TurnSnapshot,
  type World,
  type WorldMessage,
  type WorldMessageRole,
} from "./types";

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDict(value: unknown): Dict {
  return isDict(value) ? value : {};
}

function textOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function roleOf(value: unknown): WorldMessageRole {
  if (value === "system" || value === "assistant" || value === "user") return value;
  return "assistant";
}

/** Options for a brand new session. */
export interface CreateSessionOptions {
  /** Reuse the id the host assigned, so both sides agree on the session. */
  id?: string;
  cast?: readonly string[];
  player?: Partial<PlayerIdentity>;
  title?: string;
  scene?: Partial<SceneState>;
  now?: number;
  /** Start without the focus card's opening line. */
  skipOpening?: boolean;
}

/** A line to append to the transcript. */
export interface NewMessage {
  role: WorldMessageRole;
  content: string;
  speaker?: string;
  cardId?: string;
  hidden?: boolean;
  turn?: number;
  id?: string;
  timestamp?: number;
}

/** Cards that take part by default: everyone except the narrator card. */
export function defaultCast(world: World): string[] {
  const ids = Object.keys(world.cards).filter((id) => id !== world.narratorId);
  return ids.length > 0 ? ids : Object.keys(world.cards);
}

function playerFor(world: World, patch: Partial<PlayerIdentity> | undefined): PlayerIdentity {
  return normalizePlayer(world.player, patch);
}

function sceneFor(patch: Partial<SceneState> | undefined): SceneState {
  return {
    location: patch?.location ?? "",
    time: patch?.time ?? "",
    summary: patch?.summary ?? "",
  };
}

function openMessage(
  world: World,
  cast: readonly string[],
  sessionId: string,
  now: number,
): WorldMessage | null {
  const focusId = cast[0];
  if (!focusId) return null;
  const card = world.cards[focusId];
  if (!card || card.firstMessage.trim() === "") return null;
  return {
    id: `${sessionId}_open`,
    role: "assistant",
    speaker: card.name,
    content: card.firstMessage,
    turn: 0,
    timestamp: now,
    hidden: false,
    cardId: focusId,
  };
}

/** Creates a session for a world; the caller stores the result. */
export function createSession(world: World, options: CreateSessionOptions = {}): SessionState {
  const now = options.now ?? Date.now();
  const id = options.id ?? createId("session");
  const requested = options.cast && options.cast.length > 0 ? [...options.cast] : defaultCast(world);
  const cast = requested.filter((cardId) => world.cards[cardId] !== undefined);
  const player = playerFor(world, options.player);
  const meta: SessionMeta = {
    id,
    worldId: world.id,
    title: options.title ?? world.name,
    cast,
    playerName: player.name,
    turn: 0,
    createdAt: now,
    updatedAt: now,
  };
  const overlays: Record<string, CharacterOverlay> = {};
  // A new scene inherits the world's long-term affection for each card.
  for (const cardId of cast) {
    overlays[cardId] = { ...createOverlay(cardId, now), affinity: relationOf(world.relations, cardId) };
  }
  const opening = options.skipOpening ? null : openMessage(world, cast, id, now);

  return {
    version: SESSION_VERSION,
    meta,
    player,
    messages: opening ? [opening] : [],
    memory: emptyMemory(),
    overlays,
    scene: sceneFor(options.scene),
    lore: emptyLoreRuntime(0),
    loreLog: { turn: 0, rounds: 0, budgetChars: 0, usedChars: 0, activated: [], skipped: [] },
    turns: [],
  };
}

function copyFact(fact: MemoryFact): MemoryFact {
  return { ...fact, keywords: [...fact.keywords] };
}

function copyRuntime(runtime: LoreRuntimeState): LoreRuntimeState {
  const entries: Record<string, LoreEntryRuntime> = {};
  for (const [id, value] of Object.entries(runtime.entries)) entries[id] = { ...value };
  return { turn: runtime.turn, entries };
}

function copyLog(log: LoreActivationLog): LoreActivationLog {
  return {
    ...log,
    activated: log.activated.map((item) => ({ ...item })),
    skipped: log.skipped.map((item) => ({ ...item })),
  };
}

function copyOverlay(overlay: CharacterOverlay): CharacterOverlay {
  return { ...overlay, tags: [...overlay.tags], notes: [...overlay.notes] };
}

/** Deep copy of a session; safe to hand to a snapshot or a store. */
export function cloneSession(session: SessionState): SessionState {
  const overlays: Record<string, CharacterOverlay> = {};
  for (const [id, overlay] of Object.entries(session.overlays)) overlays[id] = copyOverlay(overlay);
  return {
    version: session.version,
    meta: { ...session.meta, cast: [...session.meta.cast] },
    player: { ...session.player },
    messages: session.messages.map((message) => ({ ...message })),
    memory: { facts: session.memory.facts.map(copyFact) },
    overlays,
    scene: { ...session.scene },
    lore: copyRuntime(session.lore),
    loreLog: copyLog(session.loreLog),
    turns: session.turns.map((snapshot) => copySnapshot(snapshot)),
  };
}

function copySnapshot(snapshot: TurnSnapshot): TurnSnapshot {
  return {
    ...snapshot,
    messageIds: [...snapshot.messageIds],
    scene: { ...snapshot.scene },
    memory: { facts: snapshot.memory.facts.map(copyFact) },
    lore: copyRuntime(snapshot.lore),
    loreLog: copyLog(snapshot.loreLog),
  };
}

/** Appends one line and bumps updatedAt. */
export function appendMessage(
  session: SessionState,
  input: NewMessage,
  now = Date.now(),
): SessionState {
  const next = cloneSession(session);
  const message: WorldMessage = {
    id: input.id ?? createId("msg"),
    role: input.role,
    speaker: input.speaker ?? "",
    content: input.content,
    turn: input.turn ?? session.meta.turn,
    timestamp: input.timestamp ?? now,
    hidden: input.hidden === true,
    cardId: input.cardId ?? "",
  };
  next.messages.push(message);
  next.meta.updatedAt = now;
  return next;
}

/** Marks a turn as finished and moves the counter forward. */
export function advanceTurn(session: SessionState, now = Date.now()): SessionState {
  const next = cloneSession(session);
  next.meta.turn = Math.max(1, session.meta.turn + 1);
  next.meta.updatedAt = now;
  return next;
}

/** Replaces the scene block. */
export function setScene(
  session: SessionState,
  patch: Partial<SceneState>,
  now = Date.now(),
): SessionState {
  const next = cloneSession(session);
  next.scene = { ...session.scene, ...patch };
  next.meta.updatedAt = now;
  return next;
}

/** Writes the lore activation of a request back into the session. */
export function absorbLore(session: SessionState, result: LoreActivationResult): SessionState {
  const next = cloneSession(session);
  next.lore = copyRuntime(result.runtime);
  next.loreLog = copyLog(result.log);
  return next;
}

/** Patches one character overlay, creating it when the card is new. */
export function updateOverlay(
  session: SessionState,
  cardId: string,
  patch: Partial<Omit<CharacterOverlay, "cardId" | "updatedAt">>,
  now = Date.now(),
): SessionState {
  const next = cloneSession(session);
  const base = next.overlays[cardId] ?? createOverlay(cardId, now);
  next.overlays[cardId] = {
    ...base,
    ...patch,
    tags: patch.tags ? [...patch.tags] : base.tags,
    notes: patch.notes ? [...patch.notes] : base.notes,
    cardId,
    updatedAt: now,
  };
  next.meta.updatedAt = now;
  return next;
}

/** Stores the current state as this turn's snapshot, replacing an old one. */
export function snapshotTurn(session: SessionState, summary = "", now = Date.now()): SessionState {
  const next = cloneSession(session);
  const snapshot: TurnSnapshot = {
    id: `turn_${session.meta.id}_${session.meta.turn}`,
    turn: session.meta.turn,
    createdAt: now,
    summary,
    messageIds: session.messages.map((message) => message.id),
    scene: { ...session.scene },
    memory: { facts: session.memory.facts.map(copyFact) },
    lore: copyRuntime(session.lore),
    loreLog: copyLog(session.loreLog),
  };
  next.turns = [...next.turns.filter((item) => item.turn !== snapshot.turn), snapshot].sort(
    (left, right) => left.turn - right.turn,
  );
  next.meta.updatedAt = now;
  return next;
}

/** Keeps only the newest snapshots, so long sessions stay small. */
export function pruneSnapshots(session: SessionState, keep: number): SessionState {
  const limit = Math.max(1, Math.floor(keep));
  if (session.turns.length <= limit) return session;
  const next = cloneSession(session);
  next.turns = next.turns.slice(-limit);
  return next;
}

function fromSnapshot(session: SessionState, snapshot: TurnSnapshot, now: number): SessionState {
  const next = cloneSession(session);
  const wanted = new Set(snapshot.messageIds);
  const kept = session.messages.filter((message) => wanted.has(message.id));
  // Stored ids can be missing when the state and transcript came from
  // different files; fall back to the turn number in that case.
  next.messages =
    kept.length > 0 || snapshot.messageIds.length === 0
      ? kept
      : session.messages.filter((message) => message.turn <= snapshot.turn);
  next.memory = { facts: snapshot.memory.facts.map(copyFact) };
  next.scene = { ...snapshot.scene };
  next.lore = copyRuntime(snapshot.lore);
  next.loreLog = copyLog(snapshot.loreLog);
  next.meta.turn = snapshot.turn;
  next.meta.updatedAt = now;
  next.turns = session.turns.filter((item) => item.turn <= snapshot.turn).map(copySnapshot);
  return next;
}

/** Truncates by turn number when no snapshot was recorded. */
function truncateToTurn(session: SessionState, turn: number, now: number): SessionState {
  const next = cloneSession(session);
  next.messages = session.messages.filter((message) => message.turn <= turn);
  next.meta.turn = Math.max(0, Math.floor(turn));
  next.meta.updatedAt = now;
  next.turns = session.turns.filter((item) => item.turn <= turn).map(copySnapshot);
  return next;
}

/** Rewinds to the end of a given turn. Pure: the input session is untouched. */
export function rewindSession(session: SessionState, turn: number, now = Date.now()): SessionState {
  const snapshot = session.turns.find((item) => item.turn === turn);
  if (snapshot) return fromSnapshot(session, snapshot, now);
  return truncateToTurn(session, turn, now);
}

/** Counters for the session list and the header. */
export function sessionStats(session: SessionState): {
  messages: number;
  chars: number;
  turns: number;
  facts: number;
  activeFacts: number;
} {
  let chars = 0;
  for (const message of session.messages) chars += message.content.length;
  let activeFacts = 0;
  for (const fact of session.memory.facts) if (fact.softenedAt === null) activeFacts += 1;
  return {
    messages: session.messages.length,
    chars,
    turns: session.meta.turn,
    facts: session.memory.facts.length,
    activeFacts,
  };
}

function normalizeFact(raw: unknown): MemoryFact | null {
  if (!isDict(raw)) return null;
  const text = textOf(raw.text).trim();
  if (text === "") return null;
  const tier = raw.tier === "world" || raw.tier === "cast" || raw.tier === "player" ? raw.tier : "world";
  return {
    id: textOf(raw.id) || createId("mem"),
    tier,
    owner: textOf(raw.owner),
    text,
    keywords: stringsOf(raw.keywords),
    importance: Math.min(1, Math.max(0, numOf(raw.importance, 0.5))),
    kind: textOf(raw.kind, "event"),
    createdAt: numOf(raw.createdAt, Date.now()),
    updatedAt: numOf(raw.updatedAt, Date.now()),
    lastUsedTurn: numOf(raw.lastUsedTurn, 0),
    softenedAt: typeof raw.softenedAt === "number" ? raw.softenedAt : null,
    softenedImportance: typeof raw.softenedImportance === "number" ? raw.softenedImportance : null,
    softReason: textOf(raw.softReason),
  };
}

function normalizeMemory(raw: unknown): MemoryState {
  const record = asDict(raw);
  const facts: MemoryFact[] = [];
  if (Array.isArray(record.facts)) {
    for (const item of record.facts) {
      const fact = normalizeFact(item);
      if (fact) facts.push(fact);
    }
  }
  return { facts };
}

function normalizeRuntime(raw: unknown): LoreRuntimeState {
  const record = asDict(raw);
  const entries: Record<string, LoreEntryRuntime> = {};
  for (const [id, value] of Object.entries(asDict(record.entries))) {
    const item = asDict(value);
    entries[id] = {
      stickyUntil: numOf(item.stickyUntil, 0),
      cooldownUntil: numOf(item.cooldownUntil, 0),
      lastTurn: numOf(item.lastTurn, 0),
      hits: numOf(item.hits, 0),
    };
  }
  return { turn: numOf(record.turn, 0), entries };
}

function normalizeLog(raw: unknown): LoreActivationLog {
  const record = asDict(raw);
  const activated: LoreActivationLog["activated"] = [];
  for (const item of Array.isArray(record.activated) ? record.activated : []) {
    const entry = asDict(item);
    const reason = entry.reason;
    const position = entry.position;
    activated.push({
      entryId: textOf(entry.entryId),
      title: textOf(entry.title),
      reason:
        reason === "constant" || reason === "sticky" || reason === "keyword" || reason === "recursive"
          ? reason
          : "keyword",
      round: numOf(entry.round, 0),
      position:
        position === "before_char" || position === "after_char" || position === "at_depth"
          ? position
          : "before_char",
      chars: numOf(entry.chars, 0),
    });
  }
  const skipped: LoreActivationLog["skipped"] = [];
  for (const item of Array.isArray(record.skipped) ? record.skipped : []) {
    const entry = asDict(item);
    const reason = entry.reason;
    skipped.push({
      entryId: textOf(entry.entryId),
      title: textOf(entry.title),
      reason:
        reason === "disabled" ||
        reason === "delay" ||
        reason === "cooldown" ||
        reason === "probability" ||
        reason === "group" ||
        reason === "budget" ||
        reason === "no-key" ||
        reason === "selective"
          ? reason
          : "no-key",
    });
  }
  return {
    turn: numOf(record.turn, 0),
    rounds: numOf(record.rounds, 0),
    budgetChars: numOf(record.budgetChars, 0),
    usedChars: numOf(record.usedChars, 0),
    activated,
    skipped,
  };
}

export function restoreMessage(raw: unknown, fallbackTurn = 0): WorldMessage | null {
  if (!isDict(raw)) return null;
  const content = textOf(raw.content);
  if (content === "") return null;
  return {
    id: textOf(raw.id) || createId("msg"),
    role: roleOf(raw.role),
    speaker: textOf(raw.speaker),
    content,
    turn: numOf(raw.turn, fallbackTurn),
    timestamp: numOf(raw.timestamp, Date.now()),
    hidden: raw.hidden === true,
    cardId: textOf(raw.cardId),
  };
}

function normalizeSnapshot(raw: unknown): TurnSnapshot | null {
  if (!isDict(raw)) return null;
  const turn = numOf(raw.turn, 0);
  return {
    id: textOf(raw.id) || `turn_${turn}`,
    turn,
    createdAt: numOf(raw.createdAt, Date.now()),
    summary: textOf(raw.summary),
    messageIds: stringsOf(raw.messageIds),
    scene: {
      location: textOf(asDict(raw.scene).location),
      time: textOf(asDict(raw.scene).time),
      summary: textOf(asDict(raw.scene).summary),
    },
    memory: normalizeMemory(raw.memory),
    lore: normalizeRuntime(raw.lore),
    loreLog: normalizeLog(raw.loreLog),
  };
}

/** Rebuilds a full session from stored JSON, tolerant of older shapes. */
export function restoreSession(raw: unknown, world: World): SessionState {
  const record = asDict(raw);
  const metaRaw = asDict(record.meta);
  const now = Date.now();
  const player = playerFor(world, {
    name: textOf(metaRaw.playerName) || textOf(asDict(record.player).name) || undefined,
    description: textOf(asDict(record.player).description) || undefined,
    persona: textOf(asDict(record.player).persona) || undefined,
  });
  const requested = stringsOf(metaRaw.cast);
  const known = requested.filter((cardId) => world.cards[cardId] !== undefined);
  // A stored empty cast means every character is gone, not that the session is new.
  const cast = known.length > 0 ? known : Array.isArray(metaRaw.cast) ? [] : defaultCast(world);

  const overlays: Record<string, CharacterOverlay> = {};
  for (const cardId of cast) overlays[cardId] = createOverlay(cardId, now);
  for (const [cardId, value] of Object.entries(asDict(record.overlays))) {
    const item = asDict(value);
    const overlay: CharacterOverlay = {
      cardId,
      affinity: numOf(item.affinity, 0),
      tags: stringsOf(item.tags),
      notes: stringsOf(item.notes),
      relationship: textOf(item.relationship),
      updatedAt: numOf(item.updatedAt, now),
    };
    // Death marks are optional: older saves simply lack them.
    if (item.deceased === true) {
      overlay.deceased = true;
      const cause = textOf(item.deathCause);
      if (cause !== "") overlay.deathCause = cause;
      const note = textOf(item.deathNote);
      if (note !== "") overlay.deathNote = note;
      overlay.diedAtTurn = numOf(item.diedAtTurn, 0);
    }
    overlays[cardId] = overlay;
  }

  const turn = numOf(metaRaw.turn, 0);
  const messages: WorldMessage[] = [];
  for (const item of Array.isArray(record.messages) ? record.messages : []) {
    const message = restoreMessage(item, turn);
    if (message) messages.push(message);
  }

  const turns: TurnSnapshot[] = [];
  for (const item of Array.isArray(record.turns) ? record.turns : []) {
    const snapshot = normalizeSnapshot(item);
    if (snapshot) turns.push(snapshot);
  }
  turns.sort((left, right) => left.turn - right.turn);

  return {
    version: SESSION_VERSION,
    meta: {
      id: textOf(metaRaw.id) || createId("session"),
      worldId: textOf(metaRaw.worldId) || world.id,
      title: textOf(metaRaw.title) || world.name,
      // A card the overlays mark as dead stays out even if a stale cast lists it.
      cast: cast.filter((cardId) => overlays[cardId]?.deceased !== true),
      playerName: player.name,
      turn,
      createdAt: numOf(metaRaw.createdAt, now),
      updatedAt: numOf(metaRaw.updatedAt, now),
    },
    player,
    messages,
    memory: normalizeMemory(record.memory),
    overlays,
    scene: {
      location: textOf(asDict(record.scene).location),
      time: textOf(asDict(record.scene).time),
      summary: textOf(asDict(record.scene).summary),
    },
    lore: normalizeRuntime(record.lore),
    loreLog: normalizeLog(record.loreLog),
    turns,
  };
}

/**
 * Combines the stored state with the transcript, which the host keeps in its
 * own file. Messages win over anything embedded in the state.
 */
export function hydrateSession(
  state: unknown,
  messages: readonly WorldMessage[],
  world: World,
): SessionState {
  const session = restoreSession(state, world);
  if (messages.length === 0) return session;
  return { ...session, messages: messages.map((message) => ({ ...message })) };
}
