export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMMessage {
  role: Role;
  content: string;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string | null;
}

export function messageToDict(m: LLMMessage): Record<string, unknown> {
  if (m.tool_calls?.length) {
    return {
      role: m.role,
      content: m.content || null,
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  if (m.tool_call_id) {
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  }
  return { role: m.role, content: m.content };
}

export interface LLMResult {
  content: string | null;
  tool_calls?: ToolCall[] | null;
  usage?: Record<string, number> | null;
  reasoning?: string | null;
}

export const hasToolCalls = (r: LLMResult): boolean => Boolean(r.tool_calls?.length);

export class LLMError extends Error {}

export class CancellationToken {
  private _set = false;
  private _waiters: Array<() => void> = [];

  isSet(): boolean {
    return this._set;
  }

  set(): void {
    this._set = true;
    for (const w of this._waiters) w();
    this._waiters = [];
  }

  clear(): void {
    this._set = false;
  }

  wait(): Promise<void> {
    if (this._set) return Promise.resolve();
    return new Promise((resolve) => this._waiters.push(resolve));
  }
}

export type UsageHook = (model: string, usage: Record<string, number>) => void;

export interface ChatOptions {
  tools?: Array<Record<string, unknown>> | null;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  cancel_event?: CancellationToken;
  [key: string]: unknown;
}

export abstract class BaseProvider {
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  timeout: number;
  max_tokens: number | null;
  usage_hook: UsageHook | null = null;

  constructor(
    base_url: string,
    api_key = "",
    model = "",
    temperature = 0.2,
    timeout = 120.0,
    max_tokens: number | null = null,
  ) {
    this.base_url = base_url.replace(/\/+$/, "");
    this.api_key = api_key;
    this.model = model;
    this.temperature = temperature;
    this.timeout = timeout;
    this.max_tokens = max_tokens;
  }

  abstract chat(messages: LLMMessage[], opts?: ChatOptions): Promise<LLMResult>;

  async close(): Promise<void> {}
}
