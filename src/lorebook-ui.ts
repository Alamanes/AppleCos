// World book manager: a SillyTavern-style entry list, bulk actions and a
// detail form. The document stays in memory; one save writes the whole book.

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
  deleteLibraryEntry,
  importLorebookFile,
  listLorebookChoices,
  loadLoreDocumentById,
  saveLoreDocument,
  saveLoreText,
} from "./library";
import { Sessions } from "./mygo";
import {
  applySortAsOrder,
  assignGroup,
  bookStats,
  clearGroup,
  cloneEntry,
  emptyLoreDocument,
  loreDocumentToBook,
  mergeLoreDocument,
  moveEntriesToBook,
  setEnabled,
  shiftOrder,
  type LoreBookStats,
  type LoreDocument,
} from "./world/lore-doc";
import {
  clampSelection,
  filterRows,
  LORE_FILTERS,
  LORE_SORTS,
  sortEntries,
  suggestTitle,
  visibleRange,
  type LoreFilter,
  type LoreSkipLabel,
  type LoreSortDir,
  type LoreSortKey,
  type LoreView,
} from "./world/lore-edit";
import { explainEntry, previewActivation } from "./world/lorebook";
import { scanMessages } from "./world/prompt";
import {
  createId,
  DEFAULT_MAX_RECURSION,
  type LoreActivationReason,
  type LoreActivationResult,
  type LoreDepthRole,
  type LoreEntry,
  type LorePosition,
  type SelectiveLogic,
  type WorldMessage,
} from "./world/types";

const ROW_HEIGHT = 44;
const OVERSCAN = 8;
/** Controls the detail form rebuilds; used to put keyboard focus back after it. */
const DETAIL_FOCUSABLE = "input, select, textarea, button, summary";

/** Wiring the editor passes in when it mounts the manager. */
export interface LorebookManagerOptions {
  id: string;
  onStatus: (message: string, error?: boolean) => void;
  onDirty: () => void;
  /** Reads the world book feature flag; previews are disabled while it is off. */
  worldbookEnabled?: () => boolean;
  /**
   * Reads the session the player is in, so a preview scans the transcript on
   * screen. Returns an empty value when no conversation is open.
   */
  currentSession?: () => string | null | undefined;
}

export interface LorebookSaveResult {
  id: string;
  doc: LoreDocument;
}

export interface LorebookManager {
  ready: Promise<void>;
  save(): Promise<LorebookSaveResult>;
  document(): LoreDocument | null;
  isDirty(): boolean;
  setTitle(name: string): void;
  exportSelected(): Promise<void>;
  mergeImport(): Promise<{ count: number; name: string } | null>;
  destroy(): void;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className = "ghost"): HTMLButtonElement {
  const node = make("button", className, label);
  node.type = "button";
  return node;
}

function splitList(value: string): string[] {
  return value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/* ------------------------------ terminology ---------------------------- */
//
// Reader-facing wording lives here: labels, one-line hints and the effect
// summary. Data keys and engine behaviour stay untouched.

/** One-line hint under a control, at most 30 characters. */
const HINTS = {
  title: "仅用于辨认与检索，不写入提示词",
  keys: "对话中出现这些词时，本条目生效",
  secondaryKeys: "配合触发条件，进一步判定是否生效",
  selectiveLogic: "触发词命中后，辅助触发词的命中组合",
  content: "生效时注入提示词的正文",
  constant: "忽略触发词，每轮固定注入",
  probability: "每次触发按此概率决定是否注入",
  position: "注入内容在提示词中的位置",
  depth: "距对话末尾的消息数，0 为紧贴末尾",
  role: "指定深度注入时采用的身份",
  order: "数值小的先注入，同值按标题排序",
  sticky: "生效后继续注入的轮数",
  cooldown: "生效后隔多少轮才可再次触发",
  delay: "开场多少轮内不参与判定",
  group: "同组条目每轮只生效一条",
  groupWeight: "同组竞争时的抽中权重",
  groupOverride: "命中即优先于同组其他条目",
  scanDepth: "回溯最近 N 条消息查找触发词，留空用书默认",
  exclude: "本条内容不再触发其他条目",
  prevent: "只在首轮判定，不参与级联轮",
  regex: "触发词按正则表达式匹配",
  caseSensitive: "匹配触发词时区分大小写",
  enabled: "关闭后完全不参与判定",
} as const;

/** Book-level hints, shown in the settings strip. */
const BOOK_HINTS = {
  scanDepth: "回溯最近 N 条消息查找触发词，0 为全部历史",
  budget: "单轮注入内容的字符上限",
  recursive: "生效条目可再触发其他条目",
  maxRounds: "级联判定的最大层数，由程序统一设定",
} as const;

/** Filter chips keyed by the ids from lore-edit, reworded for readers. */
const FILTER_LABELS: Record<LoreFilter, string> = {
  enabled: "已启用",
  disabled: "已停用",
  constant: "始终注入",
  probability: "按概率触发",
  group: "有互斥组",
  nokey: "无触发词",
  regex: "正则触发词",
  overbudget: "超篇幅上限",
};

const SORT_LABELS: Record<LoreSortKey, string> = {
  order: "注入顺序",
  custom: "手动顺序",
  title: "标题",
  tokens: "字符数",
  depth: "注入深度",
  uid: "条目编号",
  trigger: "触发概率",
  relevance: "相关度",
};

/** The four secondary-key combinations, worded but semantically identical. */
const SELECTIVE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "0", label: "辅助触发词任一命中" },
  { value: "3", label: "辅助触发词全部命中" },
  { value: "1", label: "辅助触发词未全部命中" },
  { value: "2", label: "辅助触发词均未命中" },
];

/** One new-entry template. Defaults are visible and every field stays editable. */
interface LorePreset {
  id: string;
  label: string;
  /** Short description of the defaults, shown as a tooltip. */
  hint: string;
  apply: (entry: LoreEntry) => LoreEntry;
}

const LORE_PRESETS: readonly LorePreset[] = [
  {
    id: "place",
    label: "地点",
    hint: "默认：不始终注入，注入位置角色设定之后，无冷却",
    apply: (entry) => ({ ...entry, position: "after_char", depth: 4 }),
  },
  {
    id: "person",
    label: "人物",
    hint: "默认：不始终注入，注入位置角色设定之后，无冷却",
    apply: (entry) => ({ ...entry, position: "after_char", depth: 4 }),
  },
  {
    id: "item",
    label: "物品",
    hint: "默认：不始终注入，注入位置角色设定之后，无冷却",
    apply: (entry) => ({ ...entry, position: "after_char", depth: 4 }),
  },
  {
    id: "rule",
    label: "规则",
    hint: "默认：注入位置角色设定之前，先于其他条目注入",
    apply: (entry) => ({ ...entry, position: "before_char", order: Math.max(0, entry.order - 10) }),
  },
];

/** Advanced block state, remembered per book for this session only. */
const advancedOpenByBook = new Map<string, boolean>();

/** Injection slot worded for readers. */
function positionName(position: LorePosition): string {
  if (position === "at_depth") return "指定深度";
  return position === "before_char" ? "角色设定之前" : "角色设定之后";
}

function positionText(entry: LoreEntry): string {
  if (entry.position === "at_depth") return "指定深度 " + String(entry.depth);
  return positionName(entry.position);
}

/** Compact position wording for the list badge. */
function positionBadge(entry: LoreEntry): string {
  if (entry.position === "at_depth") return "深度 " + String(entry.depth);
  return entry.position === "before_char" ? "设定之前" : "设定之后";
}

function reasonText(reason: LoreActivationReason): string {
  if (reason === "constant") return "始终注入";
  if (reason === "sticky") return "持续";
  if (reason === "recursive") return "级联";
  return "触发词";
}

/** Clause describing the secondary-key combination. */
function selectiveText(logic: SelectiveLogic): string {
  switch (logic) {
    case 1:
      return "未全部命中";
    case 2:
      return "均未命中";
    case 3:
      return "全部命中";
    default:
      return "任一命中";
  }
}

const SKIP_LABELS: Record<LoreSkipLabel, string> = {
  disabled: "已停用",
  cooldown: "冷却中",
  delay: "延迟未到",
  "no-key": "无触发词",
  selective: "辅助触发词未通过",
  probability: "概率未命中",
  group: "同组落选",
  budget: "超出篇幅上限",
  miss: "未命中",
};

function skipLabel(reason: LoreSkipLabel): string {
  return SKIP_LABELS[reason] ?? "未命中";
}

function skipHint(reason: LoreSkipLabel): string {
  switch (reason) {
    case "disabled":
      return "本条已停用，不参与判定。";
    case "cooldown":
      return "仍在冷却轮次内，冷却结束后才能再次触发。";
    case "delay":
      return "延迟轮次未满，开场数轮内不参与判定。";
    case "no-key":
      return "触发词未命中，且未启用始终注入。";
    case "selective":
      return "触发词命中，但辅助触发词按当前触发条件判定未通过。";
    case "probability":
      return "触发概率判定未通过，本轮未注入。";
    case "group":
      return "同组已有其他条目入选，每轮只生效一条。";
    case "budget":
      return "篇幅上限已被占满，本条未进入本轮。";
    default:
      return "本轮检索范围内的文本没有命中触发词。";
  }
}

/**
 * One-sentence effect summary for the detail panel. Pure and reusable: it
 * reads the entry only, so any field change can re-render it cheaply.
 */
export function describeEntryEffect(entry: LoreEntry): string {
  if (!entry.enabled) return "已停用，不会注入。";
  const parts: string[] = [];
  if (entry.constant) {
    parts.push("始终注入，忽略触发词");
  } else {
    const secondary = entry.secondaryKeys.filter((key) => key.trim() !== "");
    if (entry.selective && secondary.length > 0) {
      parts.push("触发词命中，且辅助触发词" + selectiveText(entry.selectiveLogic) + "时注入");
    } else {
      parts.push("触发词命中时注入");
    }
  }
  parts.push("注入位置：" + positionText(entry));
  parts.push("篇幅约 " + String(entry.content.length) + " 字");
  if (!entry.constant) {
    if (entry.useProbability && entry.probability < 100) {
      parts.push("每次触发概率 " + String(entry.probability) + "%");
    } else {
      parts.push("必然触发");
    }
  }
  if (entry.group.trim() !== "") parts.push("与同组条目互斥");
  if (entry.sticky > 0) parts.push("生效后持续 " + String(entry.sticky) + " 轮");
  if (entry.cooldown > 0) parts.push("生效后冷却 " + String(entry.cooldown) + " 轮");
  if (entry.delay > 0) parts.push("开场 " + String(entry.delay) + " 轮内不生效");
  if (entry.excludeRecursion) parts.push("本条内容不触发其他条目");
  if (entry.preventRecursion) parts.push("不参与级联判定");
  if (entry.scanDepth !== null) parts.push("回溯最近 " + String(entry.scanDepth) + " 条消息");
  return parts.join("；") + "。";
}

/** Mounts the manager into the editor's lore section. */
export function mountLorebookManager(
  host: HTMLElement,
  options: LorebookManagerOptions,
): LorebookManager {
  const controller = new AbortController();
  const signal = controller.signal;

  const section = (id: string): HTMLElement => {
    const node = host.querySelector<HTMLElement>("#" + id);
    if (!node) throw new Error("缺少世界书面板节点：#" + id);
    return node;
  };

  const bookHost = section("lore-book-settings");
  const toolbarHost = section("lore-toolbar");
  const rowsHost = section("lore-rows");
  const bulkHost = section("lore-bulkbar");
  const detailHost = section("lore-detail");
  for (const node of [bookHost, toolbarHost, rowsHost, bulkHost, detailHost]) {
    node.replaceChildren();
  }

  let bookId = options.id;
  let doc: LoreDocument | null = null;
  let dirty = false;
  let loadError = "";
  let rows: LoreEntry[] = [];
  let selected = new Set<string>();
  let cursor = "";
  let anchor = "";
  let detailId = "";
  let groupName = "";
  let moveTarget = "";
  let choices: { id: string; name: string }[] = [];
  let effectText: HTMLElement | null = null;
  let deleteArmed = false;
  let deleteTimer: number | undefined;
  let searchTimer: number | undefined;
  let frame = 0;
  let destroyed = false;
  const view: LoreView = { query: "", filters: [], sort: "order", dir: "asc" };

  /* ------------------------------ book bar ------------------------------ */

  const nameInput = make("input", "field lore-name-input");
  nameInput.placeholder = "世界书名";
  nameInput.autocomplete = "off";
  nameInput.spellcheck = false;
  nameInput.addEventListener(
    "input",
    () => {
      if (!doc) return;
      doc.name = nameInput.value;
      const header = document.getElementById("editor-title");
      if (header) header.textContent = nameInput.value.trim() || "世界书";
      markDirty();
    },
    { signal },
  );

  const depthInput = make("input", "field lore-number");
  depthInput.type = "number";
  depthInput.min = "0";
  depthInput.addEventListener(
    "change",
    () => {
      if (!doc) return;
      const parsed = Number.parseInt(depthInput.value, 10);
      if (!Number.isFinite(parsed)) {
        depthInput.value = String(doc.scanDepth);
        return;
      }
      doc.scanDepth = Math.max(0, parsed);
      markDirty();
      renderChrome();
    },
    { signal },
  );

  const budgetInput = make("input", "field lore-number");
  budgetInput.type = "number";
  budgetInput.min = "0";
  budgetInput.addEventListener(
    "change",
    () => {
      if (!doc) return;
      const parsed = Number.parseInt(budgetInput.value, 10);
      if (!Number.isFinite(parsed)) {
        budgetInput.value = String(doc.budgetChars);
        return;
      }
      doc.budgetChars = Math.max(0, parsed);
      markDirty();
      renderChrome();
    },
    { signal },
  );

  const recursiveInput = make("input");
  recursiveInput.type = "checkbox";
  recursiveInput.addEventListener(
    "change",
    () => {
      if (!doc) return;
      doc.recursive = recursiveInput.checked;
      markDirty();
    },
    { signal },
  );

  const statsLabel = make("span", "lore-stats", "");

  const bookFields = make("div", "lore-book-fields");
  const nameField = make("label", "lore-book-field lore-book-name");
  nameField.append(make("span", "", "书名"), nameInput);
  const depthField = make("label", "lore-book-field lore-book-depth");
  depthField.append(
    make("span", "", "检索范围"),
    depthInput,
    make("span", "lore-book-hint", BOOK_HINTS.scanDepth),
  );
  const budgetField = make("label", "lore-book-field lore-book-budget");
  budgetField.append(
    make("span", "", "篇幅上限"),
    budgetInput,
    make("span", "lore-book-hint", BOOK_HINTS.budget),
  );
  const recursiveField = make("div", "lore-book-field lore-book-recursive");
  const recursiveCheck = make("label", "lore-check");
  recursiveCheck.append(recursiveInput, make("span", "", "开启级联触发"));
  recursiveField.append(
    make("span", "", "级联触发"),
    recursiveCheck,
    make("span", "lore-book-hint", BOOK_HINTS.recursive),
  );
  const roundsField = make("div", "lore-book-field lore-book-rounds");
  roundsField.append(
    make("span", "", "最大级联层数"),
    make("span", "lore-book-value", String(DEFAULT_MAX_RECURSION)),
    make("span", "lore-book-hint", BOOK_HINTS.maxRounds),
  );
  bookFields.append(nameField, depthField, budgetField, recursiveField, roundsField, statsLabel);
  bookHost.append(bookFields);

  /* ------------------------------- toolbar ------------------------------ */

  const searchInput = make("input", "field lore-search");
  searchInput.type = "search";
  searchInput.placeholder = "搜索标题、触发词或条目内容";
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchInput.addEventListener(
    "input",
    () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        if (destroyed) return;
        view.query = searchInput.value;
        renderChrome();
      }, 120);
    },
    { signal },
  );

  const chips = make("div", "lore-chips");
  const chipNodes = new Map<LoreFilter, HTMLButtonElement>();
  for (const filter of LORE_FILTERS) {
    const chip = button(FILTER_LABELS[filter.id], "lore-chip");
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => toggleFilter(filter.id), { signal });
    chipNodes.set(filter.id, chip);
    chips.append(chip);
  }

  const sortSelect = make("select", "field lore-sort");
  for (const sort of LORE_SORTS) {
    const option = make("option", "", SORT_LABELS[sort.id]);
    option.value = sort.id;
    sortSelect.append(option);
  }
  sortSelect.value = view.sort;
  sortSelect.addEventListener(
    "change",
    () => {
      view.sort = (sortSelect.value as LoreSortKey) || "order";
      renderChrome();
    },
    { signal },
  );

  const dirButton = button("升序", "ghost lore-dir");
  dirButton.title = "切换升降序";
  dirButton.addEventListener(
    "click",
    () => {
      view.dir = view.dir === "asc" ? "desc" : "asc";
      dirButton.textContent = view.dir === "asc" ? "升序" : "降序";
      renderChrome();
    },
    { signal },
  );

  const countLabel = make("span", "lore-count", "");

  const applyOrder = button("按当前排序重写注入顺序");
  applyOrder.addEventListener(
    "click",
    () => {
      if (!doc) return;
      doc.entries = applySortAsOrder(doc.entries, view.sort, view.dir);
      view.sort = "order";
      view.dir = "asc";
      sortSelect.value = "order";
      dirButton.textContent = "升序";
      markDirty();
      renderChrome();
      options.onStatus("已按当前排序重写注入顺序");
    },
    { signal },
  );

  const fillTitles = button("回填空标题");
  fillTitles.addEventListener(
    "click",
    () => {
      if (!doc) return;
      let filled = 0;
      doc.entries = doc.entries.map((entry) => {
        if (entry.title.trim() !== "") return entry;
        filled += 1;
        return { ...entry, title: suggestTitle(entry) };
      });
      if (filled === 0) {
        options.onStatus("没有空标题的条目");
        return;
      }
      markDirty();
      renderChrome();
      options.onStatus("已回填 " + String(filled) + " 条标题");
    },
    { signal },
  );

  const selectAll = button("全选筛选结果");
  selectAll.addEventListener(
    "click",
    () => {
      selected = new Set(rows.map((entry) => entry.id));
      renderRows();
      renderBulk();
    },
    { signal },
  );

  const invertSelection = button("反选");
  invertSelection.addEventListener(
    "click",
    () => {
      const next = new Set(selected);
      for (const entry of rows) {
        if (next.has(entry.id)) next.delete(entry.id);
        else next.add(entry.id);
      }
      selected = next;
      renderRows();
      renderBulk();
    },
    { signal },
  );

  const createButton = button("新建条目");
  const presetRow = make("div", "lore-preset-row");
  presetRow.hidden = true;
  presetRow.append(make("span", "lore-preset-label", "新建条目：选择类型，创建后全部字段可改"));
  for (const preset of LORE_PRESETS) {
    const node = button("预设：" + preset.label, "lore-preset");
    node.title = preset.hint;
    node.addEventListener("click", () => createEntry(preset), { signal });
    presetRow.append(node);
  }
  const presetCancel = button("取消");
  presetCancel.addEventListener(
    "click",
    () => {
      presetRow.hidden = true;
    },
    { signal },
  );
  presetRow.append(make("span", "lore-preset-hint", "预设只写入可见默认值"), presetCancel);
  createButton.addEventListener(
    "click",
    () => {
      presetRow.hidden = !presetRow.hidden;
    },
    { signal },
  );

  const toolbarRow = make("div", "lore-toolbar-row");
  toolbarRow.append(searchInput, chips);
  const sortRow = make("div", "lore-toolbar-row");
  sortRow.append(
    createButton,
    make("span", "lore-toolbar-label", "排序"),
    sortSelect,
    dirButton,
    applyOrder,
    fillTitles,
    selectAll,
    invertSelection,
    countLabel,
  );
  toolbarHost.append(toolbarRow, sortRow, presetRow);

  /* ------------------------------ rows list ----------------------------- */

  const rowsInner = make("div", "lore-rows-inner");
  const emptyNote = make("p", "lore-empty", "还没有条目。点工具栏的“新建条目”，选择类型后创建。");
  rowsHost.append(rowsInner, emptyNote);

  rowsHost.addEventListener(
    "scroll",
    () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        renderRows();
      });
    },
    { signal },
  );

  rowsHost.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveCursor(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        const entry = doc?.entries.find((item) => item.id === cursor);
        if (entry) updateEntry(entry.id, { enabled: !entry.enabled });
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selected = new Set(rows.map((entry) => entry.id));
        renderRows();
        renderBulk();
      }
    },
    { signal },
  );

  const resize = new ResizeObserver(() => {
    if (destroyed) return;
    renderRows();
  });
  resize.observe(rowsHost);

  /* ------------------------------- actions ------------------------------ */

  function markDirty(): void {
    if (dirty) return;
    dirty = true;
    options.onDirty();
  }

  /** Base fields for a fresh entry; presets only override position and order. */
  function newEntry(entries: readonly LoreEntry[]): LoreEntry {
    const taken = new Set(entries.map((item) => item.id));
    let id = createId("lore");
    while (taken.has(id)) id = createId("lore");
    let order = 0;
    for (const item of entries) if (item.order > order) order = item.order;
    return {
      id,
      title: "",
      keys: [],
      secondaryKeys: [],
      content: "",
      enabled: true,
      constant: false,
      selective: true,
      selectiveLogic: 0,
      order: order + 10,
      position: "after_char",
      depth: 4,
      depthRole: "system",
      probability: 100,
      useProbability: true,
      useRegex: false,
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

  function createEntry(preset: LorePreset): void {
    if (!doc) return;
    const entry = preset.apply(newEntry(doc.entries));
    doc.entries.push(entry);
    presetRow.hidden = true;
    selected = new Set([entry.id]);
    cursor = entry.id;
    anchor = entry.id;
    detailId = entry.id;
    markDirty();
    renderChrome();
    renderDetail();
    options.onStatus("已新建「" + preset.label + "」条目，保存后写入资料库");
  }

  function toggleFilter(filter: LoreFilter): void {
    const index = view.filters.indexOf(filter);
    if (index >= 0) view.filters.splice(index, 1);
    else {
      if (filter === "enabled") {
        const other = view.filters.indexOf("disabled");
        if (other >= 0) view.filters.splice(other, 1);
      }
      if (filter === "disabled") {
        const other = view.filters.indexOf("enabled");
        if (other >= 0) view.filters.splice(other, 1);
      }
      view.filters.push(filter);
    }
    for (const [id, node] of chipNodes) {
      node.setAttribute("aria-pressed", view.filters.includes(id) ? "true" : "false");
    }
    renderChrome();
  }

  function refreshRows(): void {
    rows = doc
      ? filterRows(doc.entries, view, { budgetChars: doc.budgetChars })
      : [];
    const existing = new Set(doc ? doc.entries.map((entry) => entry.id) : []);
    for (const id of [...selected]) if (!existing.has(id)) selected.delete(id);
    if (doc && detailId !== "" && !existing.has(detailId)) detailId = "";
  }

  function renderChrome(): void {
    refreshRows();
    renderRows();
    renderStats();
    renderBulk();
  }

  function renderStats(): void {
    if (!doc) {
      statsLabel.textContent = "正在读取…";
      countLabel.textContent = "";
      emptyNote.textContent = loadError !== "" ? "读取失败：" + loadError : "正在读取世界书…";
      return;
    }
    const stats = bookStats(doc.entries, doc.budgetChars);
    statsLabel.textContent =
      String(stats.count) +
      " 条 · 已启用 " +
      String(stats.enabled) +
      " · " +
      String(stats.chars) +
      " 字 · 超篇幅上限 " +
      String(stats.overBudget) +
      " 条";
    countLabel.textContent =
      "显示 " + String(rows.length) + " / " + String(doc.entries.length) + " 条";
    emptyNote.textContent = loadError !== "" ? "读取失败：" + loadError : "还没有条目。点工具栏的“新建条目”即可创建。";
  }

  function renderRows(): void {
    rowsInner.replaceChildren();
    if (!doc) {
      rowsInner.style.height = "0px";
      emptyNote.hidden = false;
      return;
    }
    rowsInner.style.height = String(Math.max(0, rows.length) * ROW_HEIGHT) + "px";
    emptyNote.hidden = rows.length > 0;
    if (rows.length === 0) return;
    const range = visibleRange(rowsHost.scrollTop, rowsHost.clientHeight, ROW_HEIGHT, OVERSCAN);
    const from = Math.max(0, range.start);
    const to = Math.min(rows.length, range.end);
    for (let index = from; index < to; index += 1) {
      const entry = rows[index];
      if (!entry) continue;
      rowsInner.append(buildRow(entry, index));
    }
  }

  function buildRow(entry: LoreEntry, index: number): HTMLElement {
    const row = make("div", "lore-row");
    row.style.top = String(index * ROW_HEIGHT) + "px";
    row.dataset.id = entry.id;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", selected.has(entry.id) ? "true" : "false");
    if (selected.has(entry.id)) row.classList.add("is-selected");
    if (!entry.enabled) row.classList.add("is-off");
    if (cursor === entry.id) row.classList.add("is-cursor");

    const check = make("input", "lore-checkbox");
    check.type = "checkbox";
    check.checked = selected.has(entry.id);
    check.title = "选择条目";
    check.addEventListener("click", (event) => {
      event.stopPropagation();
      selectRow(entry.id, index, event.shiftKey, true, false);
    });

    const toggle = button("", "lore-switch");
    if (entry.enabled) toggle.classList.add("is-on");
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", entry.enabled ? "true" : "false");
    toggle.title = entry.enabled ? "停用条目" : "启用条目";
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const current = doc?.entries.find((item) => item.id === entry.id);
      if (!current) return;
      updateEntry(entry.id, { enabled: !current.enabled });
    });

    const title = make("span", "lore-row-title", entry.title.trim() || entry.keys[0] || "（无标题）");
    if (!entry.enabled) title.classList.add("is-off");

    const keys = make("span", "lore-keys");
    const shown = entry.keys.filter((key) => key.trim() !== "").slice(0, 3);
    for (const key of shown) keys.append(make("span", "lore-key", key));
    const extra = entry.keys.filter((key) => key.trim() !== "").length - shown.length;
    if (extra > 0) keys.append(make("span", "lore-key lore-key-more", "+" + String(extra)));

    const meta = make("span", "lore-meta");
    meta.append(make("span", "lore-chars", String(entry.content.length) + " 字"));
    meta.append(make("span", "lore-order", "顺序 " + String(entry.order)));
    const badges: { text: string; className: string }[] = [];
    if (!entry.enabled) badges.push({ text: "已停用", className: "lore-badge lore-badge-off" });
    badges.push({ text: positionBadge(entry), className: "lore-badge" });
    if (entry.constant) badges.push({ text: "始终注入", className: "lore-badge" });
    if (entry.useProbability && entry.probability < 100) {
      badges.push({ text: "概率 " + String(entry.probability) + "%", className: "lore-badge" });
    }
    if (entry.group.trim() !== "") {
      badges.push({ text: "互斥：" + entry.group, className: "lore-badge lore-badge-group" });
    }
    for (const badge of badges) meta.append(make("span", badge.className, badge.text));

    row.append(check, toggle, title, keys, meta);
    row.addEventListener("click", (event) => {
      rowsHost.focus({ preventScroll: true });
      selectRow(entry.id, index, event.shiftKey, event.metaKey || event.ctrlKey, true);
    });
    return row;
  }

  function selectRow(
    id: string,
    index: number,
    shift: boolean,
    toggle: boolean,
    showDetail: boolean,
  ): void {
    if (shift && anchor !== "") {
      const from = rows.findIndex((entry) => entry.id === anchor);
      if (from >= 0) {
        const low = Math.min(from, index);
        const high = Math.max(from, index);
        selected = new Set(rows.slice(low, high + 1).map((entry) => entry.id));
      }
    } else if (toggle) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    } else {
      selected = new Set([id]);
    }
    anchor = id;
    cursor = id;
    if (showDetail) detailId = id;
    renderRows();
    renderBulk();
    if (showDetail) renderDetail();
  }

  function moveCursor(delta: number): void {
    if (rows.length === 0) return;
    const current = rows.findIndex((entry) => entry.id === cursor);
    const next = clampSelection(current < 0 ? 0 : current + delta, rows.length);
    const entry = rows[next];
    if (!entry) return;
    cursor = entry.id;
    detailId = entry.id;
    const top = next * ROW_HEIGHT;
    if (top < rowsHost.scrollTop) rowsHost.scrollTop = top;
    const bottom = top + ROW_HEIGHT;
    if (bottom > rowsHost.scrollTop + rowsHost.clientHeight) {
      rowsHost.scrollTop = bottom - rowsHost.clientHeight;
    }
    renderRows();
    renderDetail();
  }

  function updateEntry(
    id: string,
    patch: Partial<LoreEntry>,
    refreshDetail = false,
  ): void {
    if (!doc) return;
    const index = doc.entries.findIndex((entry) => entry.id === id);
    const current = index >= 0 ? doc.entries[index] : undefined;
    if (!current) return;
    doc.entries[index] = { ...current, ...patch };
    markDirty();
    refreshRows();
    renderRows();
    renderStats();
    renderBulk();
    refreshSummary();
    if (refreshDetail) renderDetail();
  }

  /** Re-renders the effect summary in place so typing never rebuilds the form. */
  function refreshSummary(): void {
    if (!effectText || !doc) return;
    const entry = doc.entries.find((item) => item.id === detailId);
    effectText.textContent = entry ? describeEntryEffect(entry) : "";
  }

  /* ------------------------------- bulk bar ------------------------------ */

  function bulkButton(
    label: string,
    action: () => void | Promise<void>,
    disabled: boolean,
  ): HTMLButtonElement {
    const node = button(label);
    node.disabled = disabled;
    node.addEventListener("click", () => void action());
    return node;
  }

  // The bar is built once and only synced afterwards, so typing in its group
  // field and an armed delete button survive selection changes and re-renders.
  const bulkBar = make("div", "lore-bulk");
  const bulkCount = make("span", "lore-bulk-count", "已选 0 条");
  const bulkEnable = bulkButton("启用", () => applyToSelected((entry) => setEnabled(entry, true)), true);
  const bulkDisable = bulkButton("停用", () => applyToSelected((entry) => setEnabled(entry, false)), true);
  const bulkDuplicate = bulkButton("复制", () => duplicateSelected(), true);

  const bulkGroupInput = make("input", "field lore-group-input");
  bulkGroupInput.placeholder = "互斥组名";
  bulkGroupInput.autocomplete = "off";
  bulkGroupInput.addEventListener("input", () => {
    groupName = bulkGroupInput.value;
  });

  const bulkGroupSet = bulkButton(
    "设置互斥组",
    () => {
      const name = groupName.trim();
      if (name === "") {
        options.onStatus("请先填写互斥组名称");
        return;
      }
      applyToSelected((entry) => assignGroup(entry, name));
    },
    true,
  );
  const bulkGroupClear = bulkButton("清除互斥组", () => applyToSelected((entry) => clearGroup(entry)), true);
  const bulkOrderBack = bulkButton("注入顺序 −10", () => applyToSelected((entry) => shiftOrder(entry, -10)), true);
  const bulkOrderNext = bulkButton("注入顺序 +10", () => applyToSelected((entry) => shiftOrder(entry, 10)), true);

  const bulkMoveSelect = make("select", "field lore-move-select");
  const bulkMovePlaceholder = make("option", "", "移动到目标书…");
  bulkMovePlaceholder.value = "";
  bulkMoveSelect.append(bulkMovePlaceholder);
  bulkMoveSelect.addEventListener("change", () => {
    moveTarget = bulkMoveSelect.value;
    renderBulk();
  });
  const bulkMove = bulkButton("移动", () => moveSelected(), true);
  const bulkExport = bulkButton("导出所选", () => exportSelected(), true);
  const bulkDelete = bulkButton(
    "删除所选",
    () => {
      if (!deleteArmed) {
        deleteArmed = true;
        window.clearTimeout(deleteTimer);
        deleteTimer = window.setTimeout(() => {
          deleteArmed = false;
          renderBulk();
        }, 4000);
        options.onStatus("再点一次确认删除所选条目；删除整本世界书请用编辑器底部的删除按钮。");
        renderBulk();
        return;
      }
      deleteArmed = false;
      window.clearTimeout(deleteTimer);
      deleteSelected();
    },
    true,
  );
  bulkDelete.classList.add("lore-danger");

  bulkBar.append(
    bulkCount,
    bulkEnable,
    bulkDisable,
    bulkDuplicate,
    bulkGroupInput,
    bulkGroupSet,
    bulkGroupClear,
    bulkOrderBack,
    bulkOrderNext,
    bulkMoveSelect,
    bulkMove,
    bulkExport,
    bulkDelete,
  );
  bulkHost.append(bulkBar);

  let moveChoicesKey = "";

  /** Refills the move targets only when the set of target books changed. */
  function syncMoveChoices(): void {
    const key = bookId + "|" + choices.map((choice) => choice.id + ":" + choice.name).join(",");
    if (key === moveChoicesKey) return;
    moveChoicesKey = key;
    bulkMoveSelect.replaceChildren(bulkMovePlaceholder);
    for (const choice of choices) {
      if (choice.id === bookId) continue;
      const option = make("option", "", choice.name);
      option.value = choice.id;
      bulkMoveSelect.append(option);
    }
    if (moveTarget !== "" && !choices.some((choice) => choice.id === moveTarget && choice.id !== bookId)) {
      moveTarget = "";
    }
    bulkMoveSelect.value = moveTarget;
  }

  function renderBulk(): void {
    const count = selected.size;
    const idle = count === 0 || doc === null;
    bulkCount.textContent = "已选 " + String(count) + " 条";
    for (const node of [
      bulkEnable,
      bulkDisable,
      bulkDuplicate,
      bulkGroupSet,
      bulkGroupClear,
      bulkOrderBack,
      bulkOrderNext,
      bulkExport,
      bulkDelete,
    ]) {
      node.disabled = idle;
    }
    syncMoveChoices();
    bulkMove.disabled = idle || moveTarget === "";
    bulkDelete.textContent = deleteArmed ? "再点一次删除" : "删除所选";
    if (bulkGroupInput.value !== groupName) bulkGroupInput.value = groupName;
  }

  function applyToSelected(transform: (entry: LoreEntry) => LoreEntry): void {
    if (!doc) return;
    let changed = 0;
    doc.entries = doc.entries.map((entry) => {
      if (!selected.has(entry.id)) return entry;
      changed += 1;
      return transform(entry);
    });
    if (changed === 0) return;
    markDirty();
    renderChrome();
    renderDetail();
  }

  function duplicateSelected(): void {
    if (!doc) return;
    const originals = doc.entries.filter((entry) => selected.has(entry.id));
    const nextIds: string[] = [];
    for (const entry of originals) {
      const copy = cloneEntry(entry, doc.entries);
      const index = doc.entries.findIndex((item) => item.id === entry.id);
      doc.entries.splice(index + 1, 0, copy);
      nextIds.push(copy.id);
    }
    selected = new Set(nextIds);
    markDirty();
    renderChrome();
    renderDetail();
  }

  function deleteSelected(): void {
    if (!doc || selected.size === 0) return;
    const count = selected.size;
    doc.entries = doc.entries.filter((entry) => !selected.has(entry.id));
    selected = new Set();
    detailId = "";
    markDirty();
    renderChrome();
    renderDetail();
    options.onStatus("已删除 " + String(count) + " 条，保存后写入资料库");
  }

  async function moveSelected(): Promise<void> {
    const source = doc;
    if (!source || moveTarget === "" || moveTarget === bookId) return;
    const target = await loadLoreDocumentById(moveTarget).catch((error: unknown) => {
      options.onStatus("读取目标世界书失败：" + String(error), true);
      return null;
    });
    if (!target) return;
    const result = moveEntriesToBook(source, target.doc, selected);
    if (result.moved.length === 0) {
      options.onStatus("没有可移动的条目");
      return;
    }
    try {
      await saveLoreDocument(target.id, result.target);
    } catch (error) {
      options.onStatus("写入目标世界书失败：" + String(error), true);
      return;
    }
    doc = result.source;
    selected = new Set();
    markDirty();
    renderChrome();
    renderDetail();
    const name = choices.find((choice) => choice.id === target.id)?.name ?? target.id;
    options.onStatus("已把 " + String(result.moved.length) + " 条移动到《" + name + "》，保存本世界书后生效");
  }

  /* ------------------------------ detail form ---------------------------- */

  function hintLine(text: string): HTMLElement {
    return make("span", "lore-hint", text);
  }

  /** Labeled control with a one-line hint under it. */
  function fieldBlock(text: string, control: HTMLElement, hint: string): HTMLLabelElement {
    const label = make("label", "lore-field-label");
    label.append(make("span", "lore-label-text", text), control, hintLine(hint));
    return label;
  }

  /** Checkbox with a one-line hint under it. */
  function checkBlock(
    labelText: string,
    checked: boolean,
    commit: (next: boolean) => void,
    hint: string,
  ): HTMLElement {
    const wrap = make("div", "lore-field-block");
    wrap.append(checkInput(labelText, checked, commit), hintLine(hint));
    return wrap;
  }

  function textInput(
    value: string,
    commit: (next: string) => void,
    placeholder = "",
  ): HTMLInputElement {
    const input = make("input", "field lore-text");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.addEventListener("input", () => commit(input.value));
    return input;
  }

  function numberInput(
    value: number | null,
    commit: (next: number | null) => void,
    placeholder = "",
  ): HTMLInputElement {
    const input = make("input", "field lore-number");
    input.type = "number";
    input.value = value === null ? "" : String(value);
    input.placeholder = placeholder;
    input.addEventListener("change", () => {
      const raw = input.value.trim();
      if (raw === "") {
        commit(null);
        return;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) {
        input.value = value === null ? "" : String(value);
        return;
      }
      commit(parsed);
    });
    return input;
  }

  function selectInput(
    values: { value: string; label: string }[],
    current: string,
    commit: (next: string) => void,
  ): HTMLSelectElement {
    const select = make("select", "field lore-select");
    for (const item of values) {
      const option = make("option", "", item.label);
      option.value = item.value;
      select.append(option);
    }
    select.value = current;
    select.addEventListener("change", () => commit(select.value));
    return select;
  }

  function checkInput(labelText: string, checked: boolean, commit: (next: boolean) => void): HTMLLabelElement {
    const input = make("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => commit(input.checked));
    const label = make("label", "lore-check");
    label.append(input, make("span", "", labelText));
    return label;
  }

  /** Position of the focused control inside the detail form, or -1 outside it. */
  function focusSlot(): number {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !detailHost.contains(active)) return -1;
    const list = Array.from(detailHost.querySelectorAll<HTMLElement>(DETAIL_FOCUSABLE));
    return list.indexOf(active);
  }

  /** Puts focus and the caret back after a legitimate rebuild of the form. */
  function restoreFocus(slot: number, caret: number | null): void {
    if (slot < 0) return;
    const node = Array.from(detailHost.querySelectorAll<HTMLElement>(DETAIL_FOCUSABLE))[slot];
    if (!node) return;
    node.focus();
    if (caret !== null && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
      try {
        node.setSelectionRange(caret, caret);
      } catch {
        // Numeric inputs refuse a caret range; focus alone is enough there.
      }
    }
  }

  function renderDetail(): void {
    const slot = focusSlot();
    const active = document.activeElement;
    const caret =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null;
    detailHost.replaceChildren();
    effectText = null;
    if (!doc) {
      detailHost.append(make("p", "lore-note", loadError !== "" ? "读取失败，暂不能编辑。" : "正在读取世界书…"));
      return;
    }
    let entry = doc.entries.find((item) => item.id === detailId);
    if (!entry) {
      entry = rows[0] ?? doc.entries[0];
      detailId = entry ? entry.id : "";
    }
    if (!entry) {
      detailHost.append(make("p", "lore-note", "在左侧选择一条条目，这里显示它的全部参数。"));
      return;
    }
    const current = entry;

    const head = make("div", "lore-detail-head");
    head.append(
      make("span", "lore-detail-id", "条目编号 " + current.id),
      make("span", "lore-detail-chars", String(current.content.length) + " 字"),
    );
    detailHost.append(head);

    effectText = make("p", "lore-effect-text", describeEntryEffect(current));
    const effectCard = make("div", "lore-effect");
    effectCard.append(make("span", "lore-effect-title", "本条效果"), effectText);
    detailHost.append(effectCard);

    detailHost.append(make("h3", "lore-section-title", "常用"));
    detailHost.append(
      checkBlock(
        "启用条目",
        current.enabled,
        (value) => updateEntry(current.id, { enabled: value }),
        HINTS.enabled,
      ),
    );

    detailHost.append(
      fieldBlock(
        "标题",
        textInput(current.title, (value) => updateEntry(current.id, { title: value }), "给这条起个名字"),
        HINTS.title,
      ),
    );
    detailHost.append(
      fieldBlock(
        "触发词",
        textInput(current.keys.join(", "), (value) => updateEntry(current.id, { keys: splitList(value) }), "例如：登记, 通行牌"),
        HINTS.keys,
      ),
    );
    detailHost.append(
      fieldBlock(
        "辅助触发词",
        textInput(
          current.secondaryKeys.join(", "),
          (value) => updateEntry(current.id, { secondaryKeys: splitList(value) }),
          "留空则不参与判定",
        ),
        HINTS.secondaryKeys,
      ),
    );
    detailHost.append(
      fieldBlock(
        "触发条件",
        selectInput(
          SELECTIVE_OPTIONS.map((item) => ({ value: item.value, label: item.label })),
          String(current.selectiveLogic),
          (value) => updateEntry(current.id, { selectiveLogic: Number(value) as SelectiveLogic }),
        ),
        HINTS.selectiveLogic,
      ),
    );

    const contentInput = make("textarea", "field lore-content");
    contentInput.rows = 6;
    contentInput.value = current.content;
    contentInput.placeholder = "生效时注入提示词的正文";
    const counter = make("span", "lore-counter", String(current.content.length) + " 字");
    contentInput.addEventListener("input", () => {
      counter.textContent = String(contentInput.value.length) + " 字";
      updateEntry(current.id, { content: contentInput.value });
    });
    const contentLabel = fieldBlock("条目内容", contentInput, HINTS.content);
    contentLabel.append(counter);
    detailHost.append(contentLabel);

    detailHost.append(
      checkBlock(
        "始终注入",
        current.constant,
        (value) => updateEntry(current.id, { constant: value }),
        HINTS.constant,
      ),
    );

    const chanceRow = make("div", "lore-chance");
    chanceRow.append(
      checkInput("按概率触发", current.useProbability, (value) =>
        updateEntry(current.id, { useProbability: value }),
      ),
      fieldBlock(
        "触发概率（%）",
        numberInput(current.probability, (value) => {
          if (value === null) return;
          updateEntry(current.id, { probability: Math.min(100, Math.max(0, value)) });
        }),
        HINTS.probability,
      ),
    );
    detailHost.append(chanceRow);

    const advanced = make("details", "lore-advanced");
    advanced.open = advancedOpenByBook.get(bookId) === true;
    advanced.addEventListener("toggle", () => {
      advancedOpenByBook.set(bookId, advanced.open);
    });
    advanced.append(make("summary", "lore-section-title", "高级"));
    detailHost.append(advanced);

    const positionRow = make("div", "lore-position-row");
    positionRow.append(
      fieldBlock(
        "注入位置",
        selectInput(
          [
            { value: "before_char", label: "角色设定之前" },
            { value: "after_char", label: "角色设定之后" },
            { value: "at_depth", label: "指定深度" },
          ],
          current.position,
          (value) => updateEntry(current.id, { position: value as LorePosition }),
        ),
        HINTS.position,
      ),
      fieldBlock(
        "注入深度",
        numberInput(current.depth, (value) => updateEntry(current.id, { depth: value ?? 0 })),
        HINTS.depth,
      ),
      fieldBlock(
        "注入角色",
        selectInput(
          [
            { value: "system", label: "系统" },
            { value: "user", label: "玩家" },
            { value: "assistant", label: "角色" },
          ],
          current.depthRole,
          (value) => updateEntry(current.id, { depthRole: value as LoreDepthRole }),
        ),
        HINTS.role,
      ),
    );
    advanced.append(positionRow);

    const numbers = make("div", "lore-number-row");
    numbers.append(
      fieldBlock(
        "注入顺序",
        numberInput(current.order, (value) => updateEntry(current.id, { order: value ?? 0 })),
        HINTS.order,
      ),
      fieldBlock(
        "持续轮次",
        numberInput(current.sticky, (value) => updateEntry(current.id, { sticky: Math.max(0, value ?? 0) })),
        HINTS.sticky,
      ),
      fieldBlock(
        "冷却轮次",
        numberInput(current.cooldown, (value) => updateEntry(current.id, { cooldown: Math.max(0, value ?? 0) })),
        HINTS.cooldown,
      ),
      fieldBlock(
        "延迟轮次",
        numberInput(current.delay, (value) => updateEntry(current.id, { delay: Math.max(0, value ?? 0) })),
        HINTS.delay,
      ),
    );
    advanced.append(numbers);

    const group = make("div", "lore-number-row");
    group.append(
      fieldBlock(
        "互斥组",
        textInput(current.group, (value) => updateEntry(current.id, { group: value }), "同组每轮只生效一条"),
        HINTS.group,
      ),
      fieldBlock(
        "组内权重",
        numberInput(current.groupWeight, (value) =>
          updateEntry(current.id, { groupWeight: Math.max(1, value ?? 1) }),
        ),
        HINTS.groupWeight,
      ),
      checkBlock(
        "组内优先",
        current.groupOverride,
        (value) => updateEntry(current.id, { groupOverride: value }),
        HINTS.groupOverride,
      ),
    );
    advanced.append(group);

    advanced.append(
      fieldBlock(
        "检索范围覆盖",
        numberInput(
          current.scanDepth,
          (value) => updateEntry(current.id, { scanDepth: value }),
          String(doc.scanDepth),
        ),
        HINTS.scanDepth,
      ),
    );

    const recursion = make("div", "lore-check-row lore-check-hints");
    recursion.append(
      checkBlock(
        "排除级联",
        current.excludeRecursion,
        (value) => updateEntry(current.id, { excludeRecursion: value }),
        HINTS.exclude,
      ),
      checkBlock(
        "阻止级联",
        current.preventRecursion,
        (value) => updateEntry(current.id, { preventRecursion: value }),
        HINTS.prevent,
      ),
      checkBlock(
        "正则触发词",
        current.useRegex,
        (value) => updateEntry(current.id, { useRegex: value }),
        HINTS.regex,
      ),
      checkBlock(
        "区分大小写",
        current.caseSensitive,
        (value) => updateEntry(current.id, { caseSensitive: value }),
        HINTS.caseSensitive,
      ),
    );
    advanced.append(recursion);

    const previewRow = make("div", "lore-preview-row");
    const previewEnabled = options.worldbookEnabled ? options.worldbookEnabled() : true;
    const one = button("试算本条", "ghost");
    const whole = button("试算整书", "ghost");
    one.disabled = !previewEnabled;
    whole.disabled = !previewEnabled;
    const report = make("pre", "lore-report", "");
    report.hidden = true;
    one.addEventListener("click", () => void runPreview(current.id, "entry", report));
    whole.addEventListener("click", () => void runPreview(current.id, "book", report));
    previewRow.append(one, whole);
    detailHost.append(previewRow);
    if (!previewEnabled) {
      detailHost.append(
        make("p", "lore-note", "设置中的世界书总开关已关闭，试算不可用；开启后恢复。"),
      );
    }
    detailHost.append(report);
    restoreFocus(slot, caret);
  }

  /** What one preview run scanned, plus the line that says where it came from. */
  interface PreviewInput {
    messages: WorldMessage[];
    turn: number;
    source: string;
  }

  function formatEntryReport(
    entry: LoreEntry,
    result: ReturnType<typeof explainEntry>,
    input: PreviewInput,
  ): string {
    const lines: string[] = [];
    lines.push(input.source);
    lines.push("试算本条 · 检索 " + String(input.messages.length) + " 条消息");
    if (result.activated) {
      lines.push("结果：生效（" + reasonText(result.reason ?? "keyword") + "）");
    } else {
      const reason: LoreSkipLabel = result.skip ?? "miss";
      lines.push("结果：未生效 · " + skipLabel(reason));
      lines.push(skipHint(reason));
    }
    lines.push("篇幅：" + String(result.chars) + " 字 / 上限 " + String(result.budgetChars) + " 字");
    lines.push("本轮已用：" + String(result.usedChars) + " 字 · 级联层数 " + String(result.rounds));
    lines.push("注入位置：" + positionText(entry));
    return lines.join("\n");
  }

  function formatBookReport(
    result: LoreActivationResult,
    entries: readonly LoreEntry[],
    input: PreviewInput,
  ): string {
    const lines: string[] = [];
    lines.push(input.source);
    lines.push(
      "试算整书 · 第 " +
        String(result.log.turn) +
        " 轮 · 检索 " +
        String(input.messages.length) +
        " 条消息 · 篇幅上限 " +
        String(result.log.budgetChars) +
        " 字（随机值固定 0.5）",
    );
    lines.push(
      "生效 " +
        String(result.log.activated.length) +
        " 条 · 用 " +
        String(result.log.usedChars) +
        " 字 · " +
        String(result.log.rounds) +
        " 层级联",
    );
    for (const record of result.log.activated) {
      lines.push(
        "  + [" +
          (record.title || record.entryId) +
          "] " +
          reasonText(record.reason) +
          " · " +
          String(record.chars) +
          " 字 · " +
          positionName(record.position),
      );
    }
    const seen = new Set<string>();
    for (const record of result.log.skipped) {
      seen.add(record.entryId);
      lines.push("  - [" + (record.title || record.entryId) + "] " + skipLabel(record.reason));
    }
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      if (result.log.activated.some((record) => record.entryId === entry.id)) continue;
      lines.push("  - [" + (entry.title || entry.id) + "] 未命中");
    }
    return lines.join("\n");
  }

  /** Reads one stored transcript; null means the read failed. */
  async function readPreviewSession(
    id: string,
  ): Promise<{ messages: WorldMessage[]; turn: number; title: string } | null> {
    try {
      const data = await Sessions.load(id);
      const raw: unknown[] = [];
      for (const line of data.messages ?? []) {
        try {
          raw.push(JSON.parse(line) as unknown);
        } catch {
          // Skip a broken transcript line instead of failing the whole report.
        }
      }
      let turn = 1;
      try {
        const state = JSON.parse(data.state) as { meta?: { turn?: unknown } };
        const value = state.meta?.turn;
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          turn = Math.floor(value);
        }
      } catch {
        // A pending or empty state keeps turn 1.
      }
      const title = data.summary?.title?.trim() || data.summary?.id || id;
      return { messages: scanMessages(raw as AgentMessage[]), turn, title };
    } catch {
      return null;
    }
  }

  /**
   * Picks the transcript behind a preview. The editor supplies the session the
   * player is in; when it cannot, the report says so rather than passing some
   * arbitrary recent conversation off as the current scene.
   */
  async function loadPreviewInput(): Promise<PreviewInput> {
    const open = options.currentSession ? (options.currentSession() ?? "") : "";
    if (open !== "") {
      const current = await readPreviewSession(open);
      if (current) {
        return {
          messages: current.messages,
          turn: current.turn,
          source: "试算场次：当前场次《" + current.title + "》",
        };
      }
      return { messages: [], turn: 1, source: "试算场次：当前场次读取失败，本次按空对话试算" };
    }
    let newest: string | undefined;
    try {
      newest = (await Sessions.list())[0]?.id;
    } catch {
      return { messages: [], turn: 1, source: "试算场次：读取场次列表失败，本次按空对话试算" };
    }
    if (!newest) {
      return { messages: [], turn: 1, source: "试算场次：当前没有场次，本次按空对话试算" };
    }
    const fallback = await readPreviewSession(newest);
    if (!fallback) {
      return { messages: [], turn: 1, source: "试算场次：读取最近一场失败，本次按空对话试算" };
    }
    return {
      messages: fallback.messages,
      turn: fallback.turn,
      source: "试算场次：当前无场次，试算基于最近一场《" + fallback.title + "》",
    };
  }

  async function runPreview(
    id: string,
    mode: "entry" | "book",
    report: HTMLElement,
  ): Promise<void> {
    if (!doc) return;
    if (!(options.worldbookEnabled ? options.worldbookEnabled() : true)) {
      options.onStatus("世界书总开关已关闭，试算不可用。", true);
      return;
    }
    const entry = doc.entries.find((item) => item.id === id);
    if (!entry) return;
    const book = loreDocumentToBook(doc, bookId);
    const input = await loadPreviewInput();
    if (mode === "entry") {
      report.textContent = formatEntryReport(entry, explainEntry(book, entry, input.messages, input.turn), input);
    } else {
      report.textContent = formatBookReport(
        previewActivation(book, input.messages, input.turn),
        doc.entries,
        input,
      );
    }
    report.hidden = false;
  }

  /* ------------------------------ save / load ---------------------------- */

  function syncBookBar(): void {
    if (!doc) return;
    nameInput.value = doc.name;
    depthInput.value = String(doc.scanDepth);
    budgetInput.value = String(doc.budgetChars);
    recursiveInput.checked = doc.recursive;
  }

  /**
   * Books merged into this one by 合并导入. They are removed from the shelf only
   * after a save wrote the merged entries, so a failed or skipped save keeps
   * the import reachable.
   */
  let pendingRemoval: { id: string; name: string }[] = [];

  async function save(): Promise<LorebookSaveResult> {
    if (!doc) throw new Error("世界书还没有载入，先关闭再打开");
    doc.name = nameInput.value.trim() || doc.name;
    const saved = await saveLoreDocument(bookId, doc);
    bookId = saved.id;
    doc = saved.doc;
    dirty = false;
    syncBookBar();
    renderChrome();
    renderDetail();
    void refreshChoices();
    await removeMergedSources(saved.id);
    return { id: saved.id, doc: saved.doc };
  }

  /** Deletes merged source books once their entries are written to this one. */
  async function removeMergedSources(keepId: string): Promise<void> {
    if (pendingRemoval.length === 0) return;
    const queue = pendingRemoval;
    pendingRemoval = [];
    const failed: string[] = [];
    let removed = 0;
    for (const item of queue) {
      if (item.id === keepId) continue;
      try {
        await deleteLibraryEntry("lore", item.id);
        removed += 1;
      } catch (error) {
        pendingRemoval.push(item);
        failed.push(item.name + "：" + String(error));
      }
    }
    if (removed > 0) void refreshChoices();
    if (failed.length > 0) {
      options.onStatus("已保存，但源世界书未能删除（" + failed.join("；") + "），下次保存会重试", true);
    } else if (removed > 0) {
      options.onStatus("已保存，并删除已合并的源世界书 " + String(removed) + " 本");
    }
  }

  async function exportSelected(): Promise<void> {
    if (!doc) {
      options.onStatus("世界书还没有载入", true);
      return;
    }
    const picked = doc.entries.filter((entry) => selected.has(entry.id));
    if (picked.length === 0) {
      options.onStatus("先选中要导出的条目");
      return;
    }
    const allowed = new Set<string>();
    const rawKeys: Record<string, string> = {};
    for (const entry of picked) {
      const key = doc.rawKeys[entry.id];
      if (key === undefined) continue;
      allowed.add(key);
      rawKeys[entry.id] = key;
    }
    const rawEntries: LoreDocument["rawEntries"] = {};
    for (const [key, value] of Object.entries(doc.rawEntries)) {
      if (allowed.has(key)) rawEntries[key] = value;
    }
    const subset: LoreDocument = {
      ...doc,
      name: (doc.name || "世界书") + "（节选）",
      entries: picked,
      rawEntries,
      rawKeys,
    };
    const content = JSON.stringify(mergeLoreDocument(subset), null, 2);
    try {
      const path = await saveLoreText((doc.name || "世界书") + "-节选.json", content);
      options.onStatus(path ? "已导出到 " + path : "已取消导出");
    } catch (error) {
      options.onStatus("导出失败：" + String(error), true);
    }
  }

  async function mergeImport(): Promise<{ count: number; name: string } | null> {
    if (!doc) {
      options.onStatus("世界书还没有载入", true);
      return null;
    }
    let imported: { id: string; name: string } | null = null;
    try {
      imported = await importLorebookFile();
    } catch (error) {
      options.onStatus("导入失败：" + String(error), true);
      return null;
    }
    if (!imported) {
      options.onStatus("已取消导入");
      return null;
    }
    try {
      const temp = await loadLoreDocumentById(imported.id);
      if (!temp) throw new Error("导入的世界书读取失败");
      const ids = new Set(temp.doc.entries.map((entry) => entry.id));
      const result = moveEntriesToBook(temp.doc, doc, ids);
      if (result.moved.length === 0) throw new Error("导入的世界书没有条目");
      doc = result.target;
      markDirty();
      renderChrome();
      renderDetail();
      pendingRemoval.push({ id: imported.id, name: imported.name });
      void refreshChoices();
      options.onStatus(
        "已合并导入 " + String(result.moved.length) + " 条，保存后写入并删除源书《" + imported.name + "》",
      );
      return { count: result.moved.length, name: imported.name };
    } catch (error) {
      options.onStatus("合并导入失败：" + String(error), true);
      return null;
    }
  }

  async function refreshChoices(): Promise<void> {
    choices = await listLorebookChoices().catch(() => []);
    if (destroyed) return;
    renderBulk();
  }

  /* --------------------------------- boot -------------------------------- */

  const ready = (async () => {
    try {
      const loaded = await loadLoreDocumentById(bookId);
      if (destroyed) return;
      doc = loaded ? loaded.doc : emptyLoreDocument("世界书");
      if (loaded) bookId = loaded.id;
      loadError = "";
    } catch (error) {
      if (destroyed) return;
      doc = null;
      loadError = String(error);
      options.onStatus("读取世界书失败：" + loadError, true);
    }
    syncBookBar();
    renderChrome();
    renderDetail();
    void refreshChoices();
  })();

  /* -------------------------------- teardown ----------------------------- */

  function destroy(): void {
    destroyed = true;
    controller.abort();
    window.clearTimeout(deleteTimer);
    window.clearTimeout(searchTimer);
    if (frame !== 0) window.cancelAnimationFrame(frame);
    resize.disconnect();
    for (const node of [bookHost, toolbarHost, rowsHost, bulkHost, detailHost]) {
      node.replaceChildren();
    }
  }

  return {
    ready,
    save,
    document: () => doc,
    isDirty: () => dirty,
    setTitle: (name: string) => {
      if (!doc) return;
      doc.name = name;
      nameInput.value = name;
      markDirty();
    },
    exportSelected,
    mergeImport,
    destroy,
  };
}
