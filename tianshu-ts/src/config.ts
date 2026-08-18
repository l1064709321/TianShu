import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, "../..");
export const TS_ROOT = path.resolve(here, "..");
export const SKILLS_DIR = process.env.TIANSHU_SKILLS_DIR || path.join(TS_ROOT, "skills");
export const WORKSPACE_DIR = process.env.TIANSHU_WORKSPACE
  ? path.resolve(process.env.TIANSHU_WORKSPACE)
  : path.join(PROJECT_ROOT, "workspace");
export const SENSITIVE_DIR = path.join(WORKSPACE_DIR, ".ts-secrets");

const ENV_FILE = process.env.TIANSHU_ENV || path.join(PROJECT_ROOT, ".env");

function loadEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const content = fs.readFileSync(file, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      out[key] = value;
    }
  } catch {
    // env 文件不存在时忽略
  }
  return out;
}

export interface LLMProviderConfig {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  timeout: number;
  max_tokens: number | null;
}

export interface Settings {
  app_name: string;
  providers: LLMProviderConfig[];
  default_provider: string;
  mode: "full" | "headless";
  web_token: string;
}

function readSettings(): Settings {
  const env = { ...loadEnvFile(ENV_FILE), ...process.env };
  const pick = (key: string): string => env[`TIANSHU_${key}`] ?? "";

  let providers: LLMProviderConfig[] = [];
  const rawProviders = pick("PROVIDERS");
  if (rawProviders) {
    try {
      providers = JSON.parse(rawProviders);
    } catch {
      providers = [];
    }
  }
  if (!providers.length) {
    providers = [
      {
        name: pick("DEFAULT_PROVIDER") || "mock",
        base_url: pick("DEFAULT_PROVIDER_BASE_URL") || "http://localhost:9100/v1",
        api_key: pick("DEFAULT_PROVIDER_API_KEY") || "",
        model: pick("DEFAULT_PROVIDER_MODEL") || "mock-model",
        temperature: Number(pick("DEFAULT_PROVIDER_TEMPERATURE") || 0.2),
        timeout: Number(pick("DEFAULT_PROVIDER_TIMEOUT") || 120.0),
        max_tokens: pick("DEFAULT_PROVIDER_MAX_TOKENS") ? Number(pick("DEFAULT_PROVIDER_MAX_TOKENS")) : null,
      },
    ];
  }

  return {
    app_name: "tianshu",
    providers,
    default_provider: pick("DEFAULT_PROVIDER") || "mock",
    mode: (pick("MODE") || "full") as "full" | "headless",
    web_token: pick("WEB_TOKEN") || "",
  };
}

export const settings: Settings = readSettings();

export function getProvider(name: string | null = null): LLMProviderConfig {
  const n = name ?? settings.default_provider;
  for (const p of settings.providers) {
    if (p.name === n) return p;
  }
  if (n === settings.default_provider && settings.providers.length) {
    return settings.providers[0];
  }
  throw new Error(`provider 不存在: ${n}`);
}
