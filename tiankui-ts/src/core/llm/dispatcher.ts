import { createProvider } from "./factory.js";
import { LLMError } from "./types.js";
import type { BaseProvider, CancellationToken } from "./types.js";
import type { LLMMessage, LLMResult } from "./types.js";
import type { ChatOptions } from "./types.js";

export enum RoutingStrategy {
  SIMPLE_SHUFFLE = "simple-shuffle",
  LEAST_BUSY = "least-busy",
  USAGE_BASED = "usage-based-routing",
  LATENCY_BASED = "latency-based-routing",
  COST_BASED = "cost-based-routing",
}

export enum ErrorKind {
  RETRYABLE = "retryable",
  NON_RETRYABLE = "non-retryable",
  CONTEXT_WINDOW = "context-window",
  CONTENT_POLICY = "content-policy",
}

export interface Deployment {
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  weight: number;
  rpm: number | null;
  tpm: number | null;
  order: number;
  input_cost_per_1m: number;
  output_cost_per_1m: number;
  cooldown: boolean;
  cooldown_until: number;
  allowed_fails: number;
  active_requests: number;
  total_requests: number;
  success_count: number;
  fail_count: number;
  last_latency_ms: number;
  latency_window: number[];
  avg_latency_ms: number;
}

export interface DispatchConfig {
  routing_strategy: RoutingStrategy;
  num_retries: number;
  retry_delay: number;
  timeout: number;
  max_tokens: number | null;
  temperature: number;
  enable_cooldowns: boolean;
  cooldown_time: number;
  allowed_fails: number;
  max_fallbacks: number;
  enable_weighted_failover: boolean;
  fallbacks: Record<string, string[]>;
  context_window_fallbacks: Record<string, string[]>;
  content_policy_fallbacks: Record<string, string[]>;
}

export function defaultDispatchConfig(): DispatchConfig {
  return {
    routing_strategy: RoutingStrategy.SIMPLE_SHUFFLE,
    num_retries: 2,
    retry_delay: 1.0,
    timeout: 120.0,
    max_tokens: null,
    temperature: 0.2,
    enable_cooldowns: true,
    cooldown_time: 60.0,
    allowed_fails: 1,
    max_fallbacks: 5,
    enable_weighted_failover: true,
    fallbacks: {},
    context_window_fallbacks: {},
    content_policy_fallbacks: {},
  };
}

export type ProviderFactory = (
  name: string,
  baseUrl: string,
  model: string,
  apiKey: string,
  opts?: Record<string, unknown>,
) => BaseProvider;

export class Dispatcher {
  config: DispatchConfig;
  providerFactory: ProviderFactory;
  private _deployments = new Map<string, Deployment>();
  private _groups = new Map<string, string[]>();

  constructor(config: DispatchConfig | null = null, providerFactory: ProviderFactory | null = null) {
    this.config = config ?? defaultDispatchConfig();
    this.providerFactory = providerFactory ?? createProvider;
  }

  addDeployment(
    group: string,
    name: string,
    base_url: string,
    model: string,
    api_key = "",
    weight = 1,
    rpm: number | null = null,
    tpm: number | null = null,
    order = 999,
    input_cost_per_1m = 0.0,
    output_cost_per_1m = 0.0,
  ): void {
    const dep: Deployment = {
      name,
      base_url: base_url.replace(/\/+$/, ""),
      model,
      api_key,
      weight,
      rpm,
      tpm,
      order,
      input_cost_per_1m,
      output_cost_per_1m,
      cooldown: false,
      cooldown_until: 0.0,
      allowed_fails: this.config.allowed_fails,
      active_requests: 0,
      total_requests: 0,
      success_count: 0,
      fail_count: 0,
      last_latency_ms: 0.0,
      latency_window: [],
      avg_latency_ms: 0.0,
    };
    this._deployments.set(name, dep);
    if (!this._groups.has(group)) this._groups.set(group, []);
    this._groups.get(group)!.push(name);
    console.log(`注册部署: 组=${group} 名称=${name} -> ${base_url}/${model} weight=${weight} order=${order}`);
  }

  addFallback(group: string, targets: string[]): void {
    this.config.fallbacks[group] = targets;
  }

  addContextWindowFallback(group: string, targets: string[]): void {
    this.config.context_window_fallbacks[group] = targets;
  }

  addContentPolicyFallback(group: string, targets: string[]): void {
    this.config.content_policy_fallbacks[group] = targets;
  }

  listDeployments(): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const dep of this._deployments.values()) {
      result.push({
        name: dep.name,
        base_url: dep.base_url,
        model: dep.model,
        weight: dep.weight,
        rpm: dep.rpm,
        tpm: dep.tpm,
        order: dep.order,
        cooldown: dep.cooldown,
        cooldown_until: dep.cooldown_until,
        active_requests: dep.active_requests,
        total_requests: dep.total_requests,
        success_count: dep.success_count,
        fail_count: dep.fail_count,
        avg_latency_ms: Math.round(dep.avg_latency_ms * 100) / 100,
      });
    }
    return result;
  }

  async chat(messages: LLMMessage[], tools: Array<Record<string, unknown>> | null = null, modelGroup: string | null = null, opts: ChatOptions = {}): Promise<LLMResult> {
    const group = modelGroup ?? (this._groups.keys().next().value as string | undefined) ?? null;
    if (group === null || !this._groups.has(group)) {
      throw new LLMError("无可用模型组");
    }
    const visited = new Set<string>();
    const chain = this._buildChain(group, visited);
    return this._runChain(chain, messages, tools, opts);
  }

  private _buildChain(group: string, visited: Set<string>): string[] {
    const chain: string[] = [];
    let current = group;
    for (let i = 0; i < this.config.max_fallbacks + 1; i++) {
      if (visited.has(current)) break;
      visited.add(current);
      chain.push(current);
      const targets = this.config.fallbacks[current] ?? [];
      const nextGroup = targets.length ? targets[0] : null;
      if (nextGroup === null || !this._groups.has(nextGroup)) break;
      current = nextGroup;
    }
    return chain;
  }

  private async _runChain(chain: string[], messages: LLMMessage[], tools: Array<Record<string, unknown>> | null, opts: ChatOptions): Promise<LLMResult> {
    let lastError: Error | null = null;
    for (const group of chain) {
      try {
        return await this._callGroup(group, messages, tools, opts);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        console.warn(`模型组 ${group} 全部失败: ${lastError.message},切换到下一组`);
      }
    }
    throw new LLMError(`所有模型组均失败: ${lastError?.message ?? "未知错误"}`);
  }

  private async _callGroup(group: string, messages: LLMMessage[], tools: Array<Record<string, unknown>> | null, opts: ChatOptions): Promise<LLMResult> {
    const excluded = new Set<string>();
    const groupNames = this._groups.get(group) ?? [];
    const maxAttempts = groupNames.length * (this.config.num_retries + 1);
    for (let i = 0; i < maxAttempts; i++) {
      const dep = this._pickDeployment(group, excluded);
      if (dep === null) break;
      try {
        return await this._callDeployment(dep, messages, tools, opts);
      } catch (e) {
        if (e instanceof LLMError) {
          this._onFailure(dep, e);
          if (this.config.enable_weighted_failover) {
            excluded.add(dep.name);
            console.log(`部署 ${dep.name} 失败,排除后按权重重选(组内故障转移)`);
            continue;
          }
          break;
        }
        throw e;
      } finally {
        dep.active_requests = Math.max(0, dep.active_requests - 1);
      }
    }
    throw new LLMError(`模型组 ${group} 内所有部署均失败`);
  }

  private _pickDeployment(group: string, excluded: Set<string>): Deployment | null {
    const now = Date.now() / 1000;
    const names = (this._groups.get(group) ?? []).filter((n) => !excluded.has(n));
    if (!names.length) return null;
    let deps = names
      .map((n) => this._deployments.get(n)!)
      .filter((d) => !this._isInCooldown(d, now));
    if (!deps.length) {
      deps = names.map((n) => this._deployments.get(n)!);
    }

    switch (this.config.routing_strategy) {
      case RoutingStrategy.LEAST_BUSY:
        return deps.reduce((a, b) => (a.active_requests <= b.active_requests ? a : b));
      case RoutingStrategy.USAGE_BASED:
        return deps.reduce((a, b) => (this._usageScore(a) <= this._usageScore(b) ? a : b));
      case RoutingStrategy.LATENCY_BASED:
        return deps.reduce((a, b) => ((a.avg_latency_ms || 999999) <= (b.avg_latency_ms || 999999) ? a : b));
      case RoutingStrategy.COST_BASED:
        return deps.reduce((a, b) =>
          a.input_cost_per_1m + a.output_cost_per_1m <= b.input_cost_per_1m + b.output_cost_per_1m ? a : b,
        );
      case RoutingStrategy.SIMPLE_SHUFFLE:
      default:
        return this._pickWeightedRandom(deps);
    }
  }

  private _usageScore(d: Deployment): number {
    if (d.rpm) return d.total_requests / d.rpm;
    return 0.0;
  }

  private _pickWeightedRandom(deps: Deployment[]): Deployment {
    const total = deps.reduce((s, d) => s + d.weight, 0);
    if (total <= 0) return deps[Math.floor(Math.random() * deps.length)];
    let r = Math.random() * total;
    for (const dep of deps) {
      r -= dep.weight;
      if (r <= 0) return dep;
    }
    return deps[deps.length - 1];
  }

  private _isInCooldown(dep: Deployment, now: number): boolean {
    if (!dep.cooldown) return false;
    if (now >= dep.cooldown_until) {
      dep.cooldown = false;
      dep.cooldown_until = 0.0;
      dep.fail_count = 0;
      console.log(`部署 ${dep.name} 冷却结束,恢复流量`);
      return false;
    }
    return true;
  }

  private async _callDeployment(dep: Deployment, messages: LLMMessage[], tools: Array<Record<string, unknown>> | null, opts: ChatOptions): Promise<LLMResult> {
    dep.active_requests += 1;
    dep.total_requests += 1;
    const start = Date.now();
    try {
      const provider = this.providerFactory(dep.name, dep.base_url, dep.model, dep.api_key, {
        timeout: this.config.timeout,
        max_tokens: this.config.max_tokens,
        temperature: this.config.temperature,
      });
      const result = await provider.chat(messages, { tools, cancel_event: opts.cancel_event });
      const elapsedMs = Date.now() - start;
      dep.success_count += 1;
      dep.fail_count = 0;
      dep.last_latency_ms = elapsedMs;
      dep.latency_window.push(elapsedMs);
      if (dep.latency_window.length > 100) dep.latency_window.shift();
      dep.avg_latency_ms = dep.latency_window.reduce((a, b) => a + b, 0) / dep.latency_window.length;
      console.log(`成功: ${dep.name} latency=${Math.round(elapsedMs)}ms avg=${Math.round(dep.avg_latency_ms)}ms`);
      return result;
    } catch (e) {
      if (e instanceof LLMError) {
        const specialized = await this._trySpecializedFallback(dep, e, messages, tools, opts);
        if (specialized !== null) {
          dep.success_count += 1;
          dep.fail_count = 0;
          dep.last_latency_ms = Date.now() - start;
          console.log(`专类 fallback 成功: ${dep.name}`);
          return specialized;
        }
        dep.last_latency_ms = Date.now() - start;
      }
      throw e;
    } finally {
      dep.active_requests = Math.max(0, dep.active_requests - 1);
    }
  }

  private async _trySpecializedFallback(
    dep: Deployment,
    error: LLMError,
    messages: LLMMessage[],
    tools: Array<Record<string, unknown>> | null,
    opts: ChatOptions,
  ): Promise<LLMResult | null> {
    const kind = Dispatcher._classifyError(error.message);
    let targets: string[] = [];
    if (kind === ErrorKind.CONTEXT_WINDOW) {
      targets = this.config.context_window_fallbacks[dep.name] ?? this.config.context_window_fallbacks[this._findGroup(dep.name)] ?? [];
      console.log(`上下文超限,走 context_window_fallbacks -> ${targets.join(",")}`);
    } else if (kind === ErrorKind.CONTENT_POLICY) {
      targets = this.config.content_policy_fallbacks[dep.name] ?? [];
      console.log(`内容策略拒绝,走 content_policy_fallbacks -> ${targets.join(",")}`);
    } else {
      return null;
    }
    for (const group of targets) {
      if (!this._groups.has(group)) continue;
      try {
        return await this._callGroup(group, messages, tools, opts);
      } catch {
        continue;
      }
    }
    return null;
  }

  private static _classifyError(error: string): ErrorKind {
    const lower = error.toLowerCase();
    if (lower.includes("context") && (lower.includes("exceed") || lower.includes("length") || lower.includes("too long"))) {
      return ErrorKind.CONTEXT_WINDOW;
    }
    if (lower.includes("content") && (lower.includes("policy") || lower.includes("filter") || lower.includes("safety") || lower.includes("moderation"))) {
      return ErrorKind.CONTENT_POLICY;
    }
    return ErrorKind.RETRYABLE;
  }

  private _findGroup(name: string): string {
    for (const [group, names] of this._groups) {
      if (names.includes(name)) return group;
    }
    return "";
  }

  private _onFailure(dep: Deployment, error: LLMError): void {
    const elapsedMs = dep.last_latency_ms;
    dep.fail_count += 1;
    console.warn(`失败: ${dep.name} error=${error.message} fail_count=${dep.fail_count}`);
    if (this.config.enable_cooldowns && dep.fail_count >= dep.allowed_fails) {
      dep.cooldown = true;
      dep.cooldown_until = Date.now() / 1000 + this.config.cooldown_time;
      console.warn(`部署 ${dep.name} 连续失败${dep.fail_count}次,进入冷却 ${this.config.cooldown_time}s`);
    }
    dep.last_latency_ms = elapsedMs;
  }

  getStats(): Record<string, unknown> {
    return {
      deployments: this.listDeployments(),
      groups: Object.fromEntries([...this._groups].map(([g, n]) => [g, n.length])),
      strategy: this.config.routing_strategy,
      fallbacks: this.config.fallbacks,
      cooldowns: Object.fromEntries(
        [...this._deployments].map(([name, d]) => [name, { cooldown: d.cooldown, until: d.cooldown_until }]),
      ),
    };
  }

  disableDeployment(name: string): boolean {
    const dep = this._deployments.get(name);
    if (!dep) return false;
    dep.cooldown = true;
    dep.cooldown_until = Date.now() / 1000 + 31536000;
    return true;
  }

  enableDeployment(name: string): boolean {
    const dep = this._deployments.get(name);
    if (!dep) return false;
    dep.cooldown = false;
    dep.cooldown_until = 0.0;
    dep.fail_count = 0;
    return true;
  }
}

export class MultiProviderChain {
  private _providers = new Map<string, BaseProvider>();
  config: DispatchConfig;

  constructor(providers: Array<[string, string, string, string]>, config: DispatchConfig | null = null, providerFactory: ProviderFactory | null = null) {
    this.config = config ?? defaultDispatchConfig();
    const factory = providerFactory ?? createProvider;
    for (const [name, baseUrl, model, apiKey] of providers) {
      this._providers.set(name, factory(name, baseUrl, model, apiKey, { timeout: this.config.timeout }));
    }
  }

  async chat(messages: LLMMessage[], tools: Array<Record<string, unknown>> | null = null, opts: ChatOptions = {}): Promise<LLMResult> {
    let lastError: Error | null = null;
    for (const [name, provider] of this._providers) {
      try {
        const result = await provider.chat(messages, { tools, cancel_event: opts.cancel_event });
        console.log(`Provider ${name} 成功`);
        return result;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        console.warn(`Provider ${name} 失败: ${lastError.message}`);
      }
    }
    throw new LLMError(`所有 Provider 均失败: ${lastError?.message ?? "未知错误"}`);
  }

  getStatus(): Record<string, string>[] {
    return [...this._providers].map(([name, p]) => ({ name, base_url: p.base_url, model: p.model }));
  }
}

export function createDispatcherFromProviders(
  providers: Array<Record<string, unknown>>,
  strategy = "simple-shuffle",
): Dispatcher {
  const dispatcher = new Dispatcher({ ...defaultDispatchConfig(), routing_strategy: strategy as RoutingStrategy });
  for (const p of providers) {
    dispatcher.addDeployment(
      String(p.group ?? p.name),
      String(p.name),
      String(p.base_url),
      String(p.model),
      String(p.api_key ?? ""),
      Number(p.weight ?? 1),
      (p.rpm as number | null) ?? null,
      (p.tpm as number | null) ?? null,
      Number(p.order ?? 999),
      Number(p.input_cost_per_1m ?? 0.0),
      Number(p.output_cost_per_1m ?? 0.0),
    );
  }
  return dispatcher;
}
