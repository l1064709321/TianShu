import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_NAME = process.env.TIANKUI_SANDBOX_IMAGE ?? "lordofstars/tiankui-sandbox";
const DOCKERFILE = fs.readFileSync(path.join(HERE, "Dockerfile"), "utf-8");

interface DockerRun {
  out: string;
  err: string | null;
}

async function runDocker(args: string[], timeout = 60, killCmd: string[] | null = null): Promise<DockerRun> {
  try {
    const proc = execFileP("docker", args, { timeout: timeout * 1000, maxBuffer: 16 * 1024 * 1024 });
    const { stdout, stderr } = await proc;
    const err = stderr.trim();
    return { out: stdout.trim(), err: err || null };
  } catch (e) {
    const error = e as NodeJS.ErrnoException & { code?: string };
    if (error.code === "ENOENT") return { out: "", err: "docker 命令不存在" };
    const killed = (e as Error & { killed?: boolean }).killed;
    if (killed && killCmd) {
      try {
        await execFileP("docker", killCmd, { timeout: 10000 });
      } catch {
        /* noop */
      }
      return { out: "", err: "(docker 操作超时,已强杀)" };
    }
    if (error.code === "ETIMEDOUT") {
      if (killCmd) {
        try {
          await execFileP("docker", killCmd, { timeout: 10000 });
        } catch {
          /* noop */
        }
      }
      return { out: "", err: "(docker 操作超时,已强杀)" };
    }
    return { out: "", err: (e as Error).message };
  }
}

export async function dockerAvailable(): Promise<boolean> {
  const r = await runDocker(["info", "--format", "{{.ServerVersion}}"], 15);
  return r.err === null;
}

let _imageChecked = false;
let _imageOk = false;

async function ensureImage(forceRebuild = false): Promise<string | null> {
  if (!forceRebuild && _imageChecked) return _imageOk ? IMAGE_NAME : null;
  if (!forceRebuild) {
    const r = await runDocker(["image", "inspect", IMAGE_NAME, "--format", "{{.Id}}"], 15);
    if (r.err === null) {
      _imageChecked = true;
      _imageOk = true;
      return IMAGE_NAME;
    }
  }
  const dfPath = path.join(HERE, "Dockerfile");
  fs.writeFileSync(dfPath, DOCKERFILE, "utf-8");
  const build = await runDocker(["build", "-t", IMAGE_NAME, "-f", dfPath, HERE], 300);
  _imageChecked = true;
  if (build.err !== null) {
    _imageOk = false;
    return null;
  }
  _imageOk = true;
  return IMAGE_NAME;
}

export async function runInDocker(
  args: string[],
  cwd: string,
  timeout = 30,
  envExtra: Record<string, string> | null = null,
): Promise<{ out: string; err: string | null }> {
  const image = await ensureImage();
  if (image === null) return { out: "", err: "Docker 沙箱不可用: 镜像构建失败" };
  const rel = path.resolve(cwd);
  const name = `ts-sandbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const cmd = ["run", "--rm", "--network", "none", "--memory", "512m", "--cpus", "1"];
  cmd.push("-v", `${rel}:/workspace:rw`, "-w", "/workspace");
  if (envExtra) {
    for (const [k, v] of Object.entries(envExtra)) cmd.push("-e", `${k}=${v}`);
  }
  cmd.push("--name", name, image, ...args);
  const r = await runDocker(cmd, timeout + 15, ["docker", "kill", name]);
  if (r.err !== null) return { out: r.out, err: `Docker 执行失败: ${r.err}` };
  return { out: r.out || "(无输出)", err: null };
}