#!/usr/bin/env node
import { Command } from "commander";
import { createApp } from "../app.js";
import { availableProviders } from "../core/llm/factory.js";

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

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
