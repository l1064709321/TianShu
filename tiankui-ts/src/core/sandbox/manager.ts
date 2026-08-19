import { dockerAvailable, runInDocker } from "./docker.js";
import { runInLocalSandbox } from "./local.js";

let _backend: string | null = null;

export function setSandboxBackend(backend: string): void {
  _backend = backend;
}

export async function detectBackend(): Promise<string> {
  if (_backend !== null) return _backend;
  try {
    if (await dockerAvailable()) {
      _backend = "docker";
      return _backend;
    }
  } catch {
    /* 探测失败按 local */
  }
  _backend = "local";
  return _backend;
}

export async function runInSandbox(
  args: string[],
  cwd: string,
  timeout = 30,
  envExtra: Record<string, string> | null = null,
): Promise<{ out: string; err: string | null }> {
  let backend = await detectBackend();
  if (backend === "docker") {
    const r = await runInDocker(args, cwd, timeout, envExtra);
    if (r.err === null) return r;
    console.error(`[sandbox] docker 执行失败,降级 local: ${r.err.slice(0, 200)}`);
    backend = "local";
  }
  return runInLocalSandbox(args, cwd, timeout);
}