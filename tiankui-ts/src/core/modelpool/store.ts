import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "../../config.js";

const EMPTY_STORE: Record<string, unknown> = {
  vendors: {},
  default_vendor: "",
  preferred_keys: {},
};

export function keyId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function maskKey(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return value.slice(0, 4) + "...";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

const STORE_PATH = path.join(PROJECT_ROOT, "config", "models.json");

export class PoolStore {
  path: string;
  data: Record<string, any>;

  constructor(storePath: string | null = null) {
    this.path = storePath ?? process.env.TIANKUI_MODELS_JSON ?? STORE_PATH;
    this.data = JSON.parse(JSON.stringify(EMPTY_STORE));
    this.load();
  }

  load(): void {
    if (!fs.existsSync(this.path)) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      this.save();
      return;
    }
    try {
      this.data = JSON.parse(fs.readFileSync(this.path, "utf-8"));
    } catch {
      this.data = JSON.parse(JSON.stringify(EMPTY_STORE));
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
    fs.renameSync(tmp, this.path);
  }

  vendor(name: string): Record<string, any> | null {
    return this.data.vendors?.[name] ?? null;
  }

  vendors(): Record<string, Record<string, any>> {
    return this.data.vendors ?? {};
  }

  private ensureVendor(name: string): Record<string, any> {
    if (!this.data.vendors) this.data.vendors = {};
    if (!this.data.vendors[name]) {
      this.data.vendors[name] = { name, base_url: "", keys: [], models_refreshed_at: 0, refreshed_models: [] };
    }
    return this.data.vendors[name];
  }

  upsertVendor(name: string, baseUrl: string, vendorName = ""): Record<string, any> {
    const v = this.ensureVendor(name);
    v.base_url = baseUrl;
    if (vendorName) v.name = vendorName;
    this.data.vendors[name] = v;
    this.save();
    return v;
  }

  addKey(name: string, value: string, label = ""): string {
    value = (value ?? "").trim();
    if (!value) throw new Error("Key 不能为空");
    const v = this.ensureVendor(name);
    const kid = keyId(value);
    for (const k of v.keys ?? []) {
      if (k.id === kid) {
        k.enabled = true;
        k.status = "unknown";
        this.save();
        return kid;
      }
    }
    v.keys = v.keys ?? [];
    v.keys.push({
      id: kid,
      value,
      label,
      enabled: true,
      status: "unknown",
      checked_at: 0.0,
      added_at: Date.now() / 1000,
    });
    this.save();
    return kid;
  }

  removeKey(name: string, kid: string): boolean {
    const v = this.data.vendors?.[name];
    if (!v) return false;
    const before = (v.keys ?? []).length;
    v.keys = (v.keys ?? []).filter((k: Record<string, any>) => k.id !== kid);
    const changed = v.keys.length !== before;
    if (changed) this.save();
    return changed;
  }

  setKeyEnabled(name: string, kid: string, enabled: boolean): boolean {
    const v = this.data.vendors?.[name];
    if (!v) return false;
    for (const k of v.keys ?? []) {
      if (k.id === kid) {
        k.enabled = enabled;
        this.save();
        return true;
      }
    }
    return false;
  }

  touchKey(name: string, kid: string, status: string, error = ""): void {
    const v = this.data.vendors?.[name];
    if (!v) return;
    for (const k of v.keys ?? []) {
      if (k.id === kid) {
        k.status = status;
        k.checked_at = Date.now() / 1000;
        if (error) k.last_error = error.slice(0, 200);
        else if ("last_error" in k) delete k.last_error;
        this.save();
        return;
      }
    }
  }

  setRefreshedModels(name: string, models: string[]): void {
    const v = this.ensureVendor(name);
    v.refreshed_models = models;
    v.models_refreshed_at = Date.now() / 1000;
    this.save();
  }

  setModel(name: string, model: string): void {
    const v = this.ensureVendor(name);
    v.model = model;
    this.save();
  }

  setDefault(name: string): void {
    this.data.default_vendor = name;
    this.save();
  }

  setPreferredKey(name: string, kid: string): void {
    this.data.preferred_keys = this.data.preferred_keys ?? {};
    this.data.preferred_keys[name] = kid;
    this.save();
  }

  keyValues(name: string): Array<Record<string, any>> {
    const v = this.data.vendors?.[name];
    return ((v?.keys ?? []) as Array<Record<string, any>>)
      .filter((k) => k.enabled)
      .map((k) => ({ ...k }));
  }
}