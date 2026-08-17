import { createServer } from "node:http";
import type { Server } from "node:http";
import { jsonRes, readJson } from "./ws.js";

function pickToolFn(name: string, lastUser: string): Record<string, unknown> {
  if (name === "call_agent") return { agent: "assistant", task: lastUser };
  if (name === "fetch_url") {
    const m = /https?:\/\/\S+/.exec(lastUser);
    return { url: m ? m[0] : "https://example.com" };
  }
  if (name === "read_file") return { path: "workspace/test.txt" };
  if (name === "write_file") return { path: "workspace/test.txt", content: lastUser };
  if (name === "run_shell") return { command: "echo mock" };
  if (name === "load_skill") return { name: "chat" };
  if (name === "produce_plan") return { subtasks: [{ worker: "assistant", goal: lastUser }] };
  if (name === "list_dir") return {};
  return {};
}

function containsToolResult(messages: Array<Record<string, any>>): boolean {
  return messages.some((m) => m.role === "tool");
}

function response(content: string | null, toolCalls: unknown[] | null = null, reasoning: string | null = null): Record<string, unknown> {
  const msg: Record<string, unknown> = {};
  if (content !== null) msg.content = content;
  if (toolCalls) msg.tool_calls = toolCalls;
  if (reasoning) msg.reasoning_content = reasoning;
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    choices: [{ index: 0, message: msg, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 1,
      total_tokens: 101,
      prompt_tokens_details: { cached_tokens: 60 },
      prompt_cache_hit_tokens: 60,
      prompt_cache_miss_tokens: 40,
    },
  };
}

export function createMockServer(host = "127.0.0.1", port = 9100): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      return jsonRes(res, 200, { status: "ok" });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJson(req);
      const messages: Array<Record<string, any>> = body.messages ?? [];
      const tools: Array<Record<string, any>> = body.tools ?? [];
      let lastUser = "";
      for (const m of [...messages].reverse()) {
        if ((m.role === "user" || m.role === "tool") && typeof m.content === "string") {
          lastUser = m.content;
          break;
        }
      }
      const toolNames = tools.map((t) => t.function?.name).filter(Boolean);
      const hasUserMsg = messages.some((m) => m.role === "user");
      if (toolNames.length && hasUserMsg && !containsToolResult(messages)) {
        const first = toolNames[0];
        const fn = pickToolFn(String(first), lastUser);
        return jsonRes(
          res,
          200,
          response(null, [
            { id: "call_mock_1", type: "function", function: { name: String(first), arguments: JSON.stringify(fn) } },
          ], `用户请求「${lastUser.slice(0, 60)}」,需要获取更多信息,我选择调用工具 ${first} 来完成任务。`),
        );
      }
      return jsonRes(res, 200, response(`[mock 回复] 收到: ${lastUser.slice(0, 100)}`, null, `用户请求「${lastUser.slice(0, 60)}」,信息已足够,我直接整理回答。`));
    }
    return jsonRes(res, 404, { ok: false, error: "404 Not Found" });
  });
}