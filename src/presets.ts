import type { Wire } from "./agent";

export interface Preset {
  id: string;
  label: string;
  /** Wire protocol the endpoint speaks. */
  kind: Wire;
  baseUrl: string;
  model: string;
  hint: string;
}

/**
 * Endpoints people reach for first. The two custom entries leave the address
 * blank so any OpenAI- or Anthropic-compatible service can be typed in.
 */
export const PRESETS: Preset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    hint: "OpenAI 兼容",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    hint: "OpenAI 官方",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    hint: "Anthropic 官方",
  },
  {
    id: "openai-compatible",
    label: "OpenAI 兼容",
    kind: "openai",
    baseUrl: "",
    model: "",
    hint: "任何 /v1/chat/completions 服务",
  },
  {
    id: "anthropic-compatible",
    label: "Anthropic 兼容",
    kind: "anthropic",
    baseUrl: "",
    model: "",
    hint: "任何 /v1/messages 服务",
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

export function guessPreset(kind: string, baseUrl: string): string {
  const match = PRESETS.find(
    (preset) => preset.baseUrl !== "" && preset.baseUrl === baseUrl && preset.kind === kind,
  );
  return match?.id ?? (kind === "anthropic" ? "anthropic-compatible" : "openai-compatible");
}
