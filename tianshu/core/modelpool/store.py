from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path
from typing import Any

from tianshu.core.log import get_logger

logger = get_logger("modelpool.store")

CONFIG_DIR = Path(__file__).resolve().parent.parent.parent.parent / "config"
STORE_PATH = CONFIG_DIR / "models.json"

EMPTY_STORE: dict[str, Any] = {
    "vendors": {},
    "default_vendor": "",
    "preferred_keys": {},
}


def key_id(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:12]


def mask_key(value: str) -> str:
    if len(value) <= 8:
        return value[:4] + "..." if value else ""
    return f"{value[:6]}...{value[-4:]}"


class PoolStore:
    """config/models.json 持久化:每个厂商可配多个 Key,支持启用/停用。"""

    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path) if path else STORE_PATH
        self._lock = threading.RLock()
        self.data: dict[str, Any] = json.loads(json.dumps(EMPTY_STORE))
        self.load()

    def load(self) -> None:
        with self._lock:
            if not self.path.exists():
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self.save()
                return
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                logger.exception("models.json 解析失败,使用空配置")
                self.data = json.loads(json.dumps(EMPTY_STORE))

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self.path)

    def vendor(self, name: str) -> dict[str, Any] | None:
        return self.data["vendors"].get(name)

    def vendors(self) -> dict[str, dict[str, Any]]:
        return self.data["vendors"]

    def upsert_vendor(self, name: str, base_url: str, vendor_name: str = "") -> dict[str, Any]:
        with self._lock:
            v = self.data["vendors"].setdefault(name, {"name": vendor_name or name, "base_url": base_url, "keys": [], "models_refreshed_at": 0, "refreshed_models": []})
            v["base_url"] = base_url
            if vendor_name:
                v["name"] = vendor_name
            self.data["vendors"][name] = v
            self.save()
            return v

    def add_key(self, name: str, value: str, label: str = "") -> str:
        value = value.strip()
        if not value:
            raise ValueError("Key 不能为空")
        with self._lock:
            v = self.data["vendors"].setdefault(name, {"name": name, "base_url": "", "keys": [], "models_refreshed_at": 0, "refreshed_models": []})
            kid = key_id(value)
            for k in v["keys"]:
                if k["id"] == kid:
                    k["enabled"] = True
                    k["status"] = "unknown"
                    self.save()
                    return kid
            v["keys"].append(
                {
                    "id": kid,
                    "value": value,
                    "label": label,
                    "enabled": True,
                    "status": "unknown",
                    "checked_at": 0.0,
                    "added_at": time.time(),
                }
            )
            self.save()
            return kid

    def remove_key(self, name: str, kid: str) -> bool:
        with self._lock:
            v = self.data["vendors"].get(name)
            if not v:
                return False
            before = len(v["keys"])
            v["keys"] = [k for k in v["keys"] if k["id"] != kid]
            changed = len(v["keys"]) != before
            if changed:
                self.save()
            return changed

    def set_key_enabled(self, name: str, kid: str, enabled: bool) -> bool:
        with self._lock:
            v = self.data["vendors"].get(name)
            if not v:
                return False
            for k in v["keys"]:
                if k["id"] == kid:
                    k["enabled"] = enabled
                    self.save()
                    return True
            return False

    def touch_key(self, name: str, kid: str, status: str, error: str = "") -> None:
        with self._lock:
            v = self.data["vendors"].get(name)
            if not v:
                return
            for k in v["keys"]:
                if k["id"] == kid:
                    k["status"] = status
                    k["checked_at"] = time.time()
                    if error:
                        k["last_error"] = error[:200]
                    elif "last_error" in k:
                        k.pop("last_error", None)
                    self.save()
                    return

    def set_refreshed_models(self, name: str, models: list[str]) -> None:
        with self._lock:
            v = self.data["vendors"].setdefault(name, {"name": name, "base_url": "", "keys": [], "models_refreshed_at": 0, "refreshed_models": []})
            v["refreshed_models"] = models
            v["models_refreshed_at"] = time.time()
            self.save()

    def set_model(self, name: str, model: str) -> None:
        with self._lock:
            v = self.data["vendors"].setdefault(name, {"name": name, "base_url": "", "keys": [], "models_refreshed_at": 0, "refreshed_models": []})
            v["model"] = model
            self.save()

    def set_default(self, name: str) -> None:
        with self._lock:
            self.data["default_vendor"] = name
            self.save()

    def set_preferred_key(self, name: str, kid: str) -> None:
        with self._lock:
            self.data["preferred_keys"][name] = kid
            self.save()

    def key_values(self, name: str) -> list[dict[str, Any]]:
        v = self.data["vendors"].get(name)
        return [dict(k) for k in (v or {}).get("keys", []) if k.get("enabled")]