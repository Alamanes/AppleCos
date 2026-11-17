import { describe, expect, test } from "bun:test";

import { normalizeCard } from "../src/world/card";
import { activateLore, emptyLoreRuntime } from "../src/world/lorebook";
import { emptyMemory, rememberFact, summarizeMemoryReport } from "../src/world/memory";
import { buildSections, dynamicPromptFromSections, staticPromptFromSections } from "../src/world/prompt";
import {
  advanceTurn,
  appendMessage,
  applyProjections,
  createSession,
  projectMessages,
  readProjections,
  restoreSession,
  rewindSession,
  slimSnapshots,
  snapshotTurn,
  updateOverlay,
} from "../src/world/session";
import type { LoreEntry, Lorebook, World, WorldMessage } from "../src/world/types";

function worldWith(): World {
  const card = normalizeCard(
    {
      name: "阿岚",
      description: "守夜人。",
      personality: "冷淡",
      scenario: "在城门口等你。",
      first_mes: "你来了。",
    },
    { id: "card-a" },
  );
  return {
    id: "world-a",
    name: "长夜",
    summary: "一座不睡的城市。",
    setting: "城墙很高。",
    rules: "夜里不许出城。",
    player: { name: "玩家", description: "", persona: "" },
    narratorId: "card-a",
    cards: { "card-a": card },
    relations: { "card-a": 40 },
    lorebook: { id: "book-a", name: "书", entries: [], scanDepth: 4, budgetChars: 1200, recursive: false },
    createdAt: 0,
    updatedAt: 0,
  };
}

function line(content: string, turn = 0): WorldMessage {
  return {
    id: "m1",
    role: "user",
    speaker: "玩家",
    content,
    turn,
    timestamp: 1,
    hidden: false,
    cardId: "",
  };
}

describe("session payload slimming", () => {
  test("ids become a count and repeating memory is restored on load", () => {
    const world = worldWith();
    let session = createSession(world, { id: "s1", now: 1 });
    session = advanceTurn(appendMessage(session, { role: "user", content: "开门" }, 2));
    session = snapshotTurn(session, "", 3);
    session = advanceTurn(appendMessage(session, { role: "user", content: "进屋" }, 4));
    session = snapshotTurn(session, "", 5);

    const slim = slimSnapshots(session.turns);
    expect(slim.length).toBe(2);
    expect(slim[0]?.messageIds).toEqual([]);
    expect(slim[0]?.messageCount).toBeGreaterThan(0);
    // Memory did not change between the turns, so only the first carries it.
    expect(slim[0]?.memory).toBeDefined();
    expect(slim[1]?.memory).toBeUndefined();

    const raw = {
      version: session.version,
      meta: session.meta,
      player: session.player,
      projection: projectMessages(session.messages),
      turns: slim,
      overlays: session.overlays,
      scene: session.scene,
      memory: session.memory,
      lore: session.lore,
      loreLog: session.loreLog,
    };
    const restored = restoreSession(raw, world);
    expect(restored.turns.length).toBe(2);
    expect(restored.turns[1]?.memory.facts.length).toBe(restored.turns[0]?.memory.facts.length);

    // Rewinding to the first turn keeps only the messages that existed then.
    const cut = rewindSession({ ...session, turns: restored.turns }, 0);
    expect(cut.messages.length).toBe(restored.turns[0]?.messageCount ?? -1);
  });
});

describe("rewind and character state", () => {
  test("affection returns with the snapshot", () => {
    const world = worldWith();
    let session = createSession(world, { id: "s2", cast: ["card-a"], now: 1 });
    session = snapshotTurn(session, "", 10);
    const later = updateOverlay(session, "card-a", { affinity: 90, tags: ["受伤"] }, 20);
    const rewound = rewindSession(later, 0, 30);
    expect(rewound.overlays["card-a"]?.affinity).toBe(40);
    expect(rewound.overlays["card-a"]?.tags).toEqual([]);
  });

  test("a snapshot from before the field existed keeps the live state", () => {
    const world = worldWith();
    let session = createSession(world, { id: "s3", cast: ["card-a"], now: 1 });
    session = snapshotTurn(session, "", 10);
    const later = updateOverlay(session, "card-a", { affinity: 90 }, 20);
    const legacy = { ...later, turns: later.turns.map((item) => ({ ...item, overlays: undefined })) };
    expect(rewindSession(legacy, 0, 30).overlays["card-a"]?.affinity).toBe(90);
  });
});

describe("transcript projection headers", () => {
  test("the stored header carries ids and turns, never the text", () => {
    const world = worldWith();
    const session = appendMessage(createSession(world, { id: "s4", now: 1 }), line("你好"), 2);
    const headers = readProjections({ projection: projectMessages(session.messages) });
    expect(JSON.stringify(headers)).not.toContain("你好");

    const scanned: WorldMessage[] = session.messages.map((message, index) => ({
      ...message,
      id: "scan_" + index,
      turn: 0,
      speaker: "旁白",
    }));
    const aligned = applyProjections(scanned, headers);
    expect(aligned[0]?.id).toBe(session.messages[0]?.id ?? "");
    expect(aligned[0]?.turn).toBe(session.messages[0]?.turn ?? -1);
    expect(aligned[0]?.content).toBe("你来了。");
    expect(aligned[0]?.speaker).toBe(session.messages[0]?.speaker ?? "");
  });
});

describe("memory", () => {
  test("a restated fact updates instead of duplicating", () => {
    const first = rememberFact(emptyMemory(), "world", "钟楼在午夜敲十三下", {
      keywords: ["钟楼"],
      importance: 0.5,
      now: 1,
    });
    const second = rememberFact(first.memory, "world", "钟楼在午夜敲十三下", {
      keywords: ["午夜"],
      importance: 0.9,
      now: 2,
    });
    expect(second.memory.facts.length).toBe(1);
    expect(second.fact.id).toBe(first.fact.id);
    expect(second.fact.importance).toBe(0.9);
    expect(second.fact.keywords).toContain("钟楼");
    expect(second.fact.keywords).toContain("午夜");
  });

  test("the summary reports what the budget left out", () => {
    const words = ["钟楼", "码头", "旧宅", "剧院", "墓园", "车站", "书店", "酒馆", "塔楼", "地窖"];
    let memory = emptyMemory();
    for (let index = 0; index < 40; index += 1) {
      const a = words[index % words.length];
      const b = words[(index * 3 + 1) % words.length];
      memory = rememberFact(memory, "world", a + "的" + b + "里藏着第 " + index + " 件东西。", {
        importance: 0.5,
      }).memory;
    }
    const report = summarizeMemoryReport(memory, { budgetChars: 200 });
    expect(report.omitted).toBeGreaterThan(0);
    expect(report.text.length).toBeLessThan(400);
  });
});

describe("prompt prefix stability", () => {
  test("affection changes the per-turn section, not the cached prefix", () => {
    const world = worldWith();
    const session = createSession(world, { id: "s5", cast: ["card-a"], now: 1 });
    const overlay = session.overlays["card-a"];
    expect(overlay).toBeDefined();
    const inputs = (affinity: number) => ({
      world,
      cards: [world.cards["card-a"]!],
      player: session.player,
      memory: session.memory,
      overlays: { "card-a": { ...overlay!, affinity } },
      scene: session.scene,
      now: new Date(0),
      seed: "s5",
    });
    const cold = buildSections(inputs(10));
    const warm = buildSections(inputs(90));
    expect(staticPromptFromSections(cold)).toBe(staticPromptFromSections(warm));
    expect(dynamicPromptFromSections(warm)).toContain("90");
    expect(dynamicPromptFromSections(cold)).not.toBe(dynamicPromptFromSections(warm));
  });
});

describe("lorebook regex keys", () => {
  function entry(keys: string[]): LoreEntry {
    return {
      id: "e1",
      title: "陷阱",
      keys,
      secondaryKeys: [],
      content: "一段设定。",
      enabled: true,
      constant: false,
      selective: false,
      selectiveLogic: 0,
      order: 0,
      position: "before_char",
      depth: 0,
      depthRole: "system",
      probability: 100,
      useProbability: false,
      useRegex: true,
      caseSensitive: false,
      excludeRecursion: false,
      preventRecursion: false,
      delay: 0,
      cooldown: 0,
      sticky: 0,
      group: "",
      groupWeight: 100,
      groupOverride: false,
      scanDepth: null,
    };
  }

  test("a nested quantifier is dropped instead of freezing the request", () => {
    const book: Lorebook = {
      id: "b1",
      name: "书",
      entries: [entry(["(a+)+$"])],
      scanDepth: 0,
      budgetChars: 1200,
      recursive: false,
    };
    const started = Date.now();
    const result = activateLore(book, [line("a".repeat(4000))], emptyLoreRuntime(1), 1);
    expect(result.entries.length).toBe(0);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
