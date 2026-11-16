/**
 * Transcript rendering. A scene is a script: speakers, narration, tool
 * machinery and, in developer mode, the operator speaking over the world.
 */

import { iconMarkup, TOOL_ICONS } from "./icons";
import { toolKey, toolLabel, toolNarrativeLine, toolSummary } from "./tools";
import { parseBlocks, type Block, type BlockKind, type BlockPreview } from "./world/blocks";

export type Role = "user" | "assistant" | "narrator" | "tool" | "god" | "notice" | "error";
export type ToolState = "running" | "done" | "error";

interface Line {
  root: HTMLElement;
  speech: HTMLElement;
  who: HTMLElement | null;
}

/** Temporary block of the reply still being written. */
interface PreviewLine {
  kind: BlockKind;
  speaker: string;
  root: HTMLElement;
  speech: HTMLElement;
}

export interface ToolHandle {
  update(state: ToolState, result?: string): void;
  element: HTMLElement;
}

export interface ConfirmOptions {
  title: string;
  body?: string;
  approveLabel?: string;
  denyLabel?: string;
  name?: string;
  approve: () => void;
  deny?: () => void;
}

const DEFAULT_SPEAKER = "AppleCos";

/** Typewriter output is a UI preference, mirrored on the document root. */
function typewriterOn(): boolean {
  return document.documentElement.dataset.flagTypewriter !== "off";
}

/** Renders the transcript as a script page: who speaks, then the line. */
export class ChatView {
  private readonly root: HTMLElement;
  private readonly empty: HTMLElement | null;
  private current: Line | null = null;
  private currentText = "";
  /** Speech group of the running structured reply, so a speaker names once. */
  private group: { root: HTMLElement; speaker: string } | null = null;
  /** Live block of the running reply, replaced once its formal block lands. */
  private preview: PreviewLine | null = null;
  /** Follow new output only while the reader is at the bottom of the script. */
  private stick = true;

  constructor(root: HTMLElement) {
    this.root = root;
    this.empty = document.querySelector<HTMLElement>("#empty");
    this.root.addEventListener(
      "scroll",
      () => {
        this.stick = this.nearBottom();
      },
      { passive: true },
    );
  }

  say(role: Role, text: string, who?: string): HTMLElement {
    const line = this.makeLine(role, who);
    line.speech.textContent = text;
    this.scroll();
    return line.root;
  }

  /** A scene direction, not dialogue. */
  narrate(text: string): void {
    this.say("narrator", text);
  }

  /** A line from the operator, rendered apart from the character's voice. */
  god(text: string): void {
    this.say("god", text, "神域");
  }

  startAssistant(who?: string): void {
    if (this.current) {
      if (who && this.current.who) this.current.who.textContent = who;
      return;
    }
    this.current = this.makeLine("assistant", who ?? DEFAULT_SPEAKER);
    this.current.speech.classList.add("streaming");
    this.currentText = "";
    this.scroll();
  }

  delta(text: string): void {
    this.startAssistant();
    if (!this.current) return;
    this.currentText += text;
    if (typewriterOn()) {
      this.current.speech.textContent = this.currentText;
      this.scroll();
    }
  }

  finishAssistant(text: string, who?: string): void {
    this.startAssistant(who);
    if (!this.current) return;
    const line = this.current;
    this.currentText = text;
    line.speech.textContent = text;
    line.speech.classList.remove("streaming");
    if (who && line.who) line.who.textContent = who;
    this.current = null;
    this.scroll();
  }

  /** Opens one structured reply; its blocks arrive through appendBlocks. */
  beginBlocks(): void {
    this.current = null;
    this.currentText = "";
    this.group = null;
    this.clearPreview();
  }

  /**
   * Renders finished blocks. Narration stands apart; speech and thought of the
   * same speaker share one group and name that speaker once.
   */
  appendBlocks(blocks: readonly Block[]): void {
    // The temp block steps aside before the formal ones land.
    this.clearPreview();
    if (blocks.length === 0) return;
    this.setEmpty(false);
    for (const block of blocks) {
      if (block.kind === "narration") {
        this.group = null;
        this.appendNarration(block.text);
        continue;
      }
      this.appendVoice(block.kind, block.speaker ?? "", block.text);
    }
    this.scroll();
  }

  /** Closes the running structured reply. */
  endBlocks(): void {
    this.group = null;
    this.clearPreview();
  }

  /**
   * Shows the block still being written, with the streaming caret. The formal
   * block replaces it as soon as its object closes; with the typewriter switch
   * off nothing previews and blocks land whole.
   */
  updatePreview(preview: BlockPreview | null): void {
    if (!preview || preview.text === "" || !typewriterOn()) {
      this.clearPreview();
      return;
    }
    const speaker = preview.speaker ?? "";
    if (!this.preview || this.preview.kind !== preview.kind || this.preview.speaker !== speaker) {
      this.clearPreview();
      this.preview = this.buildPreview(preview.kind, speaker);
    }
    const line = this.preview;
    if (!line) return;
    line.speech.textContent = preview.text;
    this.scroll();
  }

  /** Drops the temp block, e.g. when the reply ends or the transcript rebuilds. */
  clearPreview(): void {
    if (!this.preview) return;
    this.preview.root.remove();
    this.preview = null;
  }

  error(text: string): void {
    this.current = null;
    this.group = null;
    this.clearPreview();
    this.say("error", text);
  }

  /**
   * One tool call as a compact bubble: round badge, a single line of story and
   * the trailing state. Developer mode adds the technical name and arguments.
   */
  tool(name: string, args: string, state: ToolState = "running"): ToolHandle {
    this.setEmpty(false);

    const dev = developerMode();
    const key = toolKey(name);
    const article = document.createElement("article");
    article.className = "line tool";
    article.dataset.tool = key;

    const bubble = document.createElement("div");
    bubble.className = "tool-bubble";
    bubble.dataset.state = state;

    const badge = document.createElement("span");
    badge.className = "tool-badge";
    badge.setAttribute("aria-hidden", "true");
    badge.innerHTML = iconMarkup(TOOL_ICONS[key] ?? "gear");

    const body = document.createElement("span");
    body.className = "tool-body";

    const main = document.createElement("span");
    main.className = "tool-main";

    const label = document.createElement("span");
    label.className = "tool-name";
    label.textContent = toolLabel(key, !dev);

    // A call carries JSON arguments; a stored result arrives as one line.
    const callArgs = parseToolArgs(args);
    const narrative = callArgs === null ? toolNarrativeLine(key, args) : toolSummary(key, callArgs, true);
    const technical = callArgs === null ? oneLine(args) : toolSummary(key, callArgs, false);

    const summary = document.createElement("span");
    summary.className = "tool-text";
    summary.textContent = dev ? technical : narrative;

    main.append(label);
    if (summary.textContent !== "") main.append(summary);
    body.append(main);

    const argumentRow = document.createElement("span");
    argumentRow.className = "tool-args";
    argumentRow.textContent = callArgs === null ? key : key + " " + oneLine(args, 160);
    argumentRow.hidden = !dev;
    body.append(argumentRow);

    const resultRow = document.createElement("span");
    resultRow.className = "tool-result";
    resultRow.hidden = true;
    body.append(resultRow);

    const status = document.createElement("span");
    status.className = "tool-status";
    status.dataset.state = state;
    status.innerHTML = stateGlyph(state);
    status.title = statusLabel(state);
    status.setAttribute("aria-label", statusLabel(state));

    bubble.append(badge, body, status);
    article.append(bubble);
    this.root.append(article);
    this.scroll();

    const handle: ToolHandle = {
      element: article,
      update: (next: ToolState, result?: string): void => {
        bubble.dataset.state = next;
        status.dataset.state = next;
        status.innerHTML = stateGlyph(next);
        status.title = statusLabel(next);
        status.setAttribute("aria-label", statusLabel(next));
        if (result !== undefined) {
          resultRow.textContent = result;
          resultRow.hidden = result.length === 0;
        }
        this.scroll();
      },
    };
    return handle;
  }

  /** A tool that needs a decision before it runs. */
  confirm(options: ConfirmOptions): HTMLElement {
    this.setEmpty(false);

    const card = document.createElement("div");
    card.className = "confirm-card";
    card.setAttribute("role", "group");

    const head = document.createElement("p");
    head.className = "confirm-head";
    head.textContent = options.title;

    card.append(head);

    if (options.body) {
      const body = document.createElement("pre");
      body.className = "confirm-body";
      body.textContent = options.body;
      card.append(body);
    }

    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "approve";
    approve.textContent = options.approveLabel ?? "批准";

    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "deny";
    deny.textContent = options.denyLabel ?? "拒绝";

    const settle = (state: "approved" | "denied"): void => {
      card.dataset.state = state;
      actions.remove();
      document.dispatchEvent(
        new CustomEvent(state === "approved" ? "applecos:tool-approve" : "applecos:tool-deny", {
          detail: { name: options.name ?? options.title },
        }),
      );
    };

    approve.addEventListener("click", () => {
      settle("approved");
      options.approve();
    });
    deny.addEventListener("click", () => {
      settle("denied");
      options.deny?.();
    });

    actions.append(approve, deny);
    card.append(actions);
    this.root.append(card);
    this.scroll();
    return card;
  }

  /** Replays stored messages into a fresh transcript. */
  render(messages: unknown[]): void {
    this.clear();

    for (const raw of messages) {
      const message = raw as {
        role?: string;
        content?: unknown;
        text?: string;
        speaker?: string;
        name?: string;
        toolName?: string;
        isError?: boolean;
      };
      const role = message.role ?? "assistant";
      const speaker = message.speaker ?? message.name;

      if (role === "system") continue;

      if (role === "user") {
        this.say("user", messageText(message));
        continue;
      }

      if (role === "assistant") {
        const blocks = Array.isArray(message.content) ? message.content : null;
        const text = messageText(message);
        this.replayAssistant(text);
        if (!blocks) continue;
        for (const block of blocks) {
          const candidate = block as { type?: string; name?: string; arguments?: unknown; text?: string };
          if (candidate.type !== "toolCall" || !candidate.name) continue;
          const args =
            typeof candidate.arguments === "string"
              ? candidate.arguments
              : JSON.stringify(candidate.arguments ?? {}, null, 2);
          this.tool(candidate.name, args, "done");
        }
        continue;
      }

      if (role === "toolResult" || role === "tool") {
        const label = message.toolName ?? message.name ?? "工具";
        this.tool(label, messageText(message), message.isError ? "error" : "done");
        continue;
      }

      if (role === "narrator" || role === "god" || role === "notice" || role === "error") {
        this.say(role as Role, messageText(message) || message.text || "", speaker);
        continue;
      }

      this.say("assistant", messageText(message) || message.text || "", speaker ?? DEFAULT_SPEAKER);
    }

    this.setEmpty(messages.length === 0);
    this.scroll(true);
  }

  clear(): void {
    this.clearPreview();
    this.root.replaceChildren();
    this.current = null;
    this.currentText = "";
    this.group = null;
    this.setEmpty(true);
  }

  /** Distance under which new output keeps the reader pinned to the end. */
  private static readonly STICK_SLACK = 48;

  private nearBottom(): boolean {
    const { scrollHeight, scrollTop, clientHeight } = this.root;
    return scrollHeight - scrollTop - clientHeight <= ChatView.STICK_SLACK;
  }

  /**
   * Follow the newest line, unless the reader scrolled up to read back;
   * scrolling to the bottom again resumes following. Pass true to jump to
   * the end regardless, as loading a scene does.
   */
  scroll(force = false): void {
    if (force) this.stick = true;
    if (!this.stick) return;
    this.root.scrollTop = this.root.scrollHeight;
  }

  /** The opening card steps aside once the script starts. */
  private setEmpty(visible: boolean): void {
    if (this.empty) this.empty.dataset.visible = visible ? "true" : "false";
  }

  /** Replays one assistant turn: structured blocks, or plain narration. */
  private replayAssistant(text: string): void {
    if (text.trim() === "") return;
    const blocks = parseBlocks(text);
    this.beginBlocks();
    this.appendBlocks(blocks ?? [{ kind: "narration", text }]);
    this.endBlocks();
  }

  /**
   * Temp block for the open one: the same shape a formal block gets, plus the
   * streaming caret, so the swap on close reads as one line settling down.
   */
  private buildPreview(kind: BlockKind, speaker: string): PreviewLine {
    this.setEmpty(false);
    const article = document.createElement("article");
    article.className = `line ${kind} preview`;
    const speech = document.createElement("p");
    speech.className = "speech streaming";
    article.append(speech);
    if (kind === "narration") {
      this.root.append(article);
      return { kind, speaker, root: article, speech };
    }
    // An open group already names this speaker: the temp line joins it, so the
    // name never appears twice while the block is still arriving.
    if (this.group && this.group.speaker === speaker) {
      this.group.root.append(article);
      return { kind, speaker, root: article, speech };
    }
    const group = document.createElement("div");
    group.className = "speech-group preview";
    if (speaker !== "") {
      const head = document.createElement("p");
      head.className = "speech-group-head";
      head.textContent = speaker;
      group.append(head);
    }
    group.append(article);
    this.root.append(group);
    return { kind, speaker, root: group, speech };
  }

  /** Narration holds environment and psychology only, never dialogue. */
  private appendNarration(text: string): void {
    const article = document.createElement("article");
    article.className = "line narration";
    const speech = document.createElement("p");
    speech.className = "speech";
    speech.textContent = text;
    article.append(speech);
    this.root.append(article);
  }

  /** Speech and thought of one speaker share a group and a single name. */
  private appendVoice(kind: "speech" | "thought", speaker: string, text: string): void {
    if (!this.group || this.group.speaker !== speaker) {
      const root = document.createElement("div");
      root.className = "speech-group";
      if (speaker !== "") {
        const head = document.createElement("p");
        head.className = "speech-group-head";
        head.textContent = speaker;
        root.append(head);
      }
      this.root.append(root);
      this.group = { root, speaker };
    }
    const article = document.createElement("article");
    article.className = `line ${kind}`;
    const speech = document.createElement("p");
    speech.className = "speech";
    speech.textContent = text;
    article.append(speech);
    this.group.root.append(article);
  }

  private makeLine(role: Role, who?: string): Line {
    this.setEmpty(false);

    const article = document.createElement("article");
    article.className = `line ${role}`;

    let whoElement: HTMLElement | null = null;
    if (role !== "error" && role !== "notice" && role !== "tool" && role !== "narrator") {
      whoElement = document.createElement("span");
      whoElement.className = "who";
      if (role === "user") {
        whoElement.textContent = "你";
      } else if (role === "god") {
        whoElement.textContent = who ?? "神域";
      } else {
        const mark = document.createElement("span");
        mark.className = "speaker-mark";
        whoElement.append(mark, document.createTextNode(who ?? DEFAULT_SPEAKER));
      }
      article.append(whoElement);
    }

    const speech = document.createElement("p");
    speech.className = "speech";
    article.append(speech);
    this.root.append(article);
    return { root: article, speech, who: whoElement };
  }
}

function statusLabel(state: ToolState): string {
  if (state === "running") return "运行中";
  if (state === "error") return "失败";
  return "完成";
}

/** Developer mode is mirrored on the document root by the flags. */
function developerMode(): boolean {
  return document.documentElement.dataset.flagDev === "on";
}

/** Tool arguments arrive as JSON text; null when the slot holds a result line. */
function parseToolArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Collapses a stored result line into one short sentence. */
function oneLine(raw: string, max = 60): string {
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) + "…" : text;
}

const STATE_GLYPHS: Record<ToolState, string> = {
  running:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="3.4" fill="currentColor"/></svg>',
  done:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.4 8.6 6.5 11.7 12.7 4.9"/></svg>',
  error:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.6 14 13.4H2z"/>' +
    '<path d="M8 6.6v2.9"/><path d="M8 11.4h.01"/></svg>',
};

function stateGlyph(state: ToolState): string {
  return STATE_GLYPHS[state];
}

/** Text blocks of an agent message, joined. */
export function messageText(message: unknown): string {
  const source = message as { content?: unknown; text?: unknown };
  if (typeof source.text === "string") return source.text;
  const content = source.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => {
      const b = block as { type?: string; text?: string };
      return b.type === "text" && typeof b.text === "string";
    })
    .map((block) => block.text)
    .join("");
}
