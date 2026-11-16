type Role = "user" | "assistant" | "tool" | "error";

/** Minimal transcript view: one bubble per message, streamed text appended in place. */
export class ChatView {
  private readonly root: HTMLElement;
  private current: HTMLElement | null = null;
  private currentText = "";

  constructor(root: HTMLElement) {
    this.root = root;
  }

  user(text: string): void {
    this.bubble("user", text);
    this.scroll();
  }

  startAssistant(): void {
    if (this.current) return;
    this.current = this.bubble("assistant", "");
    this.currentText = "";
  }

  delta(text: string): void {
    this.startAssistant();
    this.currentText += text;
    if (this.current) this.current.textContent = this.currentText;
    this.scroll();
  }

  finishAssistant(text: string): void {
    this.startAssistant();
    this.currentText = text;
    if (this.current) this.current.textContent = text;
    this.current = null;
    this.scroll();
  }

  tool(name: string, text: string): void {
    this.bubble("tool", `${name} ${text}`.trim());
    this.scroll();
  }

  error(text: string): void {
    this.current = null;
    this.bubble("error", text);
    this.scroll();
  }

  clear(): void {
    this.root.replaceChildren();
    this.current = null;
    this.currentText = "";
  }

  scroll(): void {
    this.root.scrollTop = this.root.scrollHeight;
  }

  private bubble(role: Role, text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = `bubble ${role}`;
    el.textContent = text;
    this.root.append(el);
    return el;
  }
}

/** Text blocks of an agent message, joined. */
export function messageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
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
