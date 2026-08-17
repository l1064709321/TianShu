import { randomUUID } from "node:crypto";
import type { Tool } from "../tools/registry.js";

export enum ReviewStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
  TIMEOUT = "timeout",
}

export interface ReviewRequest {
  id: string;
  agent: string;
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
  status: ReviewStatus;
  created_at: number;
  decided_by: string;
}

export type ReviewCallback = (req: ReviewRequest) => void;

export class ReviewSystem {
  mode: string;
  private _pending = new Map<string, ReviewRequest>();
  private _events = new Map<string, { resolve: () => void }>();
  private _subscribers: ReviewCallback[] = [];

  constructor(mode = "manual") {
    this.mode = mode;
  }

  subscribe(cb: ReviewCallback): void {
    this._subscribers.push(cb);
  }

  setMode(mode: string): void {
    this.mode = mode;
  }

  pending(): ReviewRequest[] {
    return [...this._pending.values()];
  }

  get(reviewId: string): ReviewRequest | null {
    return this._pending.get(reviewId) ?? null;
  }

  async request(
    agent: string,
    tool: string,
    arguments_: Record<string, unknown>,
    reason = "",
    timeout = 120.0,
  ): Promise<ReviewRequest> {
    const req: ReviewRequest = {
      id: randomUUID().replace(/-/g, "").slice(0, 12),
      agent,
      tool,
      arguments: arguments_,
      reason,
      status: ReviewStatus.PENDING,
      created_at: Date.now() / 1000,
      decided_by: "",
    };
    if (this.mode === "auto_approve") {
      this._decide(req, ReviewStatus.APPROVED, "auto_approve");
      return req;
    }
    if (this.mode === "auto_reject") {
      this._decide(req, ReviewStatus.REJECTED, "auto_reject");
      return req;
    }
    if (this.mode === "manual" && !this._subscribers.length) {
      this._decide(req, ReviewStatus.REJECTED, "no_subscribers");
      return req;
    }

    this._pending.set(req.id, req);
    const evt: { resolve: () => void } = { resolve: () => {} };
    const eventPromise = new Promise<void>((resolve) => {
      evt.resolve = resolve;
    });
    this._events.set(req.id, evt);
    for (const cb of this._subscribers) cb(req);
    const timer = new Promise<void>((resolve) => setTimeout(resolve, timeout * 1000));
    await Promise.race([eventPromise, timer]);
    if (req.status === ReviewStatus.PENDING) {
      this._decide(req, ReviewStatus.TIMEOUT, "timeout");
    }
    return req;
  }

  decide(reviewId: string, approve: boolean, by = "human"): boolean {
    const req = this._pending.get(reviewId);
    if (!req || req.status !== ReviewStatus.PENDING) return false;
    this._decide(req, approve ? ReviewStatus.APPROVED : ReviewStatus.REJECTED, by);
    return true;
  }

  private _decide(req: ReviewRequest, status: ReviewStatus, by: string): void {
    req.status = status;
    req.decided_by = by;
    this._pending.delete(req.id);
    const evt = this._events.get(req.id);
    if (evt) {
      this._events.delete(req.id);
      evt.resolve();
    }
  }
}

export async function gateTool(review: ReviewSystem, agentName: string, tool: Tool, args: Record<string, unknown>): Promise<void> {
  const req = await review.request(agentName, tool.name, args, `工具 ${tool.name} 属于高危操作`);
  if (req.status !== ReviewStatus.APPROVED) {
    if (req.decided_by === "no_subscribers") {
      throw new Error("该操作需人工审批,但当前没有连接审批端(管理面板),已拒绝;请打开面板后重试");
    }
    throw new Error(`未通过审核: ${req.status}(${req.decided_by})`);
  }
}
