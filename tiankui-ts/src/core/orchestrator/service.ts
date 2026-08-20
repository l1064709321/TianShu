import type { Agent, AgentResult, MessageBus } from "../agent/runtime.js";
import { SessionStore } from "../session.js";

export interface SubTask {
  id: string;
  worker: string;
  goal: string;
  status: "pending" | "running" | "done" | "error" | "failed" | "cancelled";
  result: AgentResult | null;
  error: string | null;
  children?: SubTask[];
  depends?: string[];
  retry_count?: number;
  max_retries?: number;
  started_at?: number;
  finished_at?: number;
  timeout_ms?: number;
}

export interface Orchestration {
  task: string;
  subtasks: SubTask[];
  summary: string;
  stats?: {
    total_iterations: number;
    parallel_max: number;
    failed_count: number;
    retries: number;
    cancelled_count: number;
    timeout_count: number;
  };
}

export type EventSinkFn = (agent: string, event: string, data: Record<string, unknown>) => Promise<void>;
export type ProgressCb = (agent: string, event: string, data: Record<string, unknown>) => void;

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

function genId(prefix = "st"): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export class Orchestrator {
  main: Agent;
  bus: MessageBus;
  parallel: boolean;
  max_workers: number | null;
  max_iterations: number;
  max_depth: number;
  retry_enabled: boolean;
  max_retries: number;
  subtask_timeout_ms: number;
  replan_on_failure: boolean;
  event_sink: EventSinkFn;
  session_store: SessionStore | null;
  shared_context: Record<string, unknown>;
  currentPlan: Orchestration | null;
  private _cancelled: boolean;

  constructor(
    mainAgent: Agent,
    bus: MessageBus | null = null,
    parallel = true,
    maxWorkers: number | null = null,
    maxIterations = 5,
    maxDepth = 3,
    retryEnabled = true,
    maxRetries = 2,
    eventSink: EventSinkFn | null = null,
    sessionStore: SessionStore | null = null,
    sharedContext: Record<string, unknown> | null = null,
    subtaskTimeoutMs = 60000,
    replanOnFailure = false,
  ) {
    this.main = mainAgent;
    this.bus = bus ?? mainAgent.bus;
    this.parallel = parallel;
    this.max_workers = maxWorkers;
    this.max_iterations = maxIterations;
    this.max_depth = maxDepth;
    this.retry_enabled = retryEnabled;
    this.max_retries = maxRetries;
    this.subtask_timeout_ms = subtaskTimeoutMs;
    this.replan_on_failure = replanOnFailure;
    this.event_sink = eventSink ?? (async () => {});
    this.session_store = sessionStore;
    this.shared_context = sharedContext ?? {};
    this.currentPlan = null;
    this._cancelled = false;
  }

  cancel(): void {
    this._cancelled = true;
  }

  async run(task: string, planningPrompt = "", context = ""): Promise<Orchestration> {
    this._cancelled = false;
    const stats = { total_iterations: 0, parallel_max: 0, failed_count: 0, retries: 0, cancelled_count: 0, timeout_count: 0 };
    const plan = await this.decompose(task, planningPrompt, context);
    this.currentPlan = plan;

    if (!plan.subtasks.length) {
      this._progress("direct", { task });
      const msg = context ? `${context}\n\n${task}`.trim() : task;
      const result = await this.main.handleMessage(msg);
      return { task, subtasks: [], summary: result.content ?? "" };
    }

    let concurrent = 0;
    let maxConcurrent = 0;
    const running = new Set<string>();

    const executeWithDeps = async (st: SubTask): Promise<void> => {
      if (this._cancelled) {
        st.status = "cancelled";
        st.error = "任务已取消";
        return;
      }
      await this.waitForDeps(st.depends ?? []);
      if (this._cancelled) {
        st.status = "cancelled";
        st.error = "任务已取消";
        return;
      }
      if (this.event_sink) {
        await this.event_sink("orchestrator", "subtask_start", { id: st.id, worker: st.worker, goal: st.goal.slice(0, 100) });
      }
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        await this._execute(st, 0);
        stats.total_iterations++;
      } finally {
        concurrent--;
        running.delete(st.id);
      }
    };

    const jobs = plan.subtasks.map((st) => executeWithDeps(st));
    if (this.parallel) {
      const sem = new Semaphore(this.max_workers ?? plan.subtasks.length);
      const jobFns = jobs.map((j) => () => j);
      await Promise.all(jobFns.map((fn) => sem.run(fn)));
    } else {
      for (const j of jobs) await j;
    }

    if (this.replan_on_failure) {
      const failed = plan.subtasks.filter((st) => st.status === "failed" || st.status === "error");
      if (failed.length > 0 && !this._cancelled) {
        const failedInfo = failed.map((st) => `  [${st.id}] ${st.worker}: ${st.goal.slice(0, 80)} — ${st.error ?? "执行失败"}`).join("\n");
        const replanPrompt = `以下子任务执行失败,请重新规划替代方案:\n${failedInfo}\n原任务: ${task}`;
        const replan = await this.decompose(replanPrompt, "", task, 0);
        if (replan.subtasks.length) {
          plan.subtasks.push(...replan.subtasks);
          const replanJobs = replan.subtasks.map((st) => executeWithDeps(st));
          if (this.parallel) {
            const sem = new Semaphore(this.max_workers ?? plan.subtasks.length);
            await Promise.all(replanJobs.map((j) => sem.run(() => j)));
          } else {
            for (const j of replanJobs) await j;
          }
        }
      }
    }

    plan.stats = { ...stats, parallel_max: maxConcurrent };
    plan.summary = await this.aggregate(task, plan);
    this._progress("done", { task, subtasks: plan.subtasks.length, failed: stats.failed_count });

    if (this.session_store) {
      const sid = (this.main as any).sessionId ?? "default";
      this.session_store.saveOrchestration(sid, task, plan.summary, plan.subtasks);
    }

    this.currentPlan = null;
    return plan;
  }

  private async waitForDeps(depIds: string[]): Promise<void> {
    if (!depIds.length) return;
    await Promise.all(depIds.map((id) => this._waitForResult(id)));
  }

  private _waitForResult(id: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this._cancelled) {
          resolve();
          return;
        }
        const st = this._findSubtask(this.currentPlan?.subtasks ?? [], id);
        if (st && (st.status === "done" || st.status === "error" || st.status === "failed" || st.status === "cancelled")) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  private _findSubtask(tasks: SubTask[], id: string): SubTask | null {
    for (const t of tasks) {
      if (t.id === id) return t;
      if (t.children) {
        const found = this._findSubtask(t.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  private _progress(event: string, data: Record<string, unknown>): void {
    if (this.event_sink) {
      try {
        this.event_sink("orchestrator", event, data);
      } catch {
        console.error(`event_sink 异常 event=${event}`);
      }
    }
  }

  async decompose(task: string, planningPrompt = "", context = "", depth = 0): Promise<Orchestration> {
    if (depth >= this.max_depth) {
      return { task, subtasks: [], summary: "" };
    }

    const ctxLine = context ? `\n参考上下文:\n${context}` : "";
    const sharedCtx = Object.keys(this.shared_context).length
      ? `\n共享上下文(其他 Agent 已完成的工作):\n${JSON.stringify(this.shared_context).slice(0, 2000)}`
      : "";
    const prompt =
      planningPrompt ||
      `你是任务规划者。将以下任务拆解为若干可并行或串行执行的子任务,` +
        `每个子任务需指明:worker(执行该任务的最佳 Agent 名称)、goal(清晰的目标描述)、depends(前置依赖的子任务 ID 数组,无依赖传空数组)。\n` +
        `任务: ${task}\n` +
        `可用 Agent: ${this.bus.names().join(", ")}\n` +
        `最大迭代: ${this.max_iterations - depth}\n` +
        `请以 JSON 输出,格式: {"subtasks": [{"worker": "...", "goal": "...", "depends": ["st_xxx"]}]}` +
        ctxLine +
        sharedCtx;

    const result = await this.main.provider.chat([tiankuiMsg(prompt)], { tools: [decomposeToolSchema()] });
    const plan = parsePlan(task, result, depth);

    const recursivePlans = await Promise.all(
      plan.subtasks.map(async (st) => {
        const childPlan = await this.decompose(st.goal, "", "", depth + 1);
        if (childPlan.subtasks.length) {
          st.children = childPlan.subtasks;
          st.goal = `${st.goal}\n(需进一步拆解执行)`;
        }
        return st;
      }),
    );
    plan.subtasks = recursivePlans;
    return plan;
  }

  private async _execute(st: SubTask, retryCount = 0): Promise<void> {
    const worker = this.bus.agent(st.worker);
    if (!worker) {
      st.status = "failed";
      st.error = `Worker 不存在: ${st.worker}`;
      return;
    }
    try {
      const context = this._buildContext(st);
      const timeout = st.timeout_ms ?? this.subtask_timeout_ms;
      st.started_at = Date.now();
      st.status = "running";
      st.result = await Promise.race([
        worker.handleMessage(st.goal, "orchestrator"),
        new Promise<AgentResult>((_, reject) =>
          setTimeout(() => reject(new Error(`子任务超时(${timeout}ms) worker=${st.worker}`)), timeout),
        ),
      ]);
      st.status = (st.result.error as "error" | "failed" | null) ? "error" : "done";
      st.finished_at = Date.now();
      this._updateSharedContext(st);
    } catch (e) {
      st.finished_at = Date.now();
      const errMsg = String(e);
      if (errMsg.includes("超时")) {
        st.status = "failed";
        st.error = errMsg;
        if (this.event_sink) {
          await this.event_sink("orchestrator", "subtask_timeout", { id: st.id, worker: st.worker, timeout_ms: st.timeout_ms ?? this.subtask_timeout_ms });
        }
        return;
      }
      if (this._cancelled) {
        st.status = "cancelled";
        st.error = "任务已取消";
        return;
      }
      if (this.retry_enabled && retryCount < (st.max_retries ?? this.max_retries)) {
        st.retry_count = (st.retry_count ?? 0) + 1;
        await this._execute(st, retryCount + 1);
        return;
      }
      st.status = "failed";
      st.error = errMsg;
      console.error(`子任务执行失败 worker=${st.worker} goal=${st.goal.slice(0, 100)}`);
    }
  }

  private _buildContext(st: SubTask): string {
    const parts: string[] = [];
    for (const key of Object.keys(this.shared_context)) {
      parts.push(`[${key}]: ${String(this.shared_context[key]).slice(0, 500)}`);
    }
    return parts.join("\n") || "";
  }

  private _updateSharedContext(st: SubTask): void {
    if (st.result?.content) {
      const key = `result_${st.id}`;
      this.shared_context[key] = st.result.content.slice(0, 3000);
    }
  }

  async aggregate(task: string, plan: Orchestration): Promise<string> {
    if (!plan.subtasks.length) return "";
    const parts: string[] = [];
    for (const st of plan.subtasks) {
      const result = st.result?.content ?? st.error ?? "(无结果)";
      parts.push(`[${st.worker} - ${st.id} - ${st.status}]\n目标: ${st.goal}\n结果: ${result}`);
      if (st.children?.length) {
        for (const child of st.children) {
          const childResult = child.result?.content ?? child.error ?? "(无结果)";
          parts.push(`  └─ [${child.worker} - ${child.id} - ${child.status}]\n      结果: ${childResult}`);
        }
      }
    }
    const prompt =
      `你是汇总员。以下是主任务 '${task}' 各子任务的执行结果,请整合成一份完整、连贯的最终答复。\n\n` +
      parts.join("\n\n");
    const result = await this.main.provider.chat([tiankuiMsg(prompt)]);
    return result.content ?? "";
  }
}

export function tiankuiMsg(content: string): { role: "user"; content: string } {
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
                depends: { type: "array", items: { type: "string" } },
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

export function parsePlan(
  task: string,
  result: { content: string | null; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> | null },
  depth = 0,
): Orchestration {
  const plan: Orchestration = { task, subtasks: [], summary: "" };
  const raw = result.content ?? "";
  if (result.tool_calls?.length) {
    for (const tc of result.tool_calls) {
      if (tc.name === "produce_plan") {
        const items = (tc.arguments.subtasks ?? []) as Array<{ worker?: string; goal?: string; depends?: string[] }>;
        items.forEach((item, idx) => {
          plan.subtasks.push({
            id: genId(`st_d${depth}_${idx}`),
            worker: item.worker ?? "",
            goal: item.goal ?? "",
            status: "pending",
            result: null,
            error: null,
            depends: item.depends ?? [],
            max_retries: 2,
          });
        });
        return plan;
      }
    }
  }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const data = JSON.parse(m[0]) as { subtasks?: Array<{ worker?: string; goal?: string; depends?: string[] }> };
      (data.subtasks ?? []).forEach((item, idx) => {
        plan.subtasks.push({
          id: genId(`st_d${depth}_${idx}`),
          worker: item.worker ?? "",
          goal: item.goal ?? "",
          status: "pending",
          result: null,
          error: null,
          depends: item.depends ?? [],
          max_retries: 2,
        });
      });
    } catch {
      // JSON 解析失败则返回空计划
    }
  }
  return plan;
}

export function detectDepCycle(subtasks: SubTask[]): string[] | null {
  const allIds = new Set<string>();
  const collectIds = (tasks: SubTask[]) => {
    for (const t of tasks) {
      allIds.add(t.id);
      if (t.children) collectIds(t.children);
    }
  };
  collectIds(subtasks);

  const adj = new Map<string, string[]>();
  for (const t of subtasks) {
    adj.set(t.id, t.depends ?? []);
    if (t.children) {
      for (const child of t.children) {
        adj.set(child.id, child.depends ?? []);
      }
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const cycle: string[] = [];

  const dfs = (u: string): boolean => {
    color.set(u, GRAY);
    for (const v of (adj.get(u) ?? [])) {
      if (!allIds.has(v)) continue;
      if (color.get(v) === GRAY) {
        cycle.push(v);
        cycle.push(u);
        return true;
      }
      if (color.get(v) !== BLACK) {
        if (dfs(v)) {
          if (cycle.length === 0 || cycle[cycle.length - 1] !== u) {
            cycle.push(u);
          }
          return true;
        }
      }
    }
    color.set(u, BLACK);
    return false;
  };

  for (const id of allIds) {
    if (color.get(id) === undefined) {
      if (dfs(id)) {
        return cycle.reverse();
      }
    }
  }
  return null;
}
