from __future__ import annotations

from tianshu.core.tools.registry import ToolRegistry


def register_skill_tools(registry: ToolRegistry, repo) -> None:
    @registry.decorator("load_skill", description="加载技能,返回技能说明与指令")
    async def load_skill(name: str) -> str:
        skill = repo.get(name)
        if skill is None:
            available = ", ".join(s.name for s in repo.list())
            raise ValueError(f"技能不存在: {name},可用: {available or '(无)'}")
        extra = "\n".join(f"[文件 {k}]\n{v}" for k, v in skill.files.items())
        return f"技能[{skill.name}]: {skill.description}\n\n{skill.instructions}\n\n{extra}"

    @registry.decorator("list_skills", description="列出所有可用技能")
    async def list_skills() -> str:
        return repo.descriptions() or "(无可用技能)"