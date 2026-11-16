import { createAgent, normalize, type AgentHandle } from "./agent";
import { Settings } from "./mygo";
import { applyTheme, initSettings, openSettings } from "./settings";
import { ChatView, messageText } from "./ui";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const view = new ChatView($("#chat"));
const form = $<HTMLFormElement>("#composer");
const input = $<HTMLTextAreaElement>("#input");
const sendButton = $<HTMLButtonElement>("#send");
const stopButton = $<HTMLButtonElement>("#stop");
const statusElement = $<HTMLElement>("#status");
const endpointElement = $<HTMLElement>("#endpoint");

let handle: AgentHandle | null = null;
let running = false;

function setRunning(next: boolean): void {
  running = next;
  sendButton.disabled = next;
  stopButton.disabled = !next;
  statusElement.dataset.state = next ? "busy" : "idle";
  statusElement.textContent = next ? "演出中" : "待机";
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
        view.say("notice", `工具 ${String(anyEvent.toolName)} 开始`);
        break;
      case "tool_execution_end":
        view.say("notice", `工具 ${String(anyEvent.toolName)} 完成`);
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
  view.say("user", text);
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

$("#open-settings").addEventListener("click", () => void openSettings());

async function boot(): Promise<void> {
  setRunning(false);
  initSettings();

  const config = await Settings.load();
  applyTheme(config.theme ?? "system");

  const endpoint = normalize(config);
  const configured = endpoint.model !== "";
  endpointElement.textContent = configured ? endpoint.model : "未设置模型";

  if (!configured) {
    void openSettings();
    return;
  }

  try {
    handle = await createAgent();
    bindAgent(handle.agent);
    input.focus();
  } catch (error) {
    view.error(`启动失败：${String(error)}`);
  }
}

void boot();
