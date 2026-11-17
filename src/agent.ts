import {
  Agent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { fetch as goFetch } from "@mygo-plugins/fetch";

import type { Config } from "./mygo";

/** Wire family: Anthropic messages, or one of the two OpenAI APIs. */
export type Wire = "openai" | "anthropic";
/** OpenAI API family: Chat Completions or Responses. */
export type Shape = "chat" | "responses";

export interface Endpoint {
  kind: Wire;
  shape: Shape;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AgentHandle {
  agent: Agent;
  endpoint: Endpoint;
  model: Model<Api>;
}

/** Everything the page hands to a new agent; nothing is re-read from disk. */
export interface AgentInput {
  config: Config;
  /** Seed transcript. The world engine replaces the system message per request. */
  messages?: AgentMessage[];
  tools?: AgentTool<any>[];
  /** Leading system prompt; the world engine overwrites it each turn. */
  systemPrompt?: string;
  transformContext?: AgentOptions["transformContext"];
  beforeToolCall?: AgentOptions["beforeToolCall"];
  /** Runs after each tool call; can end the turn with terminate. */
  afterToolCall?: AgentOptions["afterToolCall"];
  /** Reply cap; derived from the model's context window when omitted. */
  maxTokens?: number;
}

/** Zero cost keeps the transcript view free of made-up prices for custom endpoints. */
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface Route {
  kind: Wire;
  shape: Shape;
  baseUrl: string;
}

const ROUTE_RULES: { pattern: RegExp; kind: Wire; shape: Shape }[] = [
  { pattern: /\/chat\/completions$/i, kind: "openai", shape: "chat" },
  { pattern: /\/responses$/i, kind: "openai", shape: "responses" },
  { pattern: /\/messages$/i, kind: "anthropic", shape: "chat" },
];

/**
 * Recognizes a pasted full endpoint URL and reduces it to the base URL the
 * provider needs. Anthropic drops the trailing /v1 because its SDK adds it.
 */
export function detectRoute(raw: string): Route | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  for (const rule of ROUTE_RULES) {
    if (!rule.pattern.test(trimmed)) continue;
    let baseUrl = trimmed.replace(rule.pattern, "");
    if (rule.kind === "anthropic") baseUrl = baseUrl.replace(/\/v1$/i, "");
    return { kind: rule.kind, shape: rule.shape, baseUrl };
  }
  return null;
}

/** Address used when the user leaves the field empty. */
export function defaultBaseUrl(kind: Wire): string {
  return kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
}

export function normalize(config: {
  kind: string;
  shape?: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}): Endpoint {
  const declared: Wire | null =
    config.kind === "anthropic" ? "anthropic" : config.kind === "openai" ? "openai" : null;
  const route = detectRoute(config.baseUrl);
  const typed = config.baseUrl.trim().replace(/\/+$/, "");
  // A configured wire wins over the suffix guess, so a gateway whose calls live
  // under /messages is not silently treated as Anthropic. The guess is only a
  // fallback for callers that carry no explicit protocol.
  const kind: Wire = declared ?? route?.kind ?? "openai";
  const matched = route !== null && route.kind === kind;
  if (route && !matched) {
    console.warn(
      "[agent] 地址看起来像 " + route.kind + " 端点，但协议设为 " + kind + "；按设置里的协议发送。",
    );
  }
  const shape: Shape =
    kind === "anthropic"
      ? "chat"
      : matched && route
        ? route.shape
        : config.shape === "responses"
          ? "responses"
          : "chat";
  return {
    kind,
    shape,
    // An empty address falls back to the protocol's own endpoint.
    baseUrl: matched && route ? route.baseUrl : typed || defaultBaseUrl(kind),
    model: config.model.trim(),
    apiKey: (config.apiKey ?? "").trim(),
  };
}

/** Keeps a numeric budget inside a sane range. */
function clamp(value: number, low: number, high: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(high, Math.max(low, value));
}

/** Which pi-ai implementation answers this endpoint. */
function apiFor(endpoint: Endpoint): { id: Api; streams: ReturnType<typeof openAICompletionsApi> } {
  if (endpoint.kind === "anthropic") {
    return { id: "anthropic-messages", streams: anthropicMessagesApi() };
  }
  if (endpoint.shape === "responses") {
    return { id: "openai-responses", streams: openAIResponsesApi() };
  }
  return { id: "openai-completions", streams: openAICompletionsApi() };
}

/** Thinking budget as the config stores it; "off" asks for no reasoning at all. */
export type ReasoningLevel = "off" | "low" | "medium" | "high";

/** Reads Config.reasoning, treating anything unrecognized as "off". */
export function reasoningLevel(config: { reasoning?: string }): ReasoningLevel {
  switch (config.reasoning) {
    case "low":
    case "medium":
    case "high":
      return config.reasoning;
    default:
      return "off";
  }
}

/** Level pi-ai accepts; its union has no "off", an omitted field means no reasoning. */
function wireReasoning(level: ReasoningLevel): ThinkingLevel | undefined {
  return level === "off" ? undefined : level;
}

/**
 * Effort names a custom endpoint receives. pi-ai sends each mapped value as the
 * endpoint's native effort string: reasoning_effort on the OpenAI-compatible
 * wires, effort on Anthropic. "off" and "minimal" are null so a disabled
 * request sends no effort value instead of guessing one. Medium maps to the
 * middle tier; an endpoint whose model only exposes low/high gets the nearest
 * lower tier, so point that entry at "low" for such a server.
 */
const thinkingMap: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
};

/** Builds the model descriptor pi-ai needs for a user-supplied endpoint. */
function modelFor(
  endpoint: Endpoint,
  api: Api,
  contextWindow: number,
  maxTokens: number,
  level: ReasoningLevel,
): Model<Api> {
  const model = {
    id: endpoint.model,
    name: endpoint.model,
    api,
    provider: "custom",
    baseUrl: endpoint.baseUrl,
    // A disabled level turns off the whole reasoning path on the wire.
    reasoning: level !== "off",
    thinkingLevelMap: thinkingMap,
    input: ["text"],
    cost: zeroCost,
    // Cache lifetime in seconds per retention tier: 5 minutes ephemeral, 1 hour
    // extended. pi only reads this for its cache-warming policy; whether the
    // endpoint really caches is up to the server.
    promptCache: { short: 300, long: 3600 },
    contextWindow,
    maxTokens,
  };
  return model as unknown as Model<Api>;
}

/** Creates the Pi agent for any OpenAI- or Anthropic-compatible endpoint. */
export async function createAgent(input: AgentInput): Promise<AgentHandle> {
  const endpoint = normalize(input.config);
  if (!endpoint.baseUrl) throw new Error("还没有填写接口地址");
  if (!endpoint.model) throw new Error("还没有填写模型名");

  const level = reasoningLevel(input.config);
  const contextWindow = clamp(input.config.contextWindow, 2048, 2_000_000, 32_000);
  const maxTokens = clamp(
    input.maxTokens ?? Math.floor(contextWindow / 3),
    512,
    Math.min(8192, contextWindow),
    4096,
  );

  // Requests leave from Go, so no CORS and any header is allowed.
  const { id: apiId, streams } = apiFor(endpoint);
  const provider = createProvider({
    id: "custom",
    name: "AppleCos endpoint",
    baseUrl: endpoint.baseUrl,
    // The key travels as a per-request option; this resolve only satisfies the contract.
    auth: { apiKey: { name: "API key", resolve: async () => ({ auth: {} }) } },
    models: [modelFor(endpoint, apiId, contextWindow, maxTokens, level)],
    api: streams,
  });

  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("custom", endpoint.model);
  if (!model) throw new Error(`找不到模型：${endpoint.model}`);

  const streamFn: StreamFn = (requestModel, context, options) =>
    models.streamSimple(requestModel, context, {
      ...options,
      // streamSimple takes the pi level directly; "off" stays undefined.
      reasoning: wireReasoning(level),
      maxTokens,
      // Ask for prompt caching. pi writes Anthropic-style cache_control on the
      // anthropic-messages wire, and adds a prompt_cache_key only for
      // api.openai.com; other OpenAI-compatible servers cache the byte-identical
      // prefix on their own, so the stable prefix does the work there.
      cacheRetention: "short",
      apiKey: endpoint.apiKey,
      fetch: goFetch as unknown as NonNullable<SimpleStreamOptions["fetch"]>,
    });

  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt ?? "",
      messages: input.messages ?? [],
      model,
      // The agent loop forwards this level to every request as its reasoning.
      thinkingLevel: level,
      tools: input.tools ?? [],
    },
    streamFn,
    transformContext: input.transformContext,
    beforeToolCall: input.beforeToolCall,
    afterToolCall: input.afterToolCall,
  });

  return { agent, endpoint, model };
}
