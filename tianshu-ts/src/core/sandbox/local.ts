import { spawn } from "node:child_process";
import { WORKSPACE_DIR } from "../../config.js";

const MAX_MEMORY_MB = 512;
const MAX_CPU_SECONDS = 60;
const MAX_PROCESSES = 256;

export interface SandboxResult {
  out: string;
  err: string | null;
}

export function wrapWithUlimit(args: string[], timeout: number): string[] {
  const memKb = MAX_MEMORY_MB * 1024;
  const script = [
    `ulimit -v ${memKb} 2>/dev/null;`,
    `ulimit -t ${MAX_CPU_SECONDS} 2>/dev/null;`,
    `ulimit -u ${MAX_PROCESSES} 2>/dev/null;`,
    `timeout ${timeout} "$@" ||`,
    `{ rc=$?; [ $rc -eq 124 ] && echo '__SANDBOX_TIMEOUT__' >&2; exit $rc; }`,
  ].join(" ");
  return ["/bin/bash", "-c", script, "sandbox", ...args];
}

export function runInLocalSandbox(args: string[], cwd: string, timeout: number): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const full = wrapWithUlimit(args, timeout);
    const proc = spawn(full[0], full.slice(1), { cwd });
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

export async function detectBackend(): Promise<string> {
  return "local";
}

export async function runInSandbox(args: string[], cwd: string = WORKSPACE_DIR, timeout = 30): Promise<SandboxResult> {
  const { err, out } = await runInLocalSandbox(args, cwd, timeout);
  return { out, err };
}
