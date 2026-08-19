import { BaseProvider, LLMError } from "./types.js";
import type { CancellationToken, ChatOptions } from "./types.js";
import { messageToDict } from "./types.js";
import type { LLMMessage, LLMResult, ToolCall } from "./types.js";

export class OpenAIProvider extends BaseProvider {
  async chat(messages: LLMMessage[], opts: ChatOptions = {}): Promise<LLMResult> {
    try {
      return await this._chatImpl(messages, opts);
    } catch (e) {
      if (e instanceof LLMError) {
        console.error(`LLM 调用失败 model=${this.model} error=${e.message}`);
        throw e;
      }
      throw e;
    }
  }

  private async _chatImpl(messages: LLMMessage[], opts: ChatOptions): Promise<LLMResult> {
    const cancelEvent = opts.cancel_event;
    const payload: Record<string, unknown> = {
      model: opts.model ?? this.model,
      messages: messages.map(messageToDict),
      temperature: opts.temperature ?? this.temperature,
    };
    const tools = opts.tools;
    if (tools?.length) {
      payload["tools"] = tools;
      payload["tool_choice"] = opts.tool_choice ?? "auto";
    }
    if (this.max_tokens) payload["max_tokens"] = this.max_tokens;
    for (const [k, v] of Object.entries(opts)) {
      if (!["tools", "model", "temperature", "tool_choice", "max_tokens", "cancel_event"].includes(k)) {
        payload[k] = v;
      }
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.api_key) headers["Authorization"] = `Bearer ${this.api_key}`;

    let data: Record<string, unknown>;
    try {
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), this.timeout * 1000);
      const fetchPromise = fetch(`${this.base_url}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let resp: Response;
      if (cancelEvent) {
        if (cancelEvent.isSet()) throw new LLMError("请求已取消");
        const result = await Promise.race([fetchPromise, cancelEvent.wait().then(() => "cancelled" as const)]);
        if (result === "cancelled") {
          controller.abort();
          throw new LLMError("请求已取消");
        }
        resp = result;
      } else {
        resp = await fetchPromise;
      }
      clearTimeout(timeoutTimer);
      if (!resp.ok) {
        const text = (await resp.text()).slice(0, 500);
        throw new LLMError(`LLM 请求失败 HTTP ${resp.status}: ${text}`);
      }
      data = (await resp.json()) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof LLMError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        throw new LLMError(cancelEvent?.isSet() ? "请求已取消" : `LLM 请求超时(${this.timeout}s)`);
      }
      throw new LLMError(`LLM 网络错误: ${e instanceof Error ? e.message : String(e)}`);
    }

    const choices = data["choices"] as Array<Record<string, unknown>> | undefined;
    if (!choices?.length) {
      throw new LLMError(`LLM 响应缺失 choices: ${JSON.stringify(data).slice(0, 300)}`);
    }
    const msg = (choices[0]["message"] ?? {}) as Record<string, unknown>;
    const content = msg["content"] as string | null;
    let toolCalls: ToolCall[] | null = null;
    const rawCalls = (msg["tool_calls"] ?? []) as Array<Record<string, unknown>>;
    if (rawCalls.length) {
      toolCalls = rawCalls.map((tc) => {
        const fn = (tc["function"] ?? {}) as Record<string, unknown>;
        let arguments_ = {};
        try {
          arguments_ = JSON.parse(String(fn["arguments"] ?? "{}"));
        } catch {
          arguments_ = {};
        }
        return { id: String(tc["id"] ?? ""), name: String(fn["name"] ?? ""), arguments: arguments_ };
      });
    }

    if (this.usage_hook && data["usage"]) {
      try {
        this.usage_hook(this.model, data["usage"] as Record<string, number>);
      } catch {
        console.error(`usage_hook 异常 model=${this.model}`);
      }
    }
    return {
      content,
      tool_calls: toolCalls,
      usage: (data["usage"] as Record<string, number>) ?? null,
      reasoning: (msg["reasoning_content"] as string) || null,
    };
  }
}

export function buildToolCalls(raw: Array<{ id?: string; name?: string; arguments?: string }>): ToolCall[] {
  return raw.map((tc) => {
    let args = {};
    try {
      args = JSON.parse(tc.arguments ?? "{}");
    } catch {
      args = {};
    }
    return { id: tc.id ?? "", name: tc.name ?? "", arguments: args };
  });
}
