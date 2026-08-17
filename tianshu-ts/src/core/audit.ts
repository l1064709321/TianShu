import * as fs from "node:fs";
import * as path from "node:path";
import { WORKSPACE_DIR } from "../config.js";

export const AUDIT_DIR = path.join(WORKSPACE_DIR, ".ts-audit");

export function audit(event: string, detail: string, actor = "system"): void {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      actor,
      detail,
    });
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    fs.appendFileSync(path.join(AUDIT_DIR, `audit-${day}.log`), line + "\n", "utf-8");
  } catch {
    // 审计失败不阻断主流程
  }
}