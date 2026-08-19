import * as fs from "node:fs";
import * as path from "node:path";

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  path: string;
  files: Record<string, string>;
}

export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("---", 3);
  if (end === -1) return { meta: {}, body: text };
  const metaText = text.slice(3, end);
  const body = text.slice(end + 3).replace(/^\n+/, "");
  const meta: Record<string, unknown> = {};
  for (const line of metaText.split("\n")) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) meta[m[1].trim()] = m[2].trim();
  }
  return { meta, body };
}

export class SkillRepository {
  root: string;
  private _skills = new Map<string, Skill>();

  constructor(root: string) {
    this.root = root;
  }

  scan(): void {
    this._skills.clear();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const mdPath = path.join(this.root, entry.name, "SKILL.md");
      if (!fs.existsSync(mdPath)) continue;
      const text = fs.readFileSync(mdPath, "utf-8");
      const { meta, body } = parseFrontmatter(text);
      const name = String(meta.name ?? entry.name);
      const files: Record<string, string> = {};
      for (const f of fs.readdirSync(path.join(this.root, entry.name))) {
        if (f === "SKILL.md") continue;
        files[f] = fs.readFileSync(path.join(this.root, entry.name, f), "utf-8");
      }
      this._skills.set(name, {
        name,
        description: String(meta.description ?? ""),
        instructions: body,
        path: path.join(this.root, entry.name),
        files,
      });
    }
  }

  get(name: string): Skill | null {
    return this._skills.get(name) ?? null;
  }

  list(): Skill[] {
    return [...this._skills.values()];
  }

  descriptions(): string {
    return this.list()
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");
  }
}
