// Persistence for worlds, cards and sessions, aligned with the generated Go
// client. Payloads cross the IPC as raw JSON strings on both sides.
//
// The store is an interface so screens never call the client directly and a
// local-storage backend can stand in during `vite dev`.

import { isMyGo } from "mygo-runtime";

import {
  Library,
  Sessions,
  type Artifact,
  type SessionData,
  type SessionSummary,
} from "../mygo";

import { normalizeCard } from "./card";
import { projectMessages, restoreMessage, slimSnapshots } from "./session";
import {
  createId,
  normalizePlayer,
  type CharacterCard,
  type SessionState,
  type World,
  type WorldMessage,
} from "./types";

/** A conversation as loaded from disk, state still unnormalized. */
export interface LoadedSession {
  summary: SessionSummary;
  /** Page-defined session.json; normalize with restoreSession(state, world). */
  state: unknown;
  /** Raw transcript lines, exactly as the host stored them. */
  raw: string[];
  /** Parsed display lines; malformed entries are skipped. */
  messages: WorldMessage[];
}

/** What every backend must provide. Every method is async. */
export interface WorldStore {
  listWorlds(): Promise<Artifact[]>;
  loadWorld(id: string): Promise<World | null>;
  /** Returns the id the host stored the world under. */
  saveWorld(world: World): Promise<string>;
  removeWorld(id: string): Promise<void>;

  listCards(): Promise<Artifact[]>;
  loadCard(id: string): Promise<CharacterCard | null>;
  saveCard(card: CharacterCard): Promise<string>;
  removeCard(id: string): Promise<void>;

  listSessions(): Promise<SessionSummary[]>;
  createSession(worldId: string, title: string): Promise<SessionSummary>;
  loadSession(id: string): Promise<LoadedSession | null>;
  /** Writes the mutable state; the transcript is managed by the two calls below. */
  saveSession(session: SessionState): Promise<SessionSummary>;
  appendMessage(sessionId: string, message: WorldMessage): Promise<void>;
  replaceMessages(sessionId: string, messages: readonly WorldMessage[]): Promise<SessionSummary>;
  removeSession(id: string): Promise<void>;
}

/** The Library methods the store uses; `Library` satisfies this as is. */
export interface LibraryBackend {
  listWorlds(): Promise<Artifact[]>;
  loadWorld(id: string): Promise<string>;
  saveWorld(id: string, raw: string): Promise<string>;
  deleteWorld(id: string): Promise<void>;
  listCards(): Promise<Artifact[]>;
  loadCard(id: string): Promise<string>;
  saveCard(id: string, raw: string): Promise<string>;
  deleteCard(id: string): Promise<void>;
}

/** The Sessions methods the store uses; `Sessions` satisfies this as is. */
export interface SessionsBackend {
  list(): Promise<SessionSummary[]>;
  create(worldId: string, title: string): Promise<SessionSummary>;
  load(id: string): Promise<SessionData>;
  saveState(id: string, raw: string): Promise<SessionSummary>;
  appendMessage(id: string, raw: string): Promise<void>;
  replaceMessages(id: string, messages: string[]): Promise<SessionSummary>;
  delete(id: string): Promise<void>;
}

function parseJson<T>(body: string | null | undefined): T | null {
  if (body === null || body === undefined || body.trim() === "") return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function textOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Loads a world and normalizes every embedded card. Scalar fields are coerced
 * too: a hand-edited null must not reach the prompt builder, which trims them.
 */
export function normalizeWorld(raw: World): World {
  const cards: Record<string, CharacterCard> = {};
  for (const [id, card] of Object.entries(raw.cards ?? {})) {
    cards[id] = normalizeCard(card?.raw ?? card, { id, bookId: `${id}_book` });
  }
  return {
    ...raw,
    name: textOf(raw.name),
    summary: textOf(raw.summary),
    setting: textOf(raw.setting),
    rules: textOf(raw.rules),
    narratorId: textOf(raw.narratorId),
    player: normalizePlayer(raw.player),
    cards,
  };
}

/** Parses stored transcript lines; malformed lines are skipped. */
function parseMessages(lines: readonly string[]): WorldMessage[] {
  const messages: WorldMessage[] = [];
  for (const line of lines) {
    const message = restoreMessage(parseJson<unknown>(line));
    if (message) messages.push(message);
  }
  return messages;
}

/** Backend on the generated IPC client. */
export function createGoStore(
  library: LibraryBackend = Library,
  sessions: SessionsBackend = Sessions,
): WorldStore {
  return {
    async listWorlds() {
      return library.listWorlds();
    },
    async loadWorld(id) {
      const raw = parseJson<World>(await library.loadWorld(id));
      if (!raw) return null;
      return normalizeWorld({ ...raw, id: raw.id || id });
    },
    async saveWorld(world) {
      const id = await library.saveWorld(world.id, JSON.stringify(world));
      return id || world.id;
    },
    async removeWorld(id) {
      await library.deleteWorld(id);
    },

    async listCards() {
      return library.listCards();
    },
    async loadCard(id) {
      const raw = parseJson<unknown>(await library.loadCard(id));
      return raw === null ? null : normalizeCard(raw, { id });
    },
    async saveCard(card) {
      const id = await library.saveCard(card.id, JSON.stringify(card.raw ?? card));
      return id || card.id;
    },
    async removeCard(id) {
      await library.deleteCard(id);
    },

    async listSessions() {
      return sessions.list();
    },
    async createSession(worldId, title) {
      return sessions.create(worldId, title);
    },
    async loadSession(id) {
      const data = await sessions.load(id);
      const raw = data.messages ?? [];
      return {
        summary: data.summary,
        state: parseJson<unknown>(data.state),
        raw,
        messages: parseMessages(raw),
      };
    },
    async saveSession(session) {
      // The host reads title, worldId and the timestamps from the top level of
      // session.json, so mirror them beside the nested meta. Timestamps go out
      // as ISO strings, the shape Sessions.Create writes; the host probe reads
      // strings, so a numeric mirror would blank the whole summary.
      //
      // The text lives in messages.jsonl only. This file keeps a header per
      // line (ids and turns, which the transcript cannot carry) and elides
      // snapshot memory that repeats, so the state stays far below the size cap.
      const lastMessage = session.messages[session.messages.length - 1];
      const state = {
        ...session,
        messages: undefined,
        projection: projectMessages(session.messages),
        turns: slimSnapshots(session.turns),
        title: session.meta.title,
        worldId: session.meta.worldId,
        createdAt: isoOf(session.meta.createdAt),
        updatedAt: isoOf(session.meta.updatedAt),
        messageCount: session.messages.length,
        lastMessageId: lastMessage ? lastMessage.id : "",
      };
      return sessions.saveState(session.meta.id, JSON.stringify(state));
    },
    async appendMessage(sessionId, message) {
      await sessions.appendMessage(sessionId, JSON.stringify(message));
    },
    async replaceMessages(sessionId, messages) {
      return sessions.replaceMessages(
        sessionId,
        messages.map((message) => JSON.stringify(message)),
      );
    },
    async removeSession(id) {
      await sessions.delete(id);
    },
  };
}

const DEFAULT_PREFIX = "applecos:v1";

function safeStorage(): Storage | null {
  try {
    return (globalThis.localStorage as Storage | undefined) ?? null;
  } catch {
    // Storage access throws in locked or sandboxed contexts.
    return null;
  }
}

interface KeyValueArea {
  keys(): string[];
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

function makeArea(storage: Storage | null, memory: Map<string, string>): KeyValueArea {
  if (storage) {
    return {
      keys: () => {
        const out: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key !== null) out.push(key);
        }
        return out;
      },
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
      remove: (key) => storage.removeItem(key),
    };
  }
  return {
    keys: () => [...memory.keys()],
    get: (key) => memory.get(key) ?? null,
    set: (key, value) => {
      memory.set(key, value);
    },
    remove: (key) => {
      memory.delete(key);
    },
  };
}

/** One stored conversation in the local backend, shaped like SessionData. */
interface LocalSession {
  summary: SessionSummary;
  state: unknown;
  messages: WorldMessage[];
}

function isoOf(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function artifactOf(kind: string, id: string, name: string, body: string, updatedAt: number): Artifact {
  return { id, name, kind, bytes: body.length, updatedAt: isoOf(updatedAt) };
}

/** Local-storage backend; also works in memory when storage is unavailable. */
export function createLocalStore(prefix = DEFAULT_PREFIX): WorldStore {
  const area = makeArea(safeStorage(), new Map<string, string>());
  const worldKey = (id: string): string => `${prefix}:worlds:${id}`;
  const cardKey = (id: string): string => `${prefix}:cards:${id}`;
  const sessionKey = (id: string): string => `${prefix}:sessions:${id}`;

  const idsUnder = (root: string): string[] =>
    area
      .keys()
      .filter((key) => key.startsWith(root))
      .map((key) => key.slice(root.length))
      .filter((id) => id !== "");

  const readWorld = (id: string): World | null => {
    const raw = parseJson<World>(area.get(worldKey(id)));
    return raw === null ? null : normalizeWorld({ ...raw, id: raw.id || id });
  };

  const readSession = (id: string): LocalSession | null =>
    parseJson<LocalSession>(area.get(sessionKey(id)));

  const writeSession = (id: string, record: LocalSession): LocalSession => {
    area.set(sessionKey(id), JSON.stringify(record));
    return record;
  };

  return {
    async listWorlds() {
      const out: Artifact[] = [];
      for (const id of idsUnder(`${prefix}:worlds:`)) {
        const body = area.get(worldKey(id)) ?? "";
        const world = parseJson<World>(body);
        if (!world) continue;
        out.push(artifactOf("world", id, world.name || id, body, world.updatedAt ?? 0));
      }
      return out.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async loadWorld(id) {
      return readWorld(id);
    },
    async saveWorld(world) {
      const id = world.id || createId("world");
      area.set(worldKey(id), JSON.stringify({ ...world, id }));
      return id;
    },
    async removeWorld(id) {
      area.remove(worldKey(id));
    },

    async listCards() {
      const out: Artifact[] = [];
      for (const id of idsUnder(`${prefix}:cards:`)) {
        const body = area.get(cardKey(id)) ?? "";
        const card = parseJson<{ name?: string; updatedAt?: number }>(body);
        if (!card) continue;
        const stamp = typeof card.updatedAt === "number" ? card.updatedAt : Date.now();
        out.push(artifactOf("card", id, card.name || id, body, stamp));
      }
      return out;
    },
    async loadCard(id) {
      const raw = parseJson<unknown>(area.get(cardKey(id)));
      if (raw === null) return null;
      return normalizeCard(raw, { id });
    },
    async saveCard(card) {
      const id = card.id || createId("card");
      area.set(cardKey(id), JSON.stringify({ ...card, id }));
      return id;
    },
    async removeCard(id) {
      area.remove(cardKey(id));
    },

    async listSessions() {
      const out: SessionSummary[] = [];
      for (const id of idsUnder(`${prefix}:sessions:`)) {
        const record = readSession(id);
        if (record) out.push(record.summary);
      }
      return out.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async createSession(worldId, title) {
      const id = createId("session");
      const now = Date.now();
      const summary: SessionSummary = {
        id,
        title,
        worldId,
        messages: 0,
        createdAt: isoOf(now),
        updatedAt: isoOf(now),
      };
      writeSession(id, {
        summary,
        state: {
          meta: { id, worldId, title, cast: [], playerName: "", turn: 0, createdAt: now, updatedAt: now },
        },
        messages: [],
      });
      return summary;
    },
    async loadSession(id) {
      const record = readSession(id);
      if (!record) return null;
      return {
        summary: record.summary,
        state: record.state,
        raw: record.messages.map((message) => JSON.stringify(message)),
        messages: record.messages,
      };
    },
    async saveSession(session) {
      const id = session.meta.id;
      const existing = readSession(id);
      const messages = session.messages.length > 0 ? session.messages : (existing?.messages ?? []);
      const now = isoOf(Date.now());
      const summary: SessionSummary = {
        id,
        title: session.meta.title,
        worldId: session.meta.worldId,
        messages: messages.length,
        createdAt: existing?.summary.createdAt ?? isoOf(session.meta.createdAt),
        updatedAt: now,
      };
      writeSession(id, {
        summary,
        state: { ...session, messages: [] },
        messages,
      });
      return summary;
    },
    async appendMessage(sessionId, message) {
      const record = readSession(sessionId);
      if (!record) throw new Error(`会话不存在：${sessionId}`);
      const messages = [...record.messages, message];
      writeSession(sessionId, {
        ...record,
        messages,
        summary: { ...record.summary, messages: messages.length, updatedAt: isoOf(Date.now()) },
      });
    },
    async replaceMessages(sessionId, messages) {
      const record = readSession(sessionId);
      if (!record) throw new Error(`会话不存在：${sessionId}`);
      const summary: SessionSummary = {
        ...record.summary,
        messages: messages.length,
        updatedAt: isoOf(Date.now()),
      };
      writeSession(sessionId, { summary, state: record.state, messages: [...messages] });
      return summary;
    },
    async removeSession(id) {
      area.remove(sessionKey(id));
    },
  };
}

let current: WorldStore | null = null;

/** The store every screen shares: the host library once IPC exists. */
export function getStore(): WorldStore {
  if (!current) current = isMyGo() ? createGoStore() : createLocalStore();
  return current;
}

/** Swaps the backend, e.g. to createLocalStore() during `vite dev`. */
export function useStore(store: WorldStore): void {
  current = store;
}
