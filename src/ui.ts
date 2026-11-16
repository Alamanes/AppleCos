type Role = "user" | "assistant" | "notice" | "error";

interface Line {
  root: HTMLElement;
  speech: HTMLElement;
}

/** Renders the transcript as a script page: who speaks, then the line. */
export class ChatView {
  private readonly root: HTMLElement;
  private current: Line | null = null;
  private currentText = "";

  constructor(root: HTMLElement) {
    this.root = root;
  }

  say(role: Role, text: string): void {
    const line = this.makeLine(role);
    line.speech.textContent = text;
    this.scroll();
  }

  startAssistant(): void {
    if (this.current) return;
    this.current = this.makeLine("assistant");
    this.current.speech.classList.add("streaming");
    this.currentText = "";
  }

  delta(text: string): void {
    this.startAssistant();
    if (!this.current) return;
    this.currentText += text;
    this.current.speech.textContent = this.currentText;
    this.scroll();
  }

  finishAssistant(text: string): void {
    this.startAssistant();
    if (!this.current) return;
    this.currentText = text;
    this.current.speech.textContent = text;
    this.current.speech.classList.remove("streaming");
    this.current = null;
    this.scroll();
  }

  error(text: string): void {
    this.current = null;
    this.say("error", text);
  }

  clear(): void {
    this.root.replaceChildren();
    this.current = null;
    this.currentText = "";
  }

  scroll(): void {
    this.root.scrollTop = this.root.scrollHeight;
  }

  private makeLine(role: Role): Line {
    const article = document.createElement("article");
    article.className = `line ${role}`;

    if (role !== "error" && role !== "notice") {
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = role === "user" ? "你" : "AppleCos";
      article.append(who);
    }

    const speech = document.createElement("p");
    speech.className = "speech";
    article.append(speech);
    this.root.append(article);
    return { root: article, speech };
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
