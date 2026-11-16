import { fetch as goFetch } from "@mygo-plugins/fetch";

import type { Shape, Wire } from "./agent";
import { Settings, type Config } from "./mygo";

export interface ModelEntry {
  id: string;
  label: string;
}

const DEFAULT_PROMPT =
  "你是 AppleCos 的角色扮演引擎，运行在用户自己的 Mac 上。\n用简体中文回答，保持角色设定与沉浸感，不要解释你自己的实现细节。";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

type Pane = "general" | "model" | "persona" | "about";
type Theme = "system" | "light" | "dark";

const PANE_TITLES: Record<Pane, string> = {
  general: "通用",
  model: "模型",
  persona: "个性化",
  about: "关于",
};

/** Where a model list lives for each wire protocol. */
function modelsUrl(kind: Wire, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (kind === "anthropic") {
    return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  }
  return `${base}/models`;
}

/** Asks the endpoint for its model ids, through the Go side so no CORS applies. */
export async function listModels(kind: Wire, baseUrl: string, apiKey: string): Promise<ModelEntry[]> {
  if (!baseUrl.trim()) throw new Error("先填写接口地址");
  const headers: Record<string, string> =
    kind === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${apiKey}` };

  const response = await goFetch(modelsUrl(kind, baseUrl), { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${text.slice(0, 160)}`);
  }

  const payload = JSON.parse(text) as {
    data?: { id?: string; display_name?: string; displayName?: string }[];
  };
  return (payload.data ?? [])
    .map((entry) => {
      const id = entry.id ?? "";
      return { id, label: entry.display_name ?? entry.displayName ?? id };
    })
    .filter((entry) => entry.id !== "");
}

let draft: Config = { kind: "openai", shape: "chat", baseUrl: "", model: "", theme: "system" };
let bound = false;

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme === "light" || theme === "dark" ? theme : "system";
}

function showPane(pane: Pane): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".nav-item")) {
    button.classList.toggle("selected", button.dataset.pane === pane);
  }
  for (const section of document.querySelectorAll<HTMLElement>(".pane")) {
    const active = section.dataset.pane === pane;
    section.classList.toggle("active", active);
    if (active) {
      section.classList.remove("enter");
      void section.offsetWidth;
      section.classList.add("enter");
    }
  }
  $("#pane-title").textContent = PANE_TITLES[pane];
}

/** Keeps the hint, placeholder and shape switch in sync with kind + shape. */
function updateHint(): void {
  const hint = $("#wire-hint");
  const shapeRow = $("#shape");
  const baseUrl = $<HTMLInputElement>("#base-url");

  if (draft.kind === "anthropic") {
    shapeRow.hidden = true;
    hint.textContent = "Anthropic 兼容 · 请求发往 /v1/messages";
    baseUrl.placeholder = "https://api.anthropic.com";
    $("#key-label-hint").textContent = "以 x-api-key 发送";
    return;
  }

  shapeRow.hidden = false;
  hint.textContent =
    draft.shape === "responses"
      ? "OpenAI Responses · 请求发往 /v1/responses"
      : "OpenAI 兼容 · 请求发往 /v1/chat/completions";
  baseUrl.placeholder = "https://api.openai.com/v1";
  $("#key-label-hint").textContent = "以 Bearer 发送";
}

function setWire(kind: Wire): void {
  draft.kind = kind;
  const wire = $("#wire");
  wire.dataset.wire = kind;
  for (const button of wire.querySelectorAll<HTMLButtonElement>(".wire-option")) {
    button.classList.toggle("selected", button.dataset.wire === kind);
  }
  updateHint();
}

/** Switches between Chat Completions and Responses for the OpenAI family. */
function setShape(shape: Shape): void {
  draft.shape = shape;
  const row = $("#shape");
  row.dataset.shape = shape;
  for (const button of row.querySelectorAll<HTMLButtonElement>(".shape-option")) {
    button.classList.toggle("selected", button.dataset.shape === shape);
  }
  updateHint();
}

function setTheme(theme: Theme): void {
  draft.theme = theme;
  applyTheme(theme);
  for (const button of document.querySelectorAll<HTMLButtonElement>(".theme-option")) {
    button.classList.toggle("selected", button.dataset.theme === theme);
  }
}

function renderModels(list: ModelEntry[]): void {
  const root = $("#model-list");
  const current = $<HTMLInputElement>("#model-id").value;
  root.replaceChildren(
    ...list.map((entry, index) => {
      const item = document.createElement("li");
      item.style.setProperty("--i", String(index));
      const button = document.createElement("button");
      button.type = "button";
      button.className = entry.id === current ? "model-item selected" : "model-item";
      button.textContent = entry.label === entry.id ? entry.id : `${entry.label}`;
      button.title = entry.id;
      button.addEventListener("click", () => {
        $<HTMLInputElement>("#model-id").value = entry.id;
        for (const other of root.querySelectorAll(".model-item")) {
          other.classList.toggle("selected", other === button);
        }
      });
      item.append(button);
      return item;
    }),
  );
}

async function loadModels(): Promise<void> {
  const button = $<HTMLButtonElement>("#fetch-models");
  const status = $("#model-status");
  button.disabled = true;
  status.dataset.state = "busy";
  status.textContent = "正在获取…";
  try {
    const list = await listModels(
      draft.kind === "anthropic" ? "anthropic" : "openai",
      $<HTMLInputElement>("#base-url").value,
      $<HTMLInputElement>("#api-key").value,
    );
    renderModels(list);
    status.dataset.state = "ok";
    status.textContent = list.length ? `${list.length} 个模型` : "接口没有返回模型";
  } catch (error) {
    status.dataset.state = "error";
    status.textContent = `获取失败：${String(error)}`;
  } finally {
    button.disabled = false;
  }
}

/** Wires the settings dialog once; safe to call after the page loads. */
export function initSettings(): void {
  if (bound) return;
  bound = true;

  for (const button of document.querySelectorAll<HTMLButtonElement>(".nav-item")) {
    button.addEventListener("click", () => showPane(button.dataset.pane as Pane));
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(".wire-option")) {
    button.addEventListener("click", () => setWire(button.dataset.wire === "anthropic" ? "anthropic" : "openai"));
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(".shape-option")) {
    button.addEventListener("click", () =>
      setShape(button.dataset.shape === "responses" ? "responses" : "chat"),
    );
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(".theme-option")) {
    const theme = button.dataset.theme;
    button.addEventListener("click", () => {
      if (theme === "light" || theme === "dark" || theme === "system") setTheme(theme);
    });
  }

  $("#fetch-models").addEventListener("click", () => void loadModels());

  $("#reset-prompt").addEventListener("click", () => {
    $<HTMLTextAreaElement>("#prompt").value = "";
    $<HTMLTextAreaElement>("#prompt").placeholder = DEFAULT_PROMPT;
  });

  $("#close-settings").addEventListener("click", () => $<HTMLDialogElement>("#settings").close());

  $("#save-settings").addEventListener("click", () => {
    void (async () => {
      await Settings.save({
        kind: draft.kind,
        shape: draft.shape === "responses" ? "responses" : "chat",
        baseUrl: $<HTMLInputElement>("#base-url").value.trim(),
        model: $<HTMLInputElement>("#model-id").value.trim(),
        apiKey: $<HTMLInputElement>("#api-key").value.trim(),
        theme: draft.theme,
        prompt: $<HTMLTextAreaElement>("#prompt").value.trim(),
      });
      $<HTMLDialogElement>("#settings").close();
      location.reload();
    })();
  });
}

/** Fills the dialog from the saved configuration and opens it. */
export async function openSettings(): Promise<void> {
  const config = await Settings.load();
  draft = { ...config };

  applyTheme(config.theme ?? "system");
  for (const button of document.querySelectorAll<HTMLButtonElement>(".theme-option")) {
    button.classList.toggle("selected", button.dataset.theme === (config.theme ?? "system"));
  }
  setWire(config.kind === "anthropic" ? "anthropic" : "openai");
  setShape(config.shape === "responses" ? "responses" : "chat");
  $<HTMLInputElement>("#base-url").value = config.baseUrl ?? "";
  $<HTMLInputElement>("#model-id").value = config.model ?? "";
  $<HTMLInputElement>("#api-key").value = config.apiKey ?? "";
  const prompt = $<HTMLTextAreaElement>("#prompt");
  prompt.value = config.prompt ?? "";
  prompt.placeholder = DEFAULT_PROMPT;
  $("#model-list").replaceChildren();
  $("#model-status").textContent = "";

  showPane("model");
  $<HTMLDialogElement>("#settings").showModal();
}

export { applyTheme, DEFAULT_PROMPT };
