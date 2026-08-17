import { CancellationToken } from "../llm/types.js";
import type { LLMMessage, ToolCall } from "../llm/types.js";
import { createProvider } from "../llm/factory.js";
import { gateTool } from "../review/system.js";
import type { ReviewSystem } from "../review/system.js";
import { Tool, ToolRegistry } from "../tools/registry.js";

export interface ToolResult {
  name: string;
  output: string;
  error: string | null;
}

export interface AgentResult {
  content: string;
  tool_calls: ToolResult[];
  child_agents: string[];
  error: string | null;
}

export type EventSink = (agent: string, event: string, data: Record<string, unknown>) => Promise<void>;

export class MessageBus {
  private _agents = new Map<string, Agent>();

  register(agent: Agent): void {
    this._agents.set(agent.name, agent);
  }

  unregister(name: string): void {
    this._agents.delete(name);
  }

  names(): string[] {
    return [...this._agents.keys()];
  }

  agent(name: string): Agent | null {
    return this._agents.get(name) ?? null;
  }

  async send(to: string, message: string, sender = ""): Promise<AgentResult> {
    const agent = this._agents.get(to);
    if (!agent) throw new Error(`目标 Agent 不存在: ${to}`);
    return agent.handleMessage(message, sender);
  }
}

export interface AgentOptions {
  name: string;
  system_prompt: string;
  provider_name: string;
  model?: string;
  base_url?: string;
  api_key?: string;
  registry?: ToolRegistry;
  bus?: MessageBus;
  review?: ReviewSystem | null;
  temperature?: number;
  max_tokens?: number | null;
  max_iterations?: number;
  debug?: boolean;
  event_sink?: EventSink | null;
  cancelled?: CancellationToken | null;
}

export class Agent {
  name: string;
  system_prompt: string;
  registry: ToolRegistry;
  bus: MessageBus;
  review: ReviewSystem | null;
  provider: ReturnType<typeof createProvider>;
  max_iterations: number;
  messages: LLMMessage[] = [];
  debug: boolean;
  event_sink: EventSink | null;
  cancelled: CancellationToken;

  constructor(opts: AgentOptions) {
    this.name = opts.name;
    this.system_prompt = opts.system_prompt;
    this.registry = opts.registry ?? new ToolRegistry();
    this.bus = opts.bus ?? new MessageBus();
    this.review = opts.review ?? null;
    this.provider = createProvider(opts.provider_name, opts.base_url ?? "", opts.model ?? "", opts.api_key ?? "", {
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.max_tokens ?? null,
    });
    this.max_iterations = opts.max_iterations ?? 10;
    this.debug = opts.debug ?? false;
    this.event_sink = opts.event_sink ?? null;
    this.cancelled = opts.cancelled ?? new CancellationToken();
  }

  async handleMessage(message: string, sender = ""): Promise<AgentResult> {
    const history: LLMMessage[] = [{ role: "system", content: this.system_prompt }];
    history.push(...this.messages);
    history.push({ role: "user", content: `(来自 ${sender || "上级"} 的任务)\n${message}` });
    try {
      return await this._runLoop(history);
    } catch (e) {
      console.error(`Agent ${this.name} 运行异常`, e);
      return { content: "", tool_calls: [], child_agents: [], error: String(e) };
    }
  }

  private async _runLoop(history: LLMMessage[]): Promise<AgentResult> {
    const toolResults: ToolResult[] = [];
    const children: string[] = [];
    const tools = this.registry.schemas();
    const seenCalls = new Set<string>();

    for (let i = 0; i < this.max_iterations; i++) {
      const result = await this.provider.chat(history, { tools, cancel_event: this.cancelled });
      if (result.reasoning) {
        await this._emit("thinking", { agent: this.name, content: result.reasoning });
      }
      history.push({ role: "assistant", content: result.content ?? "", tool_calls: result.tool_calls });

      if (!result.tool_calls?.length) {
        this.messages = history.slice(1);
        return { content: result.content ?? "", tool_calls: toolResults, child_agents: children, error: null };
      }

      if (this.cancelled.isSet()) {
        return { content: "(任务已取消)", tool_calls: toolResults, child_agents: children, error: null };
      }

      for (const tc of result.tool_calls) {
        if (this.cancelled.isSet()) {
          return { content: "(任务已取消)", tool_calls: toolResults, child_agents: children, error: null };
        }
        const callKey = `${tc.name}:${JSON.stringify(Object.entries(tc.arguments).sort())}`;
        if (seenCalls.has(callKey)) {
          const output = `错误: 工具 ${tc.name} 与之前的调用参数完全相同,疑似死循环,已拦截(重复调用:${tc.name})`;
          toolResults.push({ name: tc.name, output: "", error: output });
          history.push({ role: "tool", tool_call_id: tc.id, content: output });
          continue;
        }
        seenCalls.add(callKey);
        let output: string;
        if (tc.name === "call_agent") {
          const childName = String(tc.arguments.agent ?? "");
          await this._emit("agent_action", { agent: this.name, action: "call_agent", target: childName });
          const child = await this._dispatchChild(tc);
          children.push(childName);
          output = child.content || "(无输出)";
          if (child.error) output = `错误: ${child.error}`;
        } else {
          await this._emit("agent_action", { agent: this.name, action: "tool", tool: tc.name, args: tc.arguments });
          const { output: out, err } = await this._execTool(tc);
          toolResults.push({ name: tc.name, output: out ?? "", error: err });
          output = err ? `错误: ${err}` : (out ?? "");
        }
        history.push({ role: "tool", tool_call_id: tc.id, content: String(output).slice(0, 12000) });
      }
    }

    this.messages = history.slice(1);
    return { content: "(达到最大迭代次数)", tool_calls: toolResults, child_agents: children, error: null };
  }

  private async _emit(event: string, data: Record<string, unknown>): Promise<void> {
    if (!this.event_sink) return;
    try {
      await this.event_sink(this.name, event, data);
    } catch {
      console.error(`event_sink 异常 agent=${this.name} event=${event}`);
    }
  }

  private async _dispatchChild(tc: ToolCall): Promise<AgentResult> {
    const name = String(tc.arguments.agent ?? "");
    const task = String(tc.arguments.task ?? "");
    return this.bus.send(name, task, this.name);
  }

  private async _execTool(tc: ToolCall): Promise<{ output: string; err: string | null }> {
    const tool = this.registry.get(tc.name);
    if (!tool) return { output: "", err: `工具不存在: ${tc.name}` };
    try {
      if (tool.requires_review) {
        if (!this.review) return { output: "", err: `工具 ${tc.name} 需要审核但未配置审核系统` };
        await gateTool(this.review, this.name, tool, tc.arguments);
      }
      const out = await tool.func(tc.arguments);
      if (typeof out === "string") return { output: out, err: null };
      if (tool.format_result === "json") {
        return { output: JSON.stringify(out), err: null };
      }
      return { output: String(out), err: null };
    } catch (e) {
      return { output: "", err: `${(e as Error).constructor.name}: ${(e as Error).message}` };
    }
  }
}

export function buildAgentCallTool(bus: MessageBus): Tool {
  const callAgent = async (args: Record<string, unknown>): Promise<string> => {
    const result = await bus.send(String(args.agent), String(args.task));
    return result.content || "(无输出)";
  };
  return new Tool({
    name: "call_agent",
    description: "调用另一个 Agent 处理子任务,传入目标 Agent 名称和任务描述",
    func: callAgent,
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "目标 Agent 名称" },
        task: { type: "string", description: "分配给目标 Agent 的任务" },
      },
      required: ["agent", "task"],
    },
  });
}
