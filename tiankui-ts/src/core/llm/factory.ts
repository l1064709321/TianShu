import { OpenAIProvider } from "./openai.js";
import type { BaseProvider } from "./types.js";

const _PROVIDER_TYPES = new Map<string, new (baseUrl: string, apiKey: string, model: string, temperature?: number, timeout?: number, maxTokens?: number | null) => BaseProvider>();

export interface ProviderOptions {
  base_url: string;
  api_key?: string;
  model?: string;
  temperature?: number;
  timeout?: number;
  max_tokens?: number | null;
}

for (const name of [
  "openai", "ollama", "deepseek", "qwen", "moonshot", "zhipu", "kimi", "minimax",
  "groq", "openrouter", "together", "siliconflow", "fireworks", "mistral",
  "lingyiwanwu", "stepfun", "baichuan", "volcengine", "hunyuan", "nvidia",
  "perplexity", "cohere", "together_ai", "oneapi", "newapi", "litellm",
  "vllm", "sglang", "lmstudio", "custom", "local",
]) {
  _PROVIDER_TYPES.set(name, OpenAIProvider as unknown as new (b: string, k: string, m: string, t?: number, to?: number, mt?: number | null) => BaseProvider);
}

type ProviderCtor = new (baseUrl: string, apiKey: string, model: string, temperature?: number, timeout?: number, maxTokens?: number | null) => BaseProvider;

export function registerProvider(name: string, cls: ProviderCtor): void {
  _PROVIDER_TYPES.set(name, cls);
}

export function createProvider(
  name: string,
  base_url: string,
  model: string,
  api_key = "",
  opts: Partial<ProviderOptions> = {},
): BaseProvider {
  let cls = _PROVIDER_TYPES.get(name);
  if (!cls) {
    cls = OpenAIProvider as unknown as new (b: string, k: string, m: string, t?: number, to?: number, mt?: number | null) => BaseProvider;
    _PROVIDER_TYPES.set(name, cls);
  }
  return new cls(base_url, api_key ?? "", model, opts.temperature ?? 0.2, opts.timeout ?? 120.0, opts.max_tokens ?? null);
}

export function availableProviders(): string[] {
  return [..._PROVIDER_TYPES.keys()].sort();
}
