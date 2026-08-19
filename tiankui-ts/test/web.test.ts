import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

const mockTmp = fs.mkdtempSync(path.join(tmpdir(), "ts-web-"));
const wsTmp = fs.mkdtempSync(path.join(tmpdir(), "ts-ws-"));

let mockPort = 0;
let webPort = 0;
let webServer: import("node:http").Server;
let mockServer: import("node:http").Server;
let token = "";

before(async () => {
  const { createMockServer } = await import("../src/interfaces/web/mock_llm.js");
  mockServer = createMockServer("127.0.0.1", 0);
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", () => resolve()));
  mockPort = (mockServer.address() as { port: number }).port;

  process.env.TIANKUI_DEFAULT_PROVIDER = "mock-web";
  process.env.TIANKUI_PROVIDERS = JSON.stringify([
    { name: "mock-web", base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: "", model: "mock-model", timeout: 30, temperature: 0.2, max_tokens: null },
  ]);
  process.env.TIANKUI_WEB_TOKEN = "test-token";
  process.env.TIANKUI_MODELS_JSON = path.join(wsTmp, "models.json");
  process.env.TIANKUI_WORKSPACE = path.join(wsTmp, "ws");
  process.env.TIANKUI_SESSION_DB = path.join(wsTmp, "sessions.db");

  const { createWebServer } = await import("../src/interfaces/web/server.js");
  webServer = createWebServer({ port: 0 });
  await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", () => resolve()));
  webPort = (webServer.address() as { port: number }).port;

  const login = await fetch(`http://127.0.0.1:${webPort}/api/state`, { headers: { "x-ts-token": "test-token" } });
  assert.equal(login.status, 200);
});

after(() => {
  webServer?.close();
  mockServer?.close();
  fs.rmSync(mockTmp, { recursive: true, force: true });
  fs.rmSync(wsTmp, { recursive: true, force: true });
});

async function api(method: string, p: string, body?: unknown, useToken = true): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = useToken ? { "x-ts-token": token || "test-token" } : {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`http://127.0.0.1:${webPort}${p}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: resp.status, data: await resp.json() };
}

test("健康检查与静态首页", async () => {
  const resp = await fetch(`http://127.0.0.1:${webPort}/healthz`);
  assert.equal(resp.status, 200);
  const html = await fetch(`http://127.0.0.1:${webPort}/`);
  assert.equal(html.status, 200);
  const text = await html.text();
  assert.ok(text.includes("WebSocket") || text.length > 1000);
});

test("未授权请求返回 401", async () => {
  const r = await api("GET", "/api/state", undefined, false);
  assert.equal(r.status, 401);
});

test("登录:错误令牌被拒,正确令牌放行", async () => {
  const bad = await api("POST", "/api/login", { token: "wrong" }, false);
  assert.equal(bad.status, 401);
  const good = await api("POST", "/api/login", { token: "test-token" }, false);
  assert.equal(good.status, 200);
  assert.equal(good.data.ok, true);
});

test("state 返回 Agent 与技能列表", async () => {
  const r = await api("GET", "/api/state");
  assert.equal(r.status, 200);
  assert.ok((r.data.agents as string[]).includes("orchestrator"));
  assert.ok(Array.isArray(r.data.skills));
});

test("访问授权:添加与撤销", async () => {
  const dir = path.join(mockTmp, "granted");
  fs.mkdirSync(dir, { recursive: true });
  const add = await api("POST", "/api/access", { path: dir, scope: "global" });
  assert.equal(add.data.ok, true);
  const list = await api("GET", "/api/access");
  assert.ok((list.data.roots as Array<{ path: string }>).some((r) => path.resolve(r.path) === path.resolve(dir)));
  const del = await api("DELETE", "/api/access", { path: dir, scope: "global" });
  assert.equal(del.data.ok, true);
});

test("模型池:厂商列表与 Key 增删", async () => {
  const list = await api("GET", "/api/pool");
  assert.equal(list.status, 200);
  const vendors = list.data.vendors as Array<Record<string, any>>;
  assert.ok(vendors.some((v) => v.key === "openai"));
  const add = await api("POST", "/api/pool/keys", { vendor: "openai", action: "add", value: "sk-test-abcdef123456" });
  assert.equal(add.data.ok, true);
  const list2 = await api("GET", "/api/pool");
  const openai = (list2.data.vendors as Array<Record<string, any>>).find((v) => v.key === "openai")!;
  assert.equal(openai.keys.length, 1);
  assert.ok(!JSON.stringify(openai.keys).includes("sk-test-abcdef123456"));
  const kid = openai.keys[0].id;
  const remove = await api("POST", "/api/pool/keys", { vendor: "openai", action: "remove", kid });
  assert.equal(remove.data.ok, true);
});

test("会话:创建、提问、消息落库", async () => {
  console.error("[T7] start");
  const r = await Promise.race([
    api("POST", "/api/ask", { task: "你好,介绍一下自己", use_orchestrator: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("ask 超时 20s")), 20000)),
  ]);
  console.error("[T7] ask done");
  assert.equal(r.status, 200);
  assert.ok(r.data.summary && String(r.data.summary).length > 0);
  console.error("[T7] sessions before");
  const sessions = await Promise.race([
    api("GET", "/api/sessions"),
    new Promise((_, rej) => setTimeout(() => rej(new Error("sessions 超时 20s")), 20000)),
  ]);
  console.error("[T7] sessions after", JSON.stringify(sessions.data));
  assert.ok((sessions.data.sessions as Array<Record<string, any>>).length >= 1);
  const sid = String((sessions.data.sessions as Array<Record<string, any>>)[0].id);
  console.error("[T7] msgs before");
  const msgs = await Promise.race([
    api("GET", `/api/session/${sid}/messages`),
    new Promise((_, rej) => setTimeout(() => rej(new Error("msgs 超时 20s")), 20000)),
  ]);
  console.error("[T7] msgs after");
  assert.ok((msgs.data.messages as Array<Record<string, any>>).some((m) => m.role === "user"));
  const sw = await api("POST", "/api/session/switch", { session_id: sid });
  assert.equal(sw.data.ok, true);
});

test("WebSocket:任务流与心跳", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws?token=test-token`);
  const received: Record<string, any>[] = [];
  const waitFor = <T>(pred: (msg: any) => boolean, timeoutMs = 15000): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待消息超时")), timeoutMs);
      const check = (msg: any) => {
        if (pred(msg)) {
          clearTimeout(timer);
          ws.removeEventListener("message", onMsg);
          resolve(msg as T);
        }
      };
      const onMsg = (e: MessageEvent) => {
        const data = JSON.parse(String(e.data));
        received.push(data);
        check(data);
      };
      ws.addEventListener("message", onMsg);
    });

  await new Promise<void>((resolve) => {
    ws.addEventListener("open", () => resolve());
  });

  const resultP = waitFor<{ type: string; data: any }>((msg) => msg.type === "result");
  const startP = waitFor<{ type: string }>((msg) => msg.type === "task_start");
  ws.send(JSON.stringify({ type: "ask", task: "用一句话介绍天魁", use_orchestrator: true }));
  const start = await startP;
  assert.equal(start.type, "task_start");
  const result = await resultP;
  assert.ok(result.data.summary && String(result.data.summary).length > 0);

  const pongP = waitFor<{ type: string }>((msg) => msg.type === "pong");
  ws.send(JSON.stringify({ type: "ping" }));
  const pong = await pongP;
  assert.equal(pong.type, "pong");

  ws.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(received.some((m) => m.type === "agent_event"));
});

test("WebSocket:错误令牌被断开", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws?token=bad-token`);
  const closed = new Promise<void>((resolve) => {
    ws.addEventListener("close", () => resolve());
    ws.addEventListener("error", () => resolve());
  });
  await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("未断开")), 5000))]);
});