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
import { fetch as goFetch } from "@mygo-plugins/fetch";

import { Settings } from "./mygo";

export type Wire = "openai" | "anthropic";

export interface Endpoint {
  kind: Wire;
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

export function normalize(config: {
  kind: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}): Endpoint {
  return {
    kind: config.kind === "anthropic" ? "anthropic" : "openai",
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ""),
    model: config.model.trim(),
    apiKey: (config.apiKey ?? "").trim(),
  };
}

/** Builds the model descriptor pi-ai needs for a user-supplied endpoint. */
function modelFor(endpoint: Endpoint): Model<Api> {
  const api: Api = endpoint.kind === "anthropic" ? "anthropic-messages" : "openai-completions";
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
  const systemPrompt = (config.prompt ?? "").trim() || SYSTEM_PROMPT;
  if (!endpoint.baseUrl) throw new Error("还没有填写接口地址");
  if (!endpoint.model) throw new Error("还没有填写模型名");

  // Requests leave from Go, so no CORS and any header is allowed.
  const streams = endpoint.kind === "anthropic" ? anthropicMessagesApi() : openAICompletionsApi();
  const provider = createProvider({
    id: "custom",
    name: "AppleCos endpoint",
    baseUrl: endpoint.baseUrl,
    // The key travels as a per-request option; this resolve only satisfies the contract.
    auth: { apiKey: { name: "API key", resolve: async () => ({ auth: {} }) } },
    models: [modelFor(endpoint)],
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
