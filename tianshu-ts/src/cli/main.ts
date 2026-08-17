#!/usr/bin/env node
import { Command } from "commander";
import { createApp } from "../app.js";
import { availableProviders } from "../core/llm/factory.js";

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
  .description("交互式聊天,支持多轮对话与 Agent 协同")
  .option("--provider <name>", "LLM provider 名称")
  .option("--model <name>", "模型名称")
  .option("--review <mode>", "审核模式", "manual")
  .action(async (opts) => {
    const app = createApp(opts.provider || null, opts.model || "", opts.review);
    console.log("天枢已就绪。输入任务开始,输入 /exit 退出,输入 /agents 查看 Agent,/skills 查看技能,/approve <id> 批准审核");
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    while (true) {
      const line = (await rl.question("你> ")).trim();
      if (!line) continue;
      if (["/exit", "/quit"].includes(line)) break;
      if (line === "/agents") {
        console.log([...app.agents.keys()].join(", "));
        continue;
      }
      if (line === "/skills") {
        console.log(app.skills.descriptions() || "(无)");
        continue;
      }
      if (line.startsWith("/approve ")) {
        const rid = line.split(" ").pop()!;
        const ok = app.review.decide(rid, true);
        console.log(`审批 ${ok ? "成功" : "失败(不存在或已处理)"}`);
        continue;
      }
      const plan = await app.ask(line, true);
      for (const st of plan.subtasks) {
        console.log(`· ${st.worker}: ${st.status}`);
      }
      console.log(plan.summary || "(无输出)");
    }
    rl.close();
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

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
