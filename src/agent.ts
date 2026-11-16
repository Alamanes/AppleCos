import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createModels,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fetch as goFetch } from "@mygo-plugins/fetch";

import { Settings } from "./mygo";

const SYSTEM_PROMPT = [
  "你是 AppleCos 的角色扮演引擎，运行在用户的 Mac 上。",
  "用简体中文回答，保持角色设定，不要解释你自己的实现细节。",
].join("\n");

export interface AgentHandle {
  agent: Agent;
  provider: string;
  model: Model<never>;
}

function pickModel(provider: string, id: string): Model<never> {
  const models = createModels();
  models.setProvider(deepseekProvider());
  const model = models.getModel(provider, id) ?? models.getModels(provider)[0];
  if (!model) {
    throw new Error(`模型不存在：${provider}/${id}`);
  }
  return model as Model<never>;
}

/** Creates the Pi agent backed by the Go side's fetch, so requests leave the app. */
export async function createAgent(): Promise<AgentHandle> {
  const config = await Settings.load();
  const provider = config.provider || "deepseek";
  const model = pickModel(provider, config.model || "deepseek-flash");

  const models = createModels();
  models.setProvider(deepseekProvider());

  const streamFn: StreamFn = (requestModel, context, options) =>
    models.streamSimple(requestModel, context, {
      ...options,
      apiKey: config.apiKey,
      fetch: goFetch as unknown as NonNullable<SimpleStreamOptions["fetch"]>,
    });

  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model },
    streamFn,
  });

  return { agent, provider, model };
}
