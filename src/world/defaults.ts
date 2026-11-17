// Starter world for a fresh install, so the first launch can play right away.

import { normalizeCard, normalizeLoreEntry } from "./card";
import type { CharacterCard, Lorebook, PlayerIdentity, World } from "./types";

const COMPANION_ID = "card-companion";

interface CardSeed {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue?: string;
  tags?: string[];
}

/** Builds a normalized card from a V2 payload, keeping the raw JSON for export. */
function buildCard(id: string, seed: CardSeed): CharacterCard {
  const raw = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: seed.name,
      description: seed.description,
      personality: seed.personality,
      scenario: seed.scenario,
      first_mes: seed.firstMessage,
      mes_example: seed.exampleDialogue ?? "",
      tags: seed.tags ?? [],
      creator: "AppleCos",
      character_version: "1",
    },
  };
  return normalizeCard(raw, { id, bookId: id + "_book" });
}

/**
 * No player is handed out by default: an unwritten identity stays empty, so the
 * narrator never inherits a character the user did not create.
 */
const EMPTY_PLAYER: PlayerIdentity = { name: "", description: "", persona: "" };

const SETTING = [
  "这是一个示例世界，用来演示世界设定、角色卡、世界书与记忆的工作方式。可以直接在这里开演，也可以把它改成自己的设定。",
  "镇上有一座驿站、一条穿镇而过的路和一片镇外的田地。来往的人不多，但每天都有。",
  "镇上有自己的规矩：外来的人先在驿站登记，镇门入夜关闭，夜里的街上需要凭牌通行。",
].join("\n");

const RULES = [
  "叙事保持第三人称，镜头跟着玩家，不替玩家说话或下定论。",
  "角色按自己的身份与处境行动，不因玩家的期待改变立场。",
  "角色知道的事有限，只写他们能看见、听到、猜到的部分。",
  "每轮推进一小段，把选择留给玩家。",
].join("\n");

const COMPANION_SEED: CardSeed = {
  name: "驿站管理员",
  description:
    "在镇口驿站值守的人，负责登记来往的旅人，也替镇上保管寄存的行李。他记得住每一张脸，但不会主动提起。",
  personality: "话不多，做事按规矩，对陌生人有距离，但不刻薄。",
  scenario: "傍晚，驿站里点着灯，登记簿摊在桌上。",
  firstMessage:
    "他抬起头，看了你一眼，把登记簿推到桌边。\n「名字，来处，要待几天。」",
  exampleDialogue: "{{user}}：我只是路过。\n{{char}}：「路过也要登记。」",
  tags: ["驿站", "登记"],
};

const LORE_SEEDS = [
  {
    id: "lore-register",
    title: "登记",
    keys: ["登记", "名字", "驿站"],
    content:
      "外来的人要在驿站登记名字与来处。登记之后领一张通行牌，凭牌可以在镇上住店，也可以在夜里走街。牌子丢了要去驿站补办，补办要说明丢失的经过。",
  },
  {
    id: "lore-curfew",
    title: "宵禁",
    keys: ["宵禁", "夜里", "镇门"],
    content:
      "镇门入夜关闭，第二天清晨重开。夜里的街上要有通行牌，没有的人会被巡逻的人带回驿站，记录在案；登记过的人第二次被带回，要留一夜。",
  },
];

/**
 * An empty world, ready for the editor. It carries no cast and no player: the
 * user writes both. Narration comes from the system prompt, not from a card.
 */
export function createWorldScaffold(id: string, name: string, now = Date.now()): World {
  return {
    id,
    name: name.trim() || "新世界",
    summary: "",
    setting: "在这里写这个世界的时代、地点与规矩。",
    rules: RULES,
    player: EMPTY_PLAYER,
    narratorId: "",
    cards: {},
    lorebook: {
      id: id + "-book",
      name: (name.trim() || "新世界") + "的世界书",
      entries: [],
      scanDepth: 4,
      budgetChars: 1200,
      recursive: true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** A ready-to-play world with one companion card and a small book. */
export function defaultWorld(now = Date.now()): World {
  const companion = buildCard(COMPANION_ID, COMPANION_SEED);
  const entries = LORE_SEEDS.map((seed) =>
    normalizeLoreEntry(
      {
        id: seed.id,
        comment: seed.title,
        keys: seed.keys,
        content: seed.content,
        insertion_order: 0,
      },
      seed.id,
    ),
  );
  const lorebook: Lorebook = {
    id: "book-sample",
    name: "示例世界书",
    entries,
    scanDepth: 4,
    budgetChars: 1200,
    recursive: true,
  };

  return {
    id: "world-sample",
    name: "示例世界",
    summary: "一个用于试玩的起始世界，可以把设定换成自己的。",
    setting: SETTING,
    rules: RULES,
    player: EMPTY_PLAYER,
    narratorId: "",
    cards: { [companion.id]: companion },
    lorebook,
    createdAt: now,
    updatedAt: now,
  };
}
