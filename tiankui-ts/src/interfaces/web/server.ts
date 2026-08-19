import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../app.js";
import type { TiankuiApp } from "../../app.js";
import { SENSITIVE_DIR, WORKSPACE_DIR, settings } from "../../config.js";
import { addRoot, listRoots, removeRoot, setCurrentSession } from "../../core/access.js";
import { audit } from "../../core/audit.js";
import { defaultCatalog } from "../../core/modelpool/catalog.js";
import { poolVendors, refreshModels, testConnection } from "../../core/modelpool/service.js";
import { PoolStore } from "../../core/modelpool/store.js";
import { jsonRes, newToken, readJson, WebSocketServer } from "./ws.js";
import type { WsContext } from "./ws.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(HERE, "..", "..", "..", "static");
const DB_PATH = process.env.TIANKUI_SESSION_DB || path.join(HERE, "..", "..", "..", "tiankui.db");
const HEARTBEAT_INTERVAL = 30;

interface ServerState {
  tiankui: TiankuiApp;
  webToken: string;
  clients: Set<{ sendText: (data: string) => void }>;
}

function buildApp(provider: string | null = null): TiankuiApp {
  return createApp(provider, "", "", true, DB_PATH);
}

function tokenValid(state: ServerState, provided: string): boolean {
  if (state.webToken === "") return true;
  return provided === state.webToken;
}

function bindReview(state: ServerState): void {
  const tiankui = state.tiankui;
  tiankui.review.subscribe((req) => {
    if (!state.clients.size) {
      tiankui.review.decide(req.id, false, "web_no_clients");
      return;
    }
    const payload = { type: "review_request", data: { ...req } };
    for (const c of [...state.clients]) c.sendText(JSON.stringify(payload));
  });
}

let busyChain: Promise<unknown> = Promise.resolve();

function runExclusive(task: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const p = busyChain.then(async () => {
    try {
      return await task();
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  busyChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

export function createWebServer(options: { host?: string; port?: number; provider?: string | null; noToken?: boolean } = {}): Server {
  const clients = new Set<{ sendText: (data: string) => void }>();
  const webToken = options.noToken ? "" : (settings.web_token !== "" ? settings.web_token : newToken());
  const state: ServerState = {
    tiankui: buildApp(options.provider ?? null),
    webToken,
    clients,
  };
  if (!webToken && !options.noToken) {
    console.error(`[web] 未配置 TIANKUI_WEB_TOKEN,已生成随机访问令牌: ${webToken}`);
  }
  bindReview(state);

  const tiankui = state.tiankui;
  tiankui.setEventHandler((agent, event, data) => {
    const payload = { type: "agent_event", agent, event, data };
    for (const c of [...clients]) c.sendText(JSON.stringify(payload));
  });

  const ws = new WebSocketServer();
  const clientByCtx = new Map<WsContext, { sendText: (data: string) => void }>();
  ws.on("message", (text: string, ctx: WsContext) => {
    const tokenCheck = tokenValid(state, ctx.params.get("token") ?? "");
    if (!tokenCheck) {
      ctx.close();
      return;
    }
    let client = clientByCtx.get(ctx);
    if (!client) {
      client = { sendText: ctx.sendText };
      clientByCtx.set(ctx, client);
      state.clients.add(client);
    }
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const send = (payload: Record<string, unknown>) => ctx.sendText(JSON.stringify(payload));
    void handleWsMessage(state, msg, send);
  });
  ws.on("close", (ctx: WsContext) => {
    const client = clientByCtx.get(ctx);
    if (client) {
      state.clients.delete(client);
      clientByCtx.delete(ctx);
    }
  });

  const server = createServer((req, res) => {
    void route(req, res, state, ws);
  });

  server.on("upgrade", (req, socket) => {
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    if (!tokenValid(state, query.get("token") ?? "")) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    ws.handleUpgrade(req, socket as import("node:net").Socket);
  });

  setInterval(() => {
    for (const c of [...clients]) c.sendText(JSON.stringify({ type: "server_ping" }));
  }, HEARTBEAT_INTERVAL * 1000).unref();

  server.on("close", () => {
    state.clients.clear();
  });

  return server;
}

async function handleWsMessage(
  state: ServerState,
  msg: Record<string, any>,
  send: (payload: Record<string, unknown>) => void,
): Promise<void> {
  const tiankui = state.tiankui;
  const msgType = msg.type;
  if (msgType === "ask") {
    const sid = String(msg.session_id ?? "");
    if (sid) tiankui.current_session = sid;
    else if (!tiankui.current_session && tiankui.sessions) tiankui.current_session = tiankui.newSession();
    setCurrentSession(tiankui.current_session || "");
    tiankui.clearCancel();
    send({ type: "task_start" });
    if (tiankui.isBusy()) send({ type: "queued", message: "前一个任务仍在执行,当前任务排队中..." });
const result = await runExclusive(async () => {
      const plan = await tiankui.ask(String(msg.task ?? ""), msg.use_orchestrator !== false);
      return plan as unknown as Record<string, unknown>;
    });
    send({ type: "result", data: result });
  } else if (msgType === "cancel") {
    tiankui.cancel();
    send({ type: "cancelled" });
  } else if (msgType === "review") {
    const ok = tiankui.review.decide(String(msg.review_id ?? ""), Boolean(msg.approve), "web");
    send({ type: "review_result", ok });
  } else if (msgType === "ping" || msgType === "pong" || msgType === "server_pong") {
    send({ type: "pong" });
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
  ws: WebSocketServer,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathName = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && (pathName === "/" || pathName === "/index.html")) {
    return serveFile(res, path.join(STATIC_DIR, "index.html"), "text/html; charset=utf-8");
  }
  if (method === "GET" && pathName.startsWith("/static/")) {
    const rel = pathName.slice("/static/".length);
    const file = path.resolve(STATIC_DIR, rel);
    if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file)) {
      return jsonRes(res, 404, { ok: false, error: "404 Not Found" });
    }
    return serveFile(res, file, contentTypeFor(file));
  }
  if (method === "GET" && pathName === "/healthz") {
    return jsonRes(res, 200, { status: "ok" });
  }

  if (!pathName.startsWith("/api/")) return jsonRes(res, 404, { ok: false, error: "404 Not Found" });
  if (pathName !== "/api/login") {
    const provided = req.headers["x-ts-token"] ?? "";
    if (!tokenValid(state, String(provided))) {
      return jsonRes(res, 401, { ok: false, error: "未授权,请先登录" });
    }
  }

  try {
    if (pathName === "/api/login" && method === "POST") {
      const body = await readJson(req);
      const valid = tokenValid(state, String(body.token ?? ""));
      audit("auth.login", `login ${valid ? "ok" : "failed"}`, "web");
      if (!valid) return jsonRes(res, 401, { ok: false, error: "令牌错误" });
      return jsonRes(res, 200, { ok: true, msg: "登录成功" });
    }

    if (pathName === "/api/state" && method === "GET") {
      return jsonRes(res, 200, state.tiankui.state());
    }

    if (pathName === "/api/access") {
      if (method === "GET") {
        return jsonRes(res, 200, { defaults: [WORKSPACE_DIR, SENSITIVE_DIR], roots: listRoots() });
      }
      const body = await readJson(req);
      const p = String(body.path ?? "");
      const scope = String(body.scope ?? "global");
      try {
        if (method === "POST") {
          return jsonRes(res, 200, { ok: true, msg: addRoot(p, scope) });
        }
        if (method === "DELETE") {
          return jsonRes(res, 200, { ok: true, msg: removeRoot(p, scope) });
        }
      } catch (e) {
        return jsonRes(res, 200, { ok: false, error: (e as Error).message });
      }
    }

    if (pathName === "/api/memory" && method === "GET") {
      const out: Record<string, unknown> = { memory_stats: state.tiankui.memory_stats ?? {} };
      if (state.tiankui.cache_monitor) out.cache = state.tiankui.cache_monitor.summary();
      if (state.tiankui.memory) out.blocks = state.tiankui.memory.blockSummary();
      return jsonRes(res, 200, out);
    }

    if (pathName === "/api/providers" && method === "GET") {
      const providers = settings.providers.map((p) => ({
        name: p.name,
        base_url: p.base_url,
        model: p.model,
        api_key: p.api_key ? `${p.api_key.slice(0, 6)}...` : "",
      }));
      return jsonRes(res, 200, { default: settings.default_provider, providers });
    }

    if (pathName === "/api/provider/switch" && method === "POST") {
      const body = await readJson(req);
      const provider = String(body.provider ?? "");
      let next: TiankuiApp;
      try {
        next = buildApp(provider);
      } catch (e) {
        return jsonRes(res, 200, { ok: false, error: (e as Error).message });
      }
      state.tiankui = next;
      next.setEventHandler((agent, event, data) => {
        const payload = { type: "agent_event", agent, event, data };
        for (const c of [...state.clients]) c.sendText(JSON.stringify(payload));
      });
      bindReview(state);
      return jsonRes(res, 200, { ok: true, provider });
    }

    if (pathName === "/api/sessions" && method === "GET") {
      const t = state.tiankui;
      if (!t.sessions) return jsonRes(res, 200, { sessions: [], current: "" });
      return jsonRes(res, 200, { sessions: t.sessions.listSessions(), current: t.current_session });
    }

    if (pathName === "/api/session" && method === "POST") {
      const body = await readJson(req);
      const t = state.tiankui;
      if (!t.sessions) return jsonRes(res, 200, { ok: false, error: "会话存储未启用" });
      const sid = t.newSession(String(body.title ?? ""));
      return jsonRes(res, 200, { ok: true, session_id: sid });
    }

    if (pathName === "/api/session/switch" && method === "POST") {
      const body = await readJson(req);
      const t = state.tiankui;
      if (!t.sessions) return jsonRes(res, 200, { ok: false, error: "会话存储未启用" });
      const sid = String(body.session_id ?? "");
      if (!t.sessions.getSession(sid)) return jsonRes(res, 200, { ok: false, error: "会话不存在" });
      t.current_session = sid;
      return jsonRes(res, 200, { ok: true, session_id: sid });
    }

    const msgMatch = pathName.match(/^\/api\/session\/([^/]+)\/messages$/);
    if (msgMatch && method === "GET") {
      const t = state.tiankui;
      if (!t.sessions) return jsonRes(res, 200, { messages: [] });
      if (!t.sessions.getSession(msgMatch[1])) return jsonRes(res, 200, { messages: [], error: "会话不存在" });
      return jsonRes(res, 200, { messages: t.sessions.listMessages(msgMatch[1]) });
    }

    if (pathName === "/api/ask" && method === "POST") {
      const body = await readJson(req);
      const t = state.tiankui;
      const sid = String(body.session_id ?? "");
      if (sid) t.current_session = sid;
      else if (!t.current_session && t.sessions) t.current_session = t.newSession();
      setCurrentSession(t.current_session || "");
const result = await runExclusive(async () => {
      const plan = await t.ask(String(body.task ?? ""), body.use_orchestrator !== false);
      return plan as unknown as Record<string, unknown>;
    });
    return jsonRes(res, 200, { ...result });
    }

    if (pathName === "/api/review/decide" && method === "POST") {
      const body = await readJson(req);
      const ok = state.tiankui.review.decide(String(body.review_id ?? ""), Boolean(body.approve), "web");
      return jsonRes(res, 200, { ok });
    }

    if (pathName.startsWith("/api/pool")) {
      return handlePool(req, res, state, url, method);
    }

    return jsonRes(res, 404, { ok: false, error: "404 Not Found" });
  } catch (e) {
    return jsonRes(res, 500, { ok: false, error: (e as Error).message });
  }
}

function poolStore(state: ServerState): PoolStore {
  return state.tiankui.pool_store;
}

function rebindFromStore(t: TiankuiApp): void {
  const store = t.pool_store;
  const data = store.data as Record<string, any>;
  const defaultVendor = String(data.default_vendor ?? "");
  const v = store.vendor(defaultVendor);
  if (!defaultVendor || !v) return;
  const keys = store.keyValues(defaultVendor);
  if (!keys.length) return;
  const cat = defaultCatalog()[defaultVendor] ?? {};
  const base = String(v.base_url || cat.base_url || "");
  const models = (v.refreshed_models as string[]) || (cat.models as string[]) || [];
  if (!models.length) return;
  const model = String(v.model || models[0]);
  const preferred = String((data.preferred_keys ?? {})[defaultVendor] ?? "");
  t.rebindProvider({ name: defaultVendor, baseUrl: base, model, keys, preferredKey: preferred });
}

async function handlePool(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
  url: URL,
  method: string,
): Promise<void> {
  const t = state.tiankui;
  const store = poolStore(state);
  const pathName = url.pathname;

  if (pathName === "/api/pool" && method === "GET") {
    return jsonRes(res, 200, { vendors: poolVendors(store), default: store.data.default_vendor ?? "" });
  }

  if (pathName === "/api/pool/test" && method === "POST") {
    const body = await readJson(req);
    const r = await testConnection(String(body.base_url ?? ""), String(body.model ?? ""), String(body.api_key ?? ""), String(body.api_style ?? "openai"));
    return jsonRes(res, 200, { vendor: body.vendor ?? "", ...r });
  }

  if (pathName === "/api/pool/connect" && method === "POST") {
    const body = await readJson(req);
    const cat = defaultCatalog()[String(body.vendor ?? "")] ?? {};
    const base = String(body.base_url || cat.base_url || "");
    const model = String(body.model || ((cat.models as string[]) && (cat.models as string[]).length ? (cat.models as string[])[0] : ""));
    if (!base || !model) return jsonRes(res, 200, { ok: false, error: "base_url 与 model 不能为空" });
    const apiStyle = String(body.api_style || cat.api_style || "openai");
    const added: string[] = [];
    const tested: Array<Record<string, unknown>> = [];
    const vendor = String(body.vendor ?? "");
    for (const item of body.keys ?? []) {
      const value = String(item.value ?? "").trim();
      if (!value) continue;
      if (body.run_validation !== false) {
        const r = await testConnection(base, model, value, apiStyle);
        tested.push({ key: `${value.slice(0, 6)}...`, ok: r.ok, error: r.error ?? "" });
        if (!r.ok) continue;
      }
      added.push(store.addKey(vendor, value, String(item.label ?? "")));
    }
    if (added.length) {
      store.upsertVendor(vendor, base, String(cat.name ?? vendor));
      store.setModel(vendor, model);
      if (body.set_default !== false) store.setDefault(vendor);
      rebindFromStore(t);
    }
    return jsonRes(res, 200, { ok: added.length > 0, added, tested });
  }

  if (pathName === "/api/pool/keys" && method === "POST") {
    const body = await readJson(req);
    const vendor = String(body.vendor ?? "");
    const action = String(body.action ?? "");
    let ok = false;
    if (action === "add") {
      const value = String(body.value ?? "").trim();
      if (!value) return jsonRes(res, 200, { ok: false, error: "Key 不能为空" });
      store.addKey(vendor, value, String(body.label ?? ""));
      ok = true;
      rebindFromStore(t);
    } else if (action === "remove") {
      ok = store.removeKey(vendor, String(body.kid ?? ""));
      rebindFromStore(t);
    } else if (action === "toggle") {
      ok = store.setKeyEnabled(vendor, String(body.kid ?? ""), Boolean(body.enabled));
      rebindFromStore(t);
    }
    return jsonRes(res, 200, { ok });
  }

  if (pathName === "/api/pool/default" && method === "POST") {
    const body = await readJson(req);
    const vendor = String(body.vendor ?? "");
    store.setDefault(vendor);
    if (body.preferred_key) store.setPreferredKey(vendor, String(body.preferred_key));
    rebindFromStore(t);
    return jsonRes(res, 200, { ok: true, vendor });
  }

  if (pathName === "/api/pool/model" && method === "POST") {
    const body = await readJson(req);
    const vendor = String(body.vendor ?? "");
    store.setModel(vendor, String(body.model ?? ""));
    rebindFromStore(t);
    return jsonRes(res, 200, { ok: true, vendor, model: String(body.model ?? "") });
  }

  if (pathName === "/api/pool/refresh" && method === "POST") {
    const body = await readJson(req);
    const cat = defaultCatalog();
    const targets = body.vendor ? [String(body.vendor)] : Object.keys(store.vendors());
    const results: Array<Record<string, unknown>> = [];
    for (const name of targets) {
      const v = store.vendor(name);
      if (!v) continue;
      const base = String(v.base_url || ((cat[name] ?? {}).base_url as string) || "");
      if (!base) continue;
      let apiKey = "";
      for (const k of store.keyValues(name)) {
        apiKey = String(k.value ?? "");
        break;
      }
      const apiStyle = String((cat[name] ?? {}).api_style || "openai");
      try {
        const models = await refreshModels(base, apiKey, apiStyle);
        store.setRefreshedModels(name, models);
        results.push({ vendor: name, models: models.length, models_list: models });
      } catch (e) {
        results.push({ vendor: name, models: 0, error: (e as Error).message });
      }
    }
    rebindFromStore(t);
    return jsonRes(res, 200, { ok: true, results });
  }

  return jsonRes(res, 404, { ok: false, error: "404 Not Found" });
}

function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };
  return map[ext] ?? "application/octet-stream";
}

function serveFile(res: ServerResponse, file: string, contentType: string): void {
  if (!fs.existsSync(file)) return jsonRes(res, 404, { ok: false, error: "404 Not Found" });
  const data = fs.readFileSync(file);
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": data.length });
  res.end(data);
}