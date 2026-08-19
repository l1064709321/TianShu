#!/usr/bin/env node
import { Command } from "commander";
import { createApp } from "../app.js";
import { availableProviders } from "../core/llm/factory.js";
import type { ReviewRequest } from "../core/review/system.js";

async function ensureMockLlmIfNeeded(): Promise<boolean> {
  const { settings } = await import("../config.js");
  const cfg = settings.providers.find((p) => p.name === settings.default_provider) ?? settings.providers[0];
  if (cfg.name !== "mock") return true;
  const url = new URL(cfg.base_url);
  const host = url.hostname || "127.0.0.1";
  const port = url.port ? Number(url.port) : 9100;
  const base = `http://${host}:${port}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    const resp = await fetch(`${base}/healthz`, { signal: controller.signal });
    clearTimeout(timer);
    if (resp.ok) return true;
  } catch {
    /* mockllm 未运行 */
  }
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const entry = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", entry, "mockllm", "--host", host, "--port", String(port)], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const resp = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) {
        console.log(`==> mockllm 已自动就绪: ${base}(离线 mock 模式)`);
        return true;
      }
    } catch {
      /* 继续等待 */
    }
  }
  return false;
}

const program = new Command();

program
  .name("tianshu")
  .description("天枢 - 多 Agent 协同系统")
  .version("0.1.0");

program
  .command("ask <prompt>")
  .description("单次提问,由主 Agent 调度子 Agent 执行")
  .option("--provider <name>", "LLM provider 名称")
  .option("--model <name>", "模型名称")
  .option("--direct", "不走主 Agent 调度(直接问答)")
  .option("--review <mode>", "审核模式: manual/auto_approve/auto_reject", "manual")
  .option("--serial", "串行执行子任务")
  .action(async (prompt, opts) => {
    const app = createApp(
      opts.provider || null,
      opts.model || "",
      opts.review,
      !opts.serial,
    );
    const plan = await app.ask(prompt, !opts.direct);
    if (plan.subtasks.length) {
      for (const st of plan.subtasks) {
        const statusColor = st.status === "done" ? "ok" : "warn";
        console.log(`\n[${statusColor}] 子任务 ${st.id}: ${st.worker} - ${st.goal}`);
        console.log(`  状态: ${st.status}`);
        if (st.result?.content) console.log(`  结果: ${st.result.content.slice(0, 2000)}`);
        else if (st.error) console.log(`  错误: ${st.error}`);
      }
    }
    console.log(`\n${plan.summary || "(无输出)"}`);
  });

program
  .command("chat")
  .description("交互式聊天,支持多轮对话、Agent 协同与终端内联审批")
  .option("--provider <name>", "LLM provider 名称")
  .option("--model <name>", "模型名称")
  .option("--review <mode>", "审核模式: manual/auto_approve/auto_reject", "manual")
  .action(async (opts) => {
    const app = createApp(opts.provider || null, opts.model || "", opts.review);
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
    const lineQueue: Array<(line: string) => void> = [];
    const taskQueue: string[] = [];
    let taskRunning = false;
    let stdinDone = false;
    rl.on("line", (line) => {
      const waiter = lineQueue.shift();
      if (waiter) {
        waiter(line);
        return;
      }
      taskQueue.push(line);
      void drainTasks();
    });
    rl.on("close", () => {
      stdinDone = true;
      for (const w of lineQueue.splice(0)) w("");
      void drainTasks();
    });
    async function drainTasks() {
      if (taskRunning) return;
      taskRunning = true;
      while (taskQueue.length) {
        const line = taskQueue.shift()!;
        await handleLine(line);
      }
      taskRunning = false;
      if (stdinDone && !process.exitCode) process.exit(0);
    }
    const nextLine = (promptText: string): Promise<string> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(""), 60000);
        rl.setPrompt(promptText);
        rl.prompt();
        lineQueue.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      });
    const sessionChoices = new Map<string, boolean>();
    app.review.subscribe((req) => {
      const remembered = sessionChoices.get(req.tool);
      if (remembered !== undefined) {
        app.review.decide(req.id, remembered, "session");
        return;
      }
      void approvePrompt(req);
    });
    async function approvePrompt(req: ReviewRequest) {
      console.log(yellow(`\n⚠ 高危操作待审批: ${req.agent} 调用 ${req.tool}${req.reason ? ` — ${req.reason}` : ""}`));
      const pending = app.review.pending();
      if (pending.length > 1) {
        console.log(yellow(`   当前共有 ${pending.length} 项待审批,输入 /pending 查看全部`));
      }
      while (true) {
        const answer = (await nextLine("审批[y/a/n/d]> ")).trim();
        if (answer === "y") {
          app.review.decide(req.id, true, "cli_once");
          return;
        }
        if (answer === "a") {
          sessionChoices.set(req.tool, true);
          app.review.decide(req.id, true, "cli_session");
          console.log(`已记住:本会话内 ${req.tool} 自动批准`);
          return;
        }
        if (answer === "d") {
          sessionChoices.set(req.tool, false);
          app.review.decide(req.id, false, "cli_session");
          console.log(`已记住:本会话内 ${req.tool} 自动拒绝`);
          return;
        }
        if (answer === "p") {
          for (const p of app.review.pending()) console.log(`     · ${p.id} ${p.agent}.${p.tool}`);
          continue;
        }
        app.review.decide(req.id, false, "cli_reject");
        return;
      }
    }
    async function handleLine(raw: string) {
      const line = raw.trim();
      if (!line) return;
      if (["/exit", "/quit"].includes(line)) {
        rl.close();
        return;
      }
      if (line === "/agents") {
        console.log([...app.agents.keys()].join(", "));
        return;
      }
      if (line === "/skills") {
        console.log(app.skills.descriptions() || "(无)");
        return;
      }
      if (line === "/pending") {
        const pending = app.review.pending();
        console.log(pending.length ? pending.map((p) => `· ${p.id} ${p.agent}.${p.tool}`).join("\n") : "(无待审批)");
        return;
      }
      const m = line.match(/^\/(approve|reject)\s+(.+)/);
      if (m) {
        const ok = app.review.decide(m[2], m[1] === "approve", "cli_cmd");
        console.log(`审批 ${ok ? "成功" : "失败(不存在或已处理)"}`);
        return;
      }
      const plan = await app.ask(line, true);
      for (const st of plan.subtasks) {
        console.log(`· ${st.worker}: ${st.status}`);
      }
      console.log(plan.summary || "(无输出)");
    }
    console.log(
      "天枢已就绪。输入任务开始;/exit 退出;/agents 查看 Agent;/skills 查看技能;/pending 查看待审批;" +
        "审批提示输入 y(批准一次) a(本会话总是批准) n(拒绝) d(本会话总是拒绝)",
    );
    rl.setPrompt("你> ");
    rl.prompt();
  });

program
  .command("state")
  .description("查看系统状态: Agent、技能、待审批")
  .option("--provider <name>", "LLM provider 名称")
  .action((opts) => {
    const app = createApp(opts.provider || null);
    console.log(JSON.stringify(app.state(), null, 2));
  });

program
  .command("providers")
  .description("列出支持的 LLM 厂商")
  .action(() => {
    console.log("支持的 provider:", availableProviders().join(", "));
  });

program
  .command("config")
  .description("查看或配置模型(.env 持久化;密钥仅显示掩码)")
  .option("--provider <name>", "设置默认厂商")
  .option("--base-url <url>", "设置 API 地址")
  .option("--api-key <key>", "设置密钥")
  .option("--model <name>", "设置模型名")
  .option("--list", "列出支持的厂商")
  .action(async (opts) => {
    const { ENV_FILE, writeEnvFile } = await import("../config.js");
    if (opts.list) {
      console.log("支持的 provider:", availableProviders().join(", "));
      return;
    }
    const updates: Array<[string, string]> = [];
    if (opts.provider) updates.push(["TIANSHU_DEFAULT_PROVIDER", opts.provider]);
    if (opts.baseUrl) updates.push(["TIANSHU_DEFAULT_PROVIDER_BASE_URL", opts.baseUrl]);
    if (opts.apiKey) updates.push(["TIANSHU_DEFAULT_PROVIDER_API_KEY", opts.apiKey]);
    if (opts.model) updates.push(["TIANSHU_DEFAULT_PROVIDER_MODEL", opts.model]);
    if (updates.length) {
      writeEnvFile(updates);
      console.log(`已写入 ${ENV_FILE}:`);
      for (const [k, v] of updates) console.log(`  ${k}=${k.includes("KEY") ? v.slice(0, 4) + "****" : v}`);
      console.log("重启后生效(或下次启动自动读取)");
      return;
    }
    const { settings } = await import("../config.js");
    const p = settings.default_provider;
    const cfg = settings.providers.find((x) => x.name === p) ?? settings.providers[0];
    if (!cfg) {
      console.log("未配置 provider,请使用 --provider/--base-url/--api-key/--model 配置");
      return;
    }
    const mask = cfg.api_key ? cfg.api_key.slice(0, 4) + "****" + cfg.api_key.slice(-4) : "(空)";
    console.log(`配置文件: ${ENV_FILE}`);
    console.log(`默认厂商: ${p}`);
    console.log(`API 地址: ${cfg.base_url}`);
    console.log(`模型名  : ${cfg.model}`);
    console.log(`密钥    : ${mask}`);
    console.log("修改: tianshu config --provider <name> --base-url <url> --api-key <key> --model <name>");
  });

program
  .command("mockllm")
  .description("启动本地 mock LLM 服务(OpenAI 兼容)")
  .option("--host <host>", "监听地址", "127.0.0.1")
  .option("--port <port>", "监听端口", "9100")
  .action(async (opts) => {
    const { createMockServer } = await import("../interfaces/web/mock_llm.js");
    const server = createMockServer(opts.host, Number(opts.port));
    server.listen(Number(opts.port), opts.host, () => {
      console.log(`mock LLM 服务已启动: http://${opts.host}:${opts.port}`);
    });
  });

program
  .command("web")
  .description("启动 Web 面板(默认端口 7800,provider 为 mock 时自动拉起 mockllm)")
  .option("--host <host>", "监听地址", "127.0.0.1")
  .option("--port <port>", "监听端口", "7800")
  .option("--provider <name>", "LLM provider 名称")
  .option("--no-auto-mock", "禁用自动拉起 mockllm")
  .action(async (opts) => {
    const { settings } = await import("../config.js");
    if (opts.autoMock) {
      const ok = await ensureMockLlmIfNeeded();
      if (!ok) console.error("警告: mockllm 启动失败,对话将不可用,请检查端口占用");
    }
    const { createWebServer } = await import("../interfaces/web/server.js");
    const server = createWebServer({ host: opts.host, port: Number(opts.port), provider: opts.provider || null });
    server.listen(Number(opts.port), opts.host, () => {
      console.log(`天枢 Web 面板: http://${opts.host}:${opts.port}/`);
    });
  });

program
  .command("doctor")
  .description("检查配置与模型连接是否正常")
  .option("--timeout <seconds>", "连接测试超时(秒)", "15")
  .action(async (opts) => {
    const { getProvider } = await import("../config.js");
    const { createProvider } = await import("../core/llm/factory.js");
    const cfg = getProvider();
    console.log(`当前默认 Provider: ${cfg.name}`);
    console.log(`  base_url: ${cfg.base_url}`);
    console.log(`  model:    ${cfg.model}`);
    console.log(`  api_key:  ${cfg.api_key ? "已配置 " + cfg.api_key.slice(0, 8) + "..." : "(未配置)"}`);
    const provider = createProvider(cfg.name, cfg.base_url, cfg.model, cfg.api_key, {
      temperature: cfg.temperature,
      max_tokens: cfg.max_tokens,
      timeout: Number(opts.timeout),
    });
    try {
      const result = await provider.chat([{ role: "user", content: "回复'连接正常'四个字即可" }]);
      console.log(`连接正常,模型回复: ${(result.content ?? "").slice(0, 200)}`);
    } catch (e) {
      console.error(`连接失败: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("desktop")
  .description("桌面端:启动 Web 服务并打开浏览器窗口")
  .option("--host <host>", "监听地址", "127.0.0.1")
  .option("--port <port>", "监听端口", "7800")
  .option("--provider <name>", "LLM provider 名称")
  .action(async (opts) => {
    const { launchDesktop } = await import("../interfaces/desktop/launcher.js");
    await launchDesktop(opts.host, Number(opts.port), opts.provider || null);
  });

program
  .command("start")
  .description("一键启动:自动找可用端口(8000~8999),拉起 mock LLM + Web 面板")
  .option("--host <host>", "监听地址", "127.0.0.1")
  .option("--port <port>", "Web 面板起始端口", "8000")
  .option("--mock-port <port>", "Mock LLM 端口", "9100")
  .option("--provider <name>", "LLM provider 名称(默认 auto)")
  .action(async (opts) => {
    const net = await import("node:net");
    const findPort = (start: number): Promise<number> =>
      new Promise((resolve, reject) => {
        let cur = start;
        const tryNext = () => {
          if (cur - start > 999) return reject(new Error("未找到可用端口(8000-8999)"));
          const s = net.createServer();
          s.once("error", () => { cur++; tryNext(); });
          s.listen(cur, opts.host, () => { s.close(); resolve(cur); });
        };
        tryNext();
      });
    const { settings } = await import("../config.js");
    const provider = opts.provider || (settings.default_provider === "mock" ? "mock" : null);
    if (!provider) console.log("未配置 provider,启动 mock 模式...");
    const mockPort = Number(opts.mockPort);
    const { createMockServer } = await import("../interfaces/web/mock_llm.js");
    const mockServer = createMockServer(opts.host, mockPort);
    await new Promise<void>((resolve) => mockServer.listen(mockPort, opts.host, () => resolve()));
    console.log(`Mock LLM 已启动: http://${opts.host}:${mockPort}`);
    const webPort = await findPort(Number(opts.port));
    const { createWebServer } = await import("../interfaces/web/server.js");
    const server = createWebServer({ host: opts.host, port: webPort, provider });
    await new Promise<void>((resolve) => server.listen(webPort, opts.host, () => resolve()));
    console.log(`天枢已就绪: http://${opts.host}:${webPort}/`);
    console.log("输入 Ctrl+C 退出");
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
