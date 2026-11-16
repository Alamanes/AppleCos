import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { fetch as goFetch } from "@mygo-plugins/fetch";

import { Settings } from "./mygo";

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
}

const SYSTEM_PROMPT = [
  "你是 AppleCos 的角色扮演引擎，运行在用户自己的 Mac 上。",
  "用简体中文回答，保持角色设定与沉浸感，不要解释你自己的实现细节。",
].join("\n");

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
  const route = detectRoute(config.baseUrl);
  const kind: Wire = route ? route.kind : config.kind === "anthropic" ? "anthropic" : "openai";
  const typed = config.baseUrl.trim().replace(/\/+$/, "");
  return {
    kind,
    shape: route ? route.shape : config.shape === "responses" ? "responses" : "chat",
    // An empty address falls back to the protocol's own endpoint.
    baseUrl: route ? route.baseUrl : typed || defaultBaseUrl(kind),
    model: config.model.trim(),
    apiKey: (config.apiKey ?? "").trim(),
  };
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

/** Builds the model descriptor pi-ai needs for a user-supplied endpoint. */
function modelFor(endpoint: Endpoint, api: Api): Model<Api> {
  const model = {
    id: endpoint.model,
    name: endpoint.model,
    api,
    provider: "custom",
    baseUrl: endpoint.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: zeroCost,
    contextWindow: 128000,
    maxTokens: 8192,
  };
  return model as unknown as Model<Api>;
}

/** Creates the Pi agent for any OpenAI- or Anthropic-compatible endpoint. */
export async function createAgent(): Promise<AgentHandle> {
  const config = await Settings.load();
  const endpoint = normalize(config);
  if (!endpoint.baseUrl) throw new Error("还没有填写接口地址");
  if (!endpoint.model) throw new Error("还没有填写模型名");
  const systemPrompt = (config.prompt ?? "").trim() || SYSTEM_PROMPT;

  // Requests leave from Go, so no CORS and any header is allowed.
  const { id: apiId, streams } = apiFor(endpoint);
  const provider = createProvider({
    id: "custom",
    name: "AppleCos endpoint",
    baseUrl: endpoint.baseUrl,
    // The key travels as a per-request option; this resolve only satisfies the contract.
    auth: { apiKey: { name: "API key", resolve: async () => ({ auth: {} }) } },
    models: [modelFor(endpoint, apiId)],
    api: streams,
  });

  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("custom", endpoint.model);
  if (!model) throw new Error(`找不到模型：${endpoint.model}`);

  const streamFn: StreamFn = (requestModel, context, options) =>
    models.streamSimple(requestModel, context, {
      ...options,
      apiKey: endpoint.apiKey,
      fetch: goFetch as unknown as NonNullable<SimpleStreamOptions["fetch"]>,
    });

  const agent = new Agent({
    initialState: { systemPrompt, model },
    streamFn,
  });

  return { agent, endpoint };
}
