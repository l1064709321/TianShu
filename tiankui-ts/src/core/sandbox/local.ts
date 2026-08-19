import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { WORKSPACE_DIR } from "../../config.js";

const MAX_MEMORY_MB = 512;
const MAX_CPU_SECONDS = 60;
const MAX_PROCESSES = 256;

export interface SandboxResult {
  out: string;
  err: string | null;
}

let hardenedLevel: number | null = null;

function isRoot(): boolean {
  try {
    return process.getuid?.() === 0;
  } catch {
    return false;
  }
}

function ensureTraversable(ws: string): void {
  if (!isRoot()) return;
  const parts: string[] = [];
  let cur = path.resolve(ws);
  parts.push(cur);
  while (cur !== path.parse(cur).root) {
    cur = path.dirname(cur);
    parts.push(cur);
  }
  for (const dir of parts) {
    try {
      const mode = fs.statSync(dir).mode & 0o777;
      if ((mode & 0o1) === 0) fs.chmodSync(dir, mode | 0o1);
    } catch {
      /* 目录可能不存在,忽略 */
    }
  }
}

function scriptFor(cwd: string, timeout: number, level: number, args: string[]): string[] {
  const memKb = MAX_MEMORY_MB * 1024;
  const limits = [
    `ulimit -v ${memKb} 2>/dev/null;`,
    `ulimit -t ${MAX_CPU_SECONDS} 2>/dev/null;`,
    `ulimit -u ${MAX_PROCESSES} 2>/dev/null;`,
  ].join(" ");
  const cd = `cd "$1" 2>/dev/null || true; shift 2>/dev/null;`;
  let execLine: string;
  if (level >= 3) {
    execLine = `exec unshare --mount --net --pid --fork runuser -u nobody -- timeout ${timeout} "$@"`;
  } else if (level === 2) {
    execLine = `exec unshare --net --fork runuser -u nobody -- timeout ${timeout} "$@"`;
  } else if (level === 1) {
    execLine = `exec runuser -u nobody -- timeout ${timeout} "$@"`;
  } else {
    execLine = `timeout ${timeout} "$@" || { rc=$?; [ $rc -eq 124 ] && echo '__SANDBOX_TIMEOUT__' >&2; exit $rc; }`;
  }
  return ["/bin/bash", "-c", `${limits} ${cd} ${execLine}`, "sandbox", cwd, ...args];
}

function runOnce(script: string[], cwd: string, timeout: number): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const proc = spawn(script[0], script.slice(1), { cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ out: stdout, err: "(命令超时,已终止)" });
    }, (timeout + 5) * 1000);
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ out: stdout, err: e.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      let err: string | null = null;
      if (code !== 0) {
        const timedOut = stderr.includes("__SANDBOX_TIMEOUT__");
        err = timedOut ? "(命令超时,已终止)" : (stderr.trim() || `退出码 ${code}`);
      }
      resolve({ out: stdout, err });
    });
  });
}

function legacyFails(err: string | null): boolean {
  if (!err) return false;
  return /unshare|runuser|nobody|Operation not permitted|cannot set.*namespace/i.test(err);
}

export function wrapWithUlimit(args: string[], timeout: number): string[] {
  return scriptFor("", timeout, 0, args);
}

export async function runInLocalSandbox(args: string[], cwd: string, timeout: number): Promise<SandboxResult> {
  const baseCwd = cwd || WORKSPACE_DIR;
  if (hardenedLevel === null) {
    if (!isRoot()) {
      hardenedLevel = 0;
    } else {
      hardenedLevel = 0;
      const candidates: Array<{ level: number; probe: string | null }> = [
        { level: 3, probe: "true" },
        { level: 2, probe: "true" },
        { level: 1, probe: "true" },
      ];
      for (const c of candidates) {
        const script = scriptFor(baseCwd, 10, c.level, ["true"]);
        const probe = await runOnce(script, baseCwd, 10);
        if (!probe.err && probe.out.trim() === "") {
          hardenedLevel = c.level;
          break;
        }
        if (c.level === 1 && legacyFails(probe.err)) continue;
      }
      if (hardenedLevel === 0) {
        const script = scriptFor(baseCwd, 10, 0, ["true"]);
        const probe = await runOnce(script, baseCwd, 10);
        if (!probe.err && probe.out.trim() === "") hardenedLevel = 0;
      }
    }
  }
  if (hardenedLevel > 0) ensureTraversable(baseCwd);
  const script = scriptFor(baseCwd, timeout, hardenedLevel ?? 0, args);
  const first = await runOnce(script, baseCwd, timeout);
  if (first.err && !first.out.trim()) {
    const second = await runOnce(script, baseCwd, timeout);
    return second;
  }
  return first;
}

export async function detectBackend(): Promise<string> {
  return "local";
}

export async function runInSandbox(args: string[], cwd: string = WORKSPACE_DIR, timeout = 30): Promise<SandboxResult> {
  const { err, out } = await runInLocalSandbox(args, cwd, timeout);
  return { out, err };
}