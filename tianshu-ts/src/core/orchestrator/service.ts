import type { Agent, AgentResult, MessageBus } from "../agent/runtime.js";

export interface SubTask {
  id: string;
  worker: string;
  goal: string;
  status: string;
  result: AgentResult | null;
  error: string | null;
}

export interface Orchestration {
  task: string;
  subtasks: SubTask[];
  summary: string;
}

export type EventSinkFn = (agent: string, event: string, data: Record<string, unknown>) => Promise<void>;

export function serializeSubtask(st: SubTask): Record<string, unknown> {
  const d: Record<string, unknown> = { ...st };
  if (d.result !== null && d.result !== undefined) {
    d.result = {
      content: st.result!.content,
      tool_calls: st.result!.tool_calls,
      child_agents: st.result!.child_agents,
      error: st.result!.error,
    };
  }
  return d;
}

class Semaphore {
  private _available: number;
  private _queue: Array<() => void> = [];

  constructor(n: number) {
    this._available = Math.max(1, n);
  }

  async acquire(): Promise<void> {
    if (this._available > 0) {
      this._available--;
      return;
    }
    await new Promise<void>((resolve) => this._queue.push(resolve));
  }

  release(): void {
    const next = this._queue.shift();
    if (next) next();
    else this._available++;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export class Orchestrator {
  main: Agent;
  bus: MessageBus;
  parallel: boolean;
  max_workers: number | null;
  decompose_iterations: number;
  event_sink: EventSinkFn;

  constructor(
    mainAgent: Agent,
    bus: MessageBus | null = null,
    parallel = true,
    maxWorkers: number | null = null,
    decomposeIterations = 3,
    eventSink: EventSinkFn | null = null,
  ) {
    this.main = mainAgent;
    this.bus = bus ?? mainAgent.bus;
    this.parallel = parallel;
    this.max_workers = maxWorkers;
    this.decompose_iterations = decomposeIterations;
    this.event_sink = eventSink ?? (async () => {});
  }

  async run(task: string, planningPrompt = "", context = ""): Promise<Orchestration> {
    await this._emit("phase", { phase: "decompose" });
    const plan = await this.decompose(task, planningPrompt, context);
    if (!plan.subtasks.length) {
      await this._emit("phase", { phase: "direct" });
      const msg = context ? `${context}\n\n${task}`.trim() : task;
      const result = await this.main.handleMessage(msg);
      return { task, subtasks: [], summary: result.content ?? "" };
    }

    for (const st of plan.subtasks) {
      await this._emit("subtask_start", { worker: st.worker, goal: st.goal, subtask_id: st.id });
    }

    if (this.parallel) {
      const sem = new Semaphore(this.max_workers ?? plan.subtasks.length);
      await Promise.all(
        plan.subtasks.map(async (st) => {
          await sem.run(async () => {
            await this._execute(st);
            await this._emit("subtask_done", { worker: st.worker, subtask_id: st.id, status: st.status });
          });
        }),
      );
    } else {
      for (const st of plan.subtasks) {
        await this._execute(st);
        await this._emit("subtask_done", { worker: st.worker, subtask_id: st.id, status: st.status });
      }
    }

    await this._emit("phase", { phase: "aggregate" });
    plan.summary = await this.aggregate(task, plan);
    await this._emit("phase", { phase: "done" });
    return plan;
  }

  private async _emit(event: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.event_sink("orchestrator", event, data);
    } catch {
      console.error(`event_sink 异常 event=${event}`);
    }
  }

  async decompose(task: string, planningPrompt = "", context = ""): Promise<Orchestration> {
    const ctxLine = context ? `\n参考上下文:\n${context}` : "";
    const prompt =
      planningPrompt ||
      `你是任务规划者。将以下任务拆解为若干可并行或串行执行的子任务,` +
        `每个子任务需指明:worker(执行该任务的最佳 Agent 名称)、goal(清晰的目标描述)。\n` +
        `任务: ${task}\n` +
        `可用 Agent: ${this.bus.names().join(", ")}\n` +
        `请以 JSON 输出,格式: {"subtasks": [{"worker": "...", "goal": "..."}]}` +
        ctxLine;
    const result = await this.main.provider.chat([tianshuMsg(prompt)], { tools: [decomposeToolSchema()] });
    return parsePlan(task, result);
  }

  private async _execute(st: SubTask): Promise<void> {
    const worker = this.bus.agent(st.worker);
    if (!worker) {
      st.status = "failed";
      st.error = `Worker 不存在: ${st.worker}`;
      return;
    }
    try {
      st.result = await worker.handleMessage(st.goal, "orchestrator");
      st.status = st.result.error ?? "done";
      if (st.result.error) st.status = "error";
    } catch (e) {
      st.status = "failed";
      st.error = String(e);
      console.error(`子任务执行失败 worker=${st.worker} goal=${st.goal.slice(0, 100)}`);
    }
  }

  async aggregate(task: string, plan: Orchestration): Promise<string> {
    if (!plan.subtasks.length) return "";
    const parts = plan.subtasks.map(
      (st) => `[${st.worker}] ${st.goal}\n结果: ${st.result?.content ?? st.error}`,
    );
    const prompt =
      `你是汇总员。以下是主任务 '${task}' 各子任务的执行结果,请整合成一份完整、连贯的最终答复。\n\n` +
      parts.join("\n\n");
    const result = await this.main.provider.chat([tianshuMsg(prompt)]);
    return result.content ?? "";
  }
}

export function tianshuMsg(content: string): { role: "user"; content: string } {
  return { role: "user", content };
}

export function decomposeToolSchema(): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: "produce_plan",
      description: "输出子任务拆解计划",
      parameters: {
        type: "object",
        properties: {
          subtasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                worker: { type: "string" },
                goal: { type: "string" },
              },
              required: ["worker", "goal"],
            },
          },
        },
        required: ["subtasks"],
      },
    },
  };
}

export function parsePlan(task: string, result: { content: string | null; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> | null }): Orchestration {
  const plan: Orchestration = { task, subtasks: [], summary: "" };
  const raw = result.content ?? "";
  if (result.tool_calls?.length) {
    for (const tc of result.tool_calls) {
      if (tc.name === "produce_plan") {
        const items = (tc.arguments.subtasks ?? []) as Array<{ worker?: string; goal?: string }>;
        items.forEach((item, idx) => {
          plan.subtasks.push({
            id: `st_${idx}`,
            worker: item.worker ?? "",
            goal: item.goal ?? "",
            status: "pending",
            result: null,
            error: null,
          });
        });
        return plan;
      }
    }
  }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const data = JSON.parse(m[0]) as { subtasks?: Array<{ worker?: string; goal?: string }> };
      (data.subtasks ?? []).forEach((item, idx) => {
        plan.subtasks.push({
          id: `st_${idx}`,
          worker: item.worker ?? "",
          goal: item.goal ?? "",
          status: "pending",
          result: null,
          error: null,
        });
      });
    } catch {
      // JSON 解析失败则返回空计划
    }
  }
  return plan;
}
