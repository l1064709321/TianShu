import { createWebServer } from "../web/server.js";

export async function launchDesktop(host = "127.0.0.1", port = 7800, provider: string | null = null): Promise<void> {
  const server = createWebServer({ host, port, provider });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${port}/`;
  console.log(`天枢桌面端已启动: ${url}`);
  const { exec } = await import("node:child_process");
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    await new Promise<void>((resolve) => exec(`${cmd} "${url}"`, () => resolve()));
  } catch {
    console.error("无法自动打开浏览器,请手动访问: " + url);
  }
}