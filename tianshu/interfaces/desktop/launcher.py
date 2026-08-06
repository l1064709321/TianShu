from __future__ import annotations

import threading
import webbrowser

import uvicorn

from tianshu.interfaces.web.server import app


def run(host: str = "127.0.0.1", port: int = 8000) -> None:
    """启动桌面端:优先原生 WebView 窗口,否则回退浏览器。"""

    def _serve() -> None:
        uvicorn.run(app, host=host, port=port, log_level="warning")

    server_thread = threading.Thread(target=_serve, daemon=True)
    server_thread.start()

    url = f"http://{host}:{port}/"
    try:
        import webview  # type: ignore

        webview.create_window("天枢", url, width=1080, height=720, min_size=(720, 480))
        webview.start()
    except ImportError:
        webbrowser.open(url)
        server_thread.join()
