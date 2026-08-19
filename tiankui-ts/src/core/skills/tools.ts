import { ToolRegistry } from "../tools/registry.js";
import { Tool } from "../tools/registry.js";
import type { SkillRepository } from "./repository.js";

export function registerSkillTools(registry: ToolRegistry, repo: SkillRepository): void {
  registry.register(
    new Tool({
      name: "load_skill",
      description: "加载技能,返回技能说明与指令",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名称" },
        },
        required: ["name"],
      },
      func: async ({ name }) => {
        const skill = repo.get(String(name));
        if (!skill) {
          const available = repo.list().map((s) => s.name).join(", ");
          throw new Error(`技能不存在: ${name},可用: ${available || "(无)"}`);
        }
        const extra = Object.entries(skill.files ?? {})
          .map(([k, v]) => `[文件 ${k}]\n${v}`)
          .join("\n");
        return `技能[${skill.name}]: ${skill.description}\n\n${skill.instructions}\n\n${extra}`;
      },
    }),
  );

  registry.register(
    new Tool({
      name: "list_skills",
      description: "列出所有可用技能",
      parameters: {
        type: "object",
        properties: {},
      },
      func: async () => repo.descriptions() || "(无可用技能)",
    }),
  );
}