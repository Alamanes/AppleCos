/**
 * Go-backed library access for the editors.
 *
 * Worlds, character cards and world books live in the Library service; the page
 * only keeps a cache of adapter entries. Legacy localStorage entries are
 * migrated once into the library and never deleted.
 */

import { Library } from "./mygo";
import { entriesToArray, normalizeCard } from "./world/card";
import { createWorldScaffold } from "./world/defaults";
import {
  emptyLoreDocument,
  loreDocumentToBook,
  mergeLoreDocument,
  parseLoreDocument,
  stEntryFields,
  type LoreDocument,
} from "./world/lore-doc";
import {
  createId,
  DEFAULT_PLAYER_NAME,
  normalizePlayer,
  normalizeRelations,
  type CharacterCard,
  type Lorebook,
  type PlayerIdentity,
  type World,
} from "./world/types";
import type { EditorKind, Entry, Library as LibraryView } from "./settings";

type Raw = Record<string, unknown>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LEGACY_KEY = "applecos.library";

function asRecord(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
}

function textOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function safeId(id: string, prefix: string): string {
  return ID_PATTERN.test(id) ? id : createId(prefix);
}

function playerOf(value: unknown): PlayerIdentity {
  // Older worlds have no player block; the normalizer fills the defaults.
  return normalizePlayer(value);
}

/* -------------------------------------------------------------------------
   World records
   ------------------------------------------------------------------------- */

/** Reads a stored world, normalizing the cards it embeds. */
export async function loadWorld(id: string): Promise<World | null> {
  const raw = parseJson(await Library.loadWorld(id));
  const record = asRecord(raw);
  if (Object.keys(record).length === 0) return null;
  const worldId = safeId(id, "world");
  const cards: Record<string, CharacterCard> = {};
  for (const [cardId, card] of Object.entries(asRecord(record.cards))) {
    const source = asRecord(card).raw ?? card;
    cards[cardId] = normalizeCard(source, { id: cardId, bookId: cardId + "_book" });
  }
  return {
    id: worldId,
    name: textOf(record.name, worldId),
    summary: textOf(record.summary),
    setting: textOf(record.setting),
    rules: textOf(record.rules),
    player: playerOf(record.player),
    narratorId: textOf(record.narratorId),
    cards,
    relations: normalizeRelations(record.relations),
    lorebook: readBook(record.lorebook, worldId + "-book", textOf(record.name, "世界书") + "的世界书"),
    createdAt: numberOf(record.createdAt, Date.now()),
    updatedAt: numberOf(record.updatedAt, Date.now()),
  };
}

export async function createWorld(name: string): Promise<string> {
  const id = "world-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  const world = createWorldScaffold(id, name);
  const stored = await Library.saveWorld(world.id, JSON.stringify(world));
  const nextId = stored || world.id;
  await seedWorldArtifacts({ ...world, id: nextId }).catch(() => undefined);
  return nextId;
}

/** Copies a world's embedded cards and book into the standalone library. */
export async function seedWorldArtifacts(world: World): Promise<void> {
  const [cards, books] = await Promise.all([Library.listCards(), Library.listLorebooks()]);
  const cardIds = new Set(cards.map((artifact) => artifact.id));
  const bookIds = new Set(books.map((artifact) => artifact.id));
  for (const [cardId, card] of Object.entries(world.cards)) {
    if (cardIds.has(cardId)) continue;
    cardIds.add(cardId);
    await Library.saveCard(cardId, JSON.stringify(card.raw ?? card)).catch(() => undefined);
  }
  if (world.lorebook.entries.length === 0 || bookIds.has(world.lorebook.id)) return;
  await Library.saveLorebook(world.lorebook.id, JSON.stringify(stBook(world.lorebook))).catch(
    () => undefined,
  );
}

/* -------------------------------------------------------------------------
   Entry adapters
   ------------------------------------------------------------------------- */

function worldEntry(world: World, updatedAt: number): Entry {
  return {
    id: world.id,
    kind: "world",
    title: world.name,
    body: world.setting,
    tags: [],
    extra: {
      tagline: world.summary,
      era: "",
      place: "",
    },
    updatedAt,
  };
}

function cardEntry(card: CharacterCard, updatedAt: number): Entry {
  return {
    id: card.id,
    kind: "character",
    title: card.name,
    body: card.description,
    tags: card.tags.slice(),
    extra: { relation: card.scenario },
    updatedAt,
  };
}

function loreEntry(book: Lorebook, updatedAt: number): Entry {
  const chars = book.entries.reduce((total, entry) => total + entry.content.length, 0);
  return {
    id: book.id,
    kind: "lore",
    title: book.name,
    // Entries are edited in the manager; the list never inlines the whole book.
    body: "",
    tags: [],
    extra: {
      entryCount: String(book.entries.length),
      bytes: String(chars),
    },
    updatedAt,
  };
}

function artifactEntry(kind: EditorKind, id: string, name: string, detail: string, updatedAt: string): Entry {
  return {
    id,
    kind,
    title: name || id,
    body: detail,
    tags: [],
    extra: {},
    updatedAt: Date.parse(updatedAt) || Date.now(),
  };
}

/* -------------------------------------------------------------------------
   Player card: one per world, stored inside the world JSON
   ------------------------------------------------------------------------- */

/** Reads one world's player card as a single editor entry. */
export async function loadPlayerEntry(worldId: string): Promise<Entry> {
  const id = safeId(worldId, "world");
  const raw = parseJson(await Library.loadWorld(id).catch(() => ""));
  const record = asRecord(raw);
  const player = playerOf(record.player);
  return {
    id,
    kind: "player",
    title: player.name,
    body: player.description,
    tags: [],
    extra: { persona: player.persona },
    updatedAt: numberOf(record.updatedAt, Date.now()),
  };
}

/** Writes the player card back into the world, keeping every other field. */
export async function savePlayerEntry(entry: Entry): Promise<Entry> {
  const id = safeId(entry.id, "world");
  const raw = parseJson(await Library.loadWorld(id).catch(() => ""));
  const record = asRecord(raw);
  if (Object.keys(record).length === 0) throw new Error("玩家角色保存在世界里，先选一个世界");
  const player: PlayerIdentity = {
    name: entry.title.trim() || DEFAULT_PLAYER_NAME,
    description: entry.body.trim(),
    persona: (entry.extra.persona ?? "").trim(),
  };
  await Library.saveWorld(id, JSON.stringify({ ...record, player, updatedAt: Date.now() }));
  return loadPlayerEntry(id);
}

/* -------------------------------------------------------------------------
   SillyTavern world book mapping
   ------------------------------------------------------------------------- */

function stEntries(book: Lorebook): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  book.entries.forEach((entry, index) => {
    out[String(index)] = stEntryFields(entry, {}, index);
  });
  return out;
}

function stBook(book: Lorebook): unknown {
  return {
    name: book.name,
    entries: stEntries(book),
    extensions: {},
    scan_depth: book.scanDepth,
    token_budget: book.budgetChars,
    recursive_scanning: book.recursive,
  };
}

function readBook(value: unknown, fallbackId: string, fallbackName: string): Lorebook {
  const record = asRecord(value);
  const entries = entriesToArray(record.entries);
  return {
    id: textOf(record.id, fallbackId),
    name: textOf(record.name, fallbackName),
    entries,
    scanDepth: numberOf(record.scanDepth ?? record.scan_depth, 4),
    budgetChars: numberOf(record.budgetChars ?? record.token_budget, 1200),
    recursive: record.recursive !== false && record.recursive_scanning !== false,
  };
}

function bookFromEntry(base: Lorebook | null, entry: Entry): Lorebook {
  const id = safeId(entry.id, "lorebook");
  const name = entry.title.trim() || (base?.name ?? "世界书");
  // A broken body throws: never replace a book with an empty one.
  const parsed = parseLoreDocument(entry.body, id, name);
  if (!parsed.ok) throw new Error(parsed.error);
  const doc = parsed.doc;
  const book = loreDocumentToBook(doc, id);
  book.name = name;
  // A bare entries map carries no book defaults; keep the stored ones.
  if (base && Object.keys(doc.raw).length === 0) {
    book.scanDepth = base.scanDepth;
    book.budgetChars = base.budgetChars;
    book.recursive = base.recursive;
  }
  return book;
}

/* -------------------------------------------------------------------------
   Load / save / delete
   ------------------------------------------------------------------------- */

async function listWorlds(): Promise<Entry[]> {
  const artifacts = await Library.listWorlds();
  const entries: Entry[] = [];
  for (const artifact of artifacts) {
    const world = await loadWorld(artifact.id).catch(() => null);
    if (world) entries.push(worldEntry(world, Date.parse(artifact.updatedAt) || Date.now()));
    else entries.push(artifactEntry("world", artifact.id, artifact.name, artifact.detail ?? "", artifact.updatedAt));
  }
  return entries;
}

async function listCards(): Promise<Entry[]> {
  const artifacts = await Library.listCards();
  const entries: Entry[] = [];
  for (const artifact of artifacts) {
    const raw = parseJson(await Library.loadCard(artifact.id).catch(() => ""));
    const record = asRecord(raw);
    if (Object.keys(record).length > 0) {
      const card = normalizeCard(record, { id: artifact.id });
      entries.push(cardEntry(card, Date.parse(artifact.updatedAt) || Date.now()));
    } else {
      entries.push(artifactEntry("character", artifact.id, artifact.name, artifact.detail ?? "", artifact.updatedAt));
    }
  }
  return entries;
}

async function listBooks(): Promise<Entry[]> {
  const artifacts = await Library.listLorebooks();
  const entries: Entry[] = [];
  for (const artifact of artifacts) {
    const raw = parseJson(await Library.loadLorebook(artifact.id).catch(() => ""));
    const record = asRecord(raw);
    if (Object.keys(record).length > 0) {
      const book = readBook(record, artifact.id, artifact.name || "世界书");
      entries.push(loreEntry(book, Date.parse(artifact.updatedAt) || Date.now()));
    } else {
      entries.push(artifactEntry("lore", artifact.id, artifact.name, artifact.detail ?? "", artifact.updatedAt));
    }
  }
  return entries;
}

/** Everything the four editor lists show. Memory comes from the live session. */
export async function loadLibrary(memory: Entry[] = []): Promise<LibraryView> {
  const [world, character, lore] = await Promise.all([listWorlds(), listCards(), listBooks()]);
  // The player card belongs to the world file; the editor fills it on demand.
  return { world, character, lore, memory, player: [] };
}

async function saveWorldEntry(entry: Entry): Promise<Entry> {
  const id = safeId(entry.id, "world");
  const base = await loadWorld(id).catch(() => null);
  const scaffold = base ?? createWorldScaffold(id, entry.title);
  const tagline = (entry.extra.tagline ?? "").trim();
  const era = (entry.extra.era ?? "").trim();
  const place = (entry.extra.place ?? "").trim();
  const lines: string[] = [];
  if (era) lines.push("时代：" + era);
  if (place) lines.push("开场地点：" + place);
  const body = entry.body.trim();
  if (body) lines.push(body);
  const world: World = {
    ...scaffold,
    id,
    name: entry.title.trim() || scaffold.name,
    summary: tagline,
    setting: lines.length > 0 ? lines.join("\n") : scaffold.setting,
    updatedAt: Date.now(),
  };
  const stored = await Library.saveWorld(id, JSON.stringify(world));
  const nextId = stored || id;
  await seedWorldArtifacts({ ...world, id: nextId }).catch(() => undefined);
  return worldEntry({ ...world, id: nextId }, Date.now());
}

async function saveCardEntry(entry: Entry): Promise<Entry> {
  const id = safeId(entry.id, "card");
  const existing = parseJson(await Library.loadCard(id).catch(() => ""));
  const record = asRecord(existing);
  const wrapped = Object.keys(asRecord(record.data)).length > 0;
  const data: Raw = wrapped ? { ...asRecord(record.data) } : { ...record };
  data.name = entry.title.trim() || "无名角色";
  data.description = entry.body;
  data.tags = entry.tags.slice();
  data.scenario = (entry.extra.relation ?? "").trim();
  const payload: unknown = wrapped
    ? { ...record, data }
    : {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          ...data,
          personality: "",
          first_mes: "",
          mes_example: "",
          system_prompt: "",
          post_history_instructions: "",
          alternate_greetings: [],
          creator: "AppleCos",
          character_version: "1",
        },
      };
  const stored = await Library.saveCard(id, JSON.stringify(payload));
  const nextId = stored || id;
  const card = normalizeCard(payload, { id: nextId });
  return cardEntry(card, Date.now());
}

async function saveLoreEntry(entry: Entry): Promise<Entry> {
  const id = safeId(entry.id, "lorebook");
  const existing = await loadLoreDocumentById(id);
  const title = entry.title.trim();
  let doc: LoreDocument;
  if (entry.body.trim() === "") {
    // The manager keeps entries in memory; the body only carries the name.
    doc = existing
      ? { ...existing.doc, name: title || existing.doc.name }
      : emptyLoreDocument(title || "世界书");
  } else {
    const parsed = parseLoreDocument(entry.body, id, title || existing?.doc.name || "世界书");
    if (!parsed.ok) throw new Error(parsed.error);
    doc = parsed.doc;
    if (existing && Object.keys(doc.raw).length === 0) {
      doc = {
        ...doc,
        scanDepth: existing.doc.scanDepth,
        budgetChars: existing.doc.budgetChars,
        recursive: existing.doc.recursive,
      };
    }
  }
  if (title) doc = { ...doc, name: title };
  const saved = await saveLoreDocument(id, doc);
  return loreEntry(loreDocumentToBook(saved.doc, saved.id), Date.now());
}

/** Reads one stored world book as an editable document. */
export async function loadLoreDocumentById(
  id: string,
): Promise<{ id: string; doc: LoreDocument } | null> {
  let text: string;
  try {
    text = await Library.loadLorebook(id);
  } catch (error) {
    // Missing file means a new book; every other failure must surface.
    if (String(error).includes("找不到")) return null;
    throw error;
  }
  const parsed = parseLoreDocument(text, safeId(id, "lorebook"), id);
  if (!parsed.ok) throw new Error(parsed.error);
  return { id, doc: parsed.doc };
}

/** Writes a document and returns the stored id plus a re-anchored copy. */
export async function saveLoreDocument(
  id: string,
  doc: LoreDocument,
): Promise<{ id: string; doc: LoreDocument }> {
  const target = safeId(id, "lorebook");
  const payload = JSON.stringify(mergeLoreDocument(doc));
  const stored = await Library.saveLorebook(target, payload);
  const finalId = stored || target;
  const reread = parseLoreDocument(payload, finalId, doc.name);
  return { id: finalId, doc: reread.ok ? reread.doc : doc };
}

/** Other world books, for the "move to book" picker. */
export async function listLorebookChoices(): Promise<{ id: string; name: string }[]> {
  const artifacts = await Library.listLorebooks();
  return artifacts.map((artifact) => ({ id: artifact.id, name: artifact.name || artifact.id }));
}

/** Writes text through the host's save panel; an empty path means cancelled. */
export async function saveLoreText(defaultName: string, content: string): Promise<string> {
  return Library.saveTextFile(defaultName, content);
}

/** Writes one editor entry into the library and returns its stored form. */
export async function saveLibraryEntry(entry: Entry): Promise<Entry> {
  if (entry.kind === "world") return saveWorldEntry(entry);
  if (entry.kind === "character") return saveCardEntry(entry);
  if (entry.kind === "lore") return saveLoreEntry(entry);
  if (entry.kind === "player") return savePlayerEntry(entry);
  throw new Error("会话记忆由当前会话保存");
}

export async function deleteLibraryEntry(kind: EditorKind, id: string): Promise<void> {
  if (kind === "world") await Library.deleteWorld(id);
  else if (kind === "character") await Library.deleteCard(id);
  else if (kind === "lore") await Library.deleteLorebook(id);
  else if (kind === "player") throw new Error("玩家角色随世界保存，不能单独删除");
  else throw new Error("会话记忆由当前会话删除");
}

/* -------------------------------------------------------------------------
   Import / export
   ------------------------------------------------------------------------- */

export async function importCardFile(): Promise<{ id: string; name: string } | null> {
  const summary = await Library.importCard();
  if (!summary || !summary.id) return null;
  return { id: summary.id, name: summary.name || summary.id };
}

export async function exportCardFile(id: string): Promise<string> {
  return Library.exportCard(id);
}

export async function importLorebookFile(): Promise<{ id: string; name: string } | null> {
  const artifact = await Library.importLorebook();
  if (!artifact || !artifact.id) return null;
  return { id: artifact.id, name: artifact.name || artifact.id };
}

export async function exportLorebookFile(id: string): Promise<string> {
  return Library.exportLorebook(id);
}

export async function exportWorldFile(id: string): Promise<string> {
  return Library.exportWorld(id);
}

export async function loadCardById(id: string): Promise<CharacterCard | null> {
  const raw = parseJson(await Library.loadCard(id).catch(() => ""));
  const record = asRecord(raw);
  if (Object.keys(record).length === 0) return null;
  return normalizeCard(record, { id });
}

export async function loadLorebookById(id: string): Promise<Lorebook | null> {
  const raw = parseJson(await Library.loadLorebook(id).catch(() => ""));
  const record = asRecord(raw);
  if (Object.keys(record).length === 0) return null;
  return readBook(record, id, id);
}

/* -------------------------------------------------------------------------
   World authoring: the world engine writes books and cards through here
   ------------------------------------------------------------------------- */

/** Card fields the world engine may write, mapped onto the on-disk names. */
export interface CardPatch {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  /** Example dialogue; the prompt renders it as the speaking style. */
  speakingStyle?: string;
  firstMessage?: string;
  tags?: string[];
  /** Author notes stored beside the card. */
  notes?: string;
}

const CARD_PATCH_KEYS: Record<keyof CardPatch, string> = {
  name: "name",
  description: "description",
  personality: "personality",
  scenario: "scenario",
  speakingStyle: "mes_example",
  firstMessage: "first_mes",
  tags: "tags",
  notes: "creator_notes",
};

/** Builds a V3 payload for a new card. */
export function newCardPayload(patch: CardPatch): unknown {
  const now = Date.now();
  const data: Raw = {
    name: patch.name ?? "",
    description: "",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "AppleCos",
    character_version: "1",
    creation_date: now,
    modification_date: now,
  };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    data[CARD_PATCH_KEYS[field as keyof CardPatch]] = value;
  }
  return { spec: "chara_card_v3", spec_version: "3.0", data };
}

/** Merges a patch into a stored card payload, keeping its shape and unknown keys. */
export function patchCardPayload(raw: unknown, patch: CardPatch): unknown {
  const record = asRecord(raw);
  const spec = textOf(record.spec);
  const wrapped = spec === "chara_card_v2" || spec === "chara_card_v3";
  const data: Raw = wrapped ? { ...asRecord(record.data) } : { ...record };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    data[CARD_PATCH_KEYS[field as keyof CardPatch]] = value;
  }
  if (!wrapped) return data;
  if (spec === "chara_card_v3") data.modification_date = Date.now();
  return { ...record, data };
}

/** Turns a live book into a document so a missing artifact can be seeded. */
function documentOfBook(book: Lorebook): LoreDocument {
  const doc = emptyLoreDocument(book.name);
  const rawEntries: Record<string, Raw> = {};
  const rawKeys: Record<string, string> = {};
  book.entries.forEach((entry, index) => {
    const key = String(index);
    rawEntries[key] = stEntryFields(entry, {}, index);
    rawKeys[entry.id] = key;
  });
  return {
    ...doc,
    raw: { name: book.name },
    entries: book.entries.map((entry) => ({
      ...entry,
      keys: entry.keys.slice(),
      secondaryKeys: entry.secondaryKeys.slice(),
    })),
    rawEntries,
    rawKeys,
    scanDepth: book.scanDepth,
    budgetChars: book.budgetChars,
    recursive: book.recursive,
  };
}

/** Reads the world's own book, falling back to the copy embedded in the world. */
export async function loadWorldLoreDocument(
  world: World,
): Promise<{ id: string; doc: LoreDocument }> {
  const stored = await loadLoreDocumentById(world.lorebook.id);
  return stored ?? { id: world.lorebook.id, doc: documentOfBook(world.lorebook) };
}

/** Stores the world book and mirrors the saved copy onto the live world. */
export async function saveWorldLoreDocument(
  world: World,
  doc: LoreDocument,
): Promise<{ id: string; doc: LoreDocument }> {
  const saved = await saveLoreDocument(world.lorebook.id, doc);
  world.lorebook = {
    id: saved.id,
    name: saved.doc.name,
    entries: saved.doc.entries,
    scanDepth: saved.doc.scanDepth,
    budgetChars: saved.doc.budgetChars,
    recursive: saved.doc.recursive,
  };
  world.updatedAt = Date.now();
  return saved;
}

/** Stores one card payload and puts the normalized card into the world. */
export async function saveWorldCard(
  world: World,
  requestedId: string,
  payload: unknown,
): Promise<CharacterCard> {
  const stored = await Library.saveCard(requestedId, JSON.stringify(payload));
  const id = stored || requestedId;
  const card = normalizeCard(payload, { id, bookId: id + "_book" });
  if (id !== requestedId) delete world.cards[requestedId];
  world.cards[id] = card;
  world.updatedAt = Date.now();
  return card;
}

/* -------------------------------------------------------------------------
   Migration: embedded world data and the old localStorage library
   ------------------------------------------------------------------------- */

async function migrateEmbedded(): Promise<void> {
  const worlds = await Library.listWorlds();
  for (const artifact of worlds) {
    const world = await loadWorld(artifact.id).catch(() => null);
    if (world) await seedWorldArtifacts(world).catch(() => undefined);
  }
}

interface LegacyEntry {
  id?: string;
  kind?: string;
  title?: string;
  body?: string;
  tags?: string[];
  extra?: Record<string, string>;
}

function legacyEntries(raw: unknown, kind: string): LegacyEntry[] {
  const record = asRecord(raw);
  const list = record[kind];
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is LegacyEntry => typeof item === "object" && item !== null);
}

async function migrateLegacy(): Promise<void> {
  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "null") as unknown;
  } catch {
    return;
  }
  if (!stored) return;

  const worlds = await Library.listWorlds().catch(() => []);
  const legacyWorlds = legacyEntries(stored, "world");
  if (worlds.length === 0 && legacyWorlds.length > 0) {
    const legacy = legacyWorlds[0];
    if (legacy) {
      const id = safeId(legacy.id ?? "", "world");
      const world = createWorldScaffold(id, legacy.title ?? "世界");
      const place = (legacy.extra?.place ?? "").trim();
      world.setting = [place ? "开场地点：" + place : "", legacy.body ?? ""]
        .filter((line) => line.trim() !== "")
        .join("\n");
      world.summary = (legacy.extra?.tagline ?? "").trim();
      await Library.saveWorld(id, JSON.stringify(world)).catch(() => undefined);
    }
  }

  const cards = await Library.listCards().catch(() => []);
  const legacyCards = legacyEntries(stored, "character");
  if (cards.length === 0) {
    for (const legacy of legacyCards) {
      const id = safeId(legacy.id ?? "", "card");
      const payload = {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: legacy.title ?? "无名角色",
          description: legacy.body ?? "",
          personality: (legacy.tags ?? []).join("、"),
          scenario: legacy.extra?.relation ?? "",
          tags: legacy.tags ?? [],
          first_mes: "",
          mes_example: "",
          system_prompt: "",
          post_history_instructions: "",
          alternate_greetings: [],
          creator: "AppleCos",
          character_version: "1",
        },
      };
      await Library.saveCard(id, JSON.stringify(payload)).catch(() => undefined);
    }
  }

  const books = await Library.listLorebooks().catch(() => []);
  const legacyLore = legacyEntries(stored, "lore");
  if (books.length === 0) {
    for (const legacy of legacyLore) {
      const id = safeId(legacy.id ?? "", "lorebook");
      const book: Lorebook = {
        id,
        name: legacy.title ?? "世界书",
        entries: entriesToArray([
          {
            id,
            comment: legacy.title ?? "世界书",
            keys: legacy.tags ?? [],
            content: legacy.body ?? "",
          },
        ]),
        scanDepth: 4,
        budgetChars: 1200,
        recursive: true,
      };
      await Library.saveLorebook(id, JSON.stringify(stBook(book))).catch(() => undefined);
    }
  }
}

let migration: Promise<void> | null = null;

/** Seeds the library from embedded world data and the legacy page storage. */
export function migrateLibrary(): Promise<void> {
  if (!migration) {
    migration = (async () => {
      await migrateLegacy().catch(() => undefined);
      await migrateEmbedded().catch(() => undefined);
    })();
  }
  return migration;
}
