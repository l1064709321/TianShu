import { LLMError } from "../llm/types.js";
import type { BaseProvider, LLMMessage, LLMResult } from "../llm/types.js";
import { createProvider } from "../llm/factory.js";

export interface PoolKey {
  id: string;
  value: string;
  enabled?: boolean;
  status?: string;
  checked_at?: number;
  label?: string;
}

export function isAuthError(error: string): boolean {
  return (
    error.includes("401") ||
    error.includes("403") ||
    error.toLowerCase().includes("invalid_api_key") ||
    error.toLowerCase().includes("authentication")
  );
}

export function maskKey(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export class KeySelectorProvider implements BaseProvider {
  name: string;
  base_url: string;
  api_key = "";
  model: string;
  temperature: number;
  timeout: number;
  max_tokens: number | null;
  usage_hook: ((model: string, usage: Record<string, number>) => void) | null = null;
  keys: PoolKey[];
  preferred_key: string;
  private _providers = new Map<string, BaseProvider>();
  private _touchKey: ((vendor: string, keyId: string, status: string, error?: string) => void) | null = null;

  constructor(
    name: string,
    baseUrl: string,
    model: string,
    keys: PoolKey[],
    preferredKey = "",
    temperature = 0.2,
    maxTokens: number | null = null,
    timeout = 120.0,
  ) {
    this.name = name;
    this.base_url = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.timeout = timeout;
    this.temperature = temperature;
    this.max_tokens = maxTokens;
    this.keys = keys.filter((k) => k.value && k.enabled !== false);
    this.preferred_key = preferredKey;
  }

  bindStore(touchFn: (vendor: string, keyId: string, status: string, error?: string) => void): void {
    this._touchKey = touchFn;
  }

  private _providerFor(key: PoolKey): BaseProvider {
    let p = this._providers.get(key.id);
    if (!p) {
      p = createProvider(this.name, this.base_url, this.model, key.value, {
        temperature: this.temperature,
        max_tokens: this.max_tokens,
      });
      this._providers.set(key.id, p);
    }
    return p;
  }

  private _rotation(): PoolKey[] {
    const ok = this.keys.filter((k) => [null, undefined, "", "ok", "unknown", "enabled"].includes(k.status));
    const bad = this.keys.filter((k) => !ok.includes(k));
    const okSorted = [...ok].sort((a, b) => {
      const preferA = a.id === this.preferred_key ? 0 : 1;
      const preferB = b.id === this.preferred_key ? 0 : 1;
      if (preferA !== preferB) return preferA - preferB;
      return (a.checked_at ?? 0) - (b.checked_at ?? 0);
    });
    const badSorted = [...bad].sort((a, b) => (a.checked_at ?? 0) - (b.checked_at ?? 0));
    return [...okSorted, ...badSorted];
  }

  async chat(messages: LLMMessage[], opts: { tools?: Array<Record<string, unknown>> } = {}): Promise<LLMResult> {
    if (!this.keys.length) throw new LLMError(`厂商 ${this.name} 没有可用 Key`);
    const rotation = this._rotation();
    let lastError: Error | null = null;
    for (let i = 0; i < rotation.length; i++) {
      const key = rotation[i];
      try {
        const result = await this._providerFor(key).chat(messages, { tools: opts.tools });
        if (this.usage_hook && result.usage) {
          try {
            this.usage_hook(this.model, result.usage);
          } catch {
            console.error(`usage_hook 异常 model=${this.model}`);
          }
        }
        this._touchKey?.(this.name, key.id, "ok");
        return result;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (isAuthError(lastError.message)) {
          console.warn(`Key ${maskKey(key.value)} 无效/过期(${lastError.message}),自动切换下一个...`);
          this._touchKey?.(this.name, key.id, "expired", lastError.message);
          key.status = "expired";
          key.checked_at = Date.now() / 1000;
          if (i < rotation.length - 1) continue;
        }
        throw new LLMError(`厂商 ${this.name} 所有 Key 均失败: ${lastError.message}`);
      }
    }
    throw new LLMError(`厂商 ${this.name} 所有 Key 均失败: ${lastError?.message ?? "未知错误"}`);
  }

  async close(): Promise<void> {}
}

export interface ConnectionResult {
  ok: boolean;
  latency_ms: number;
  model?: string;
  matches?: boolean;
  error?: string;
  code?: number;
}

export async function testConnection(
  baseUrl: string,
  model: string,
  apiKey = "",
  apiStyle = "openai",
  timeout = 30.0,
): Promise<ConnectionResult> {
  const start = Date.now();
  const base = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let url: string;
  if (apiStyle === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    url = `${base}/v1/messages`;
  } else {
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    url = `${base}/chat/completions`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: 4, messages: [{ role: "user", content: "ping" }] }),
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;
    if (resp.status === 200 || resp.status === 201) {
      const data = (await resp.json()) as { model?: string };
      const modelOk = data.model ? String(data.model).toLowerCase() === model.toLowerCase() : false;
      return { ok: true, latency_ms: elapsed, model: data.model ?? model, matches: modelOk };
    }
    if (resp.status === 401) return { ok: false, latency_ms: elapsed, error: "Key 无效或已过期(401)", code: 401 };
    if (resp.status === 403) return { ok: false, latency_ms: elapsed, error: "无权限(403),检查 Key 或配额", code: 403 };
    const body = (await resp.text()).slice(0, 300);
    if ((resp.status === 404 || resp.status === 400) && (body.toLowerCase().includes("model") || body.toLowerCase().includes("not found"))) {
      return { ok: false, latency_ms: elapsed, error: `模型名可能不存在: ${body}`, code: resp.status };
    }
    return { ok: false, latency_ms: elapsed, error: `HTTP ${resp.status}: ${body}`, code: resp.status };
  } catch (e) {
    const elapsed = Date.now() - start;
    return { ok: false, latency_ms: elapsed, error: `网络错误: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshModels(baseUrl: string, apiKey = "", apiStyle = "openai", timeout = 20.0): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let url: string;
  if (apiStyle === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    url = `${base}/v1/models`;
  } else {
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    url = `${base}/models`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { data?: Array<{ id?: string; name?: string }>; models?: Record<string, unknown> };
    const models = new Set<string>();
    for (const m of data.data ?? []) {
      const mid = m.id ?? m.name ?? "";
      if (mid) models.add(mid);
    }
    if (!models.size && data.models) {
      for (const k of Object.keys(data.models)) models.add(k);
    }
    if (models.size) return [...models].sort();
    const fallback = { gpt: "gpt-4o", claude: "claude-sonnet-4-5" };
    const tail = base.split("/").pop() ?? "";
    return [(fallback as Record<string, string>)[tail] ?? "unknown"];
  } finally {
    clearTimeout(timer);
  }
}
