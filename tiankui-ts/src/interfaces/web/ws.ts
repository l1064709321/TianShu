import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { EventEmitter } from "node:events";

export interface WsContext {
  url: URL;
  params: URLSearchParams;
  sendText(data: string): void;
  close(): void;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WebSocketServer extends EventEmitter {
  handleUpgrade(req: IncomingMessage, socket: Socket): void {
    const key = req.headers["sec-websocket-key"];
    if (!key || req.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(String(key) + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this._attach(socket, req.url ? new URL(req.url, "http://localhost") : new URL("http://localhost/"));
  }

  private _attach(socket: Socket, url: URL): void {
    const self = this;
    let buffer = Buffer.alloc(0);
    let closed = false;

    const send = (opcode: number, payload: Buffer | string): void => {
      if (closed) return;
      const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
      const len = data.length;
      let frame: Buffer;
      if (len < 126) {
        frame = Buffer.alloc(2 + len);
        frame[1] = len;
      } else if (len < 65536) {
        frame = Buffer.alloc(4 + len);
        frame[1] = 126;
        frame.writeUInt16BE(len, 2);
      } else {
        frame = Buffer.alloc(10 + len);
        frame[1] = 127;
        frame.writeBigUInt64BE(BigInt(len), 2);
      }
      frame[0] = 0x80 | opcode;
      data.copy(frame, frame.length - len);
      socket.write(frame);
    };

    const terminate = (): void => {
      if (closed) return;
      closed = true;
      try {
        send(0x8, Buffer.from([0x03, 0xe8]));
      } catch {
        /* noop */
      }
      socket.destroy();
      self.emit("close", ctx);
    };

    const ctx: WsContext = {
      url,
      params: url.searchParams,
      sendText: (data: string) => send(0x1, data),
      close: () => terminate(),
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          const big = buffer.readBigUInt64BE(2);
          if (big > BigInt(Number.MAX_SAFE_INTEGER)) return terminate();
          len = Number(big);
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buffer.length < offset + maskLen + len) return;
        let payload = buffer.subarray(offset + maskLen, offset + maskLen + len);
        if (masked) {
          const maskKey = buffer.subarray(offset, offset + 4);
          const unmasked = Buffer.alloc(len);
          for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
          payload = unmasked;
        }
        buffer = buffer.subarray(offset + maskLen + len);

        if (opcode === 0x8) {
          return terminate();
        }
        if (opcode === 0x9) {
          send(0xa, payload);
          if (fin) continue;
        }
        if (opcode === 0xa) continue;
        if (opcode === 0x1 || opcode === 0x0) {
          const text = payload.toString("utf-8");
          if (!fin) continue;
          self.emit("message", text, ctx);
        }
      }
    });

    socket.on("error", () => terminate());
    socket.on("close", () => terminate());
  }
}

export function upgradeRequest(req: IncomingMessage, ws: WebSocketServer): void {
  ws.handleUpgrade(req, req.socket as Socket);
  (req.socket as Socket).pause();
  (req.socket as Socket).resume();
}

export function isWsUpgrade(req: IncomingMessage): boolean {
  return (req.headers.upgrade ?? "").toLowerCase() === "websocket";
}

export async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("JSON 解析失败");
  }
}

export function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

export function textRes(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export function maskKey(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return value.slice(0, 4) + "...";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}