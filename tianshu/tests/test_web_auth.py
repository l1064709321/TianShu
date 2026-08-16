from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tianshu.config import settings
from tianshu.interfaces.web.server import app


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, "web_token", "test-token")
    with TestClient(app) as c:
        yield c


def test_api_rejects_without_token(client):
    r = client.get("/api/state")
    assert r.status_code == 401


def test_api_rejects_wrong_token(client):
    r = client.get("/api/state", headers={"X-TS-Token": "wrong"})
    assert r.status_code == 401


def test_api_accepts_correct_token(client):
    r = client.get("/api/state", headers={"X-TS-Token": "test-token"})
    assert r.status_code == 200
    assert "agents" in r.json()


def test_login_endpoint(client):
    assert client.post("/api/login", json={"token": "nope"}).status_code == 401
    ok = client.post("/api/login", json={"token": "test-token"})
    assert ok.status_code == 200 and ok.json()["ok"]


def test_static_and_index_unprotected(client):
    assert client.get("/").status_code == 200
    assert client.get("/static/index.html").status_code == 200


def test_websocket_requires_token(client):
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as exc, client.websocket_connect("/ws") as ws:
        ws.receive_json()
    assert exc.value.code == 1008


def test_websocket_accepts_token(client):
    with client.websocket_connect("/ws?token=test-token") as ws:
        ws.send_json({"type": "ping"})
        got = ws.receive_json()
        assert got  # 未立刻被关闭即视为通过


def test_auto_generated_token_when_unset(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "web_token", "")
    with TestClient(app) as c:
        assert c.app.state.web_token
        assert c.get("/api/state", headers={"X-TS-Token": c.app.state.web_token}).status_code == 200