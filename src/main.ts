import { createAgent, type AgentHandle } from "./agent";
import { Settings } from "./mygo";
import { ChatView, messageText } from "./ui";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const view = new ChatView($("#chat"));
const form = $<HTMLFormElement>("#composer");
const input = $<HTMLTextAreaElement>("#input");
const sendButton = $<HTMLButtonElement>("#send");
const stopButton = $<HTMLButtonElement>("#stop");
const statusElement = $<HTMLElement>("#status");
const modelElement = $<HTMLElement>("#model");
const dialog = $<HTMLDialogElement>("#settings");
const keyInput = $<HTMLInputElement>("#api-key");
const modelInput = $<HTMLInputElement>("#model-id");

let handle: AgentHandle | null = null;
let running = false;

function setRunning(next: boolean): void {
  running = next;
  sendButton.disabled = next;
  stopButton.disabled = !next;
  statusElement.textContent = next ? "生成中" : "空闲";
}

function bindAgent(agent: AgentHandle["agent"]): void {
  agent.subscribe((event) => {
    const anyEvent = event as unknown as Record<string, any>;
    switch (anyEvent.type) {
      case "message_start":
        if (anyEvent.message?.role === "assistant") view.startAssistant();
        break;
      case "message_update": {
        const inner = anyEvent.assistantMessageEvent;
        if (inner?.type === "text_delta") view.delta(inner.delta);
        break;
      }
      case "message_end": {
        const message = anyEvent.message;
        if (message?.role === "assistant") {
          view.finishAssistant(messageText(message));
          if (message.stopReason === "error") view.error(message.errorMessage ?? "模型返回错误");
        }
        break;
      }
      case "tool_execution_start":
        view.tool(String(anyEvent.toolName), "开始");
        break;
      case "tool_execution_end":
        view.tool(String(anyEvent.toolName), "完成");
        break;
      case "agent_end":
        setRunning(false);
        break;
    }
  });
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text || !handle || running) return;
  input.value = "";
  view.user(text);
  setRunning(true);
  try {
    await handle.agent.prompt(text);
  } catch (error) {
    view.error(`发送失败：${String(error)}`);
  } finally {
    setRunning(false);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void send();
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
});

stopButton.addEventListener("click", () => {
  handle?.agent.abort();
});

$("#open-settings").addEventListener("click", () => {
  dialog.showModal();
});

$("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    await Settings.save({
      provider: "deepseek",
      model: modelInput.value.trim() || "deepseek-flash",
      apiKey: keyInput.value.trim(),
    });
    dialog.close();
    location.reload();
  })();
});

async function boot(): Promise<void> {
  setRunning(false);
  try {
    const config = await Settings.load();
    keyInput.value = config.apiKey ?? "";
    modelInput.value = config.model;
    handle = await createAgent();
    modelElement.textContent = `${handle.provider} / ${handle.model.id}`;
    bindAgent(handle.agent);
    input.focus();
    if (!config.apiKey) {
      view.error("还没有保存 API Key。点右上角「设置」填入 DeepSeek 的 Key。");
      dialog.showModal();
    }
  } catch (error) {
    view.error(`启动失败：${String(error)}`);
  }
}

void boot();
