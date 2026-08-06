from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class Skill:
    name: str
    description: str
    instructions: str
    path: Path
    files: dict[str, str] = field(default_factory=dict)


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("---", 3)
    if end == -1:
        return {}, text
    meta = text[3:end]
    body = text[end + 3 :]
    try:
        data = yaml.safe_load(meta) or {}
    except yaml.YAMLError:
        data = {}
    return data, body.lstrip("\n")


class SkillRepository:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._skills: dict[str, Skill] = {}

    def scan(self) -> None:
        self._skills.clear()
        if not self.root.exists():
            return
        for skill_dir in self.root.iterdir():
            if not skill_dir.is_dir():
                continue
            md = skill_dir / "SKILL.md"
            if not md.exists():
                continue
            meta, body = _parse_frontmatter(md.read_text(encoding="utf-8"))
            name = meta.get("name") or skill_dir.name
            files: dict[str, str] = {}
            for f in skill_dir.iterdir():
                if f.name == "SKILL.md":
                    continue
                files[f.name] = f.read_text(encoding="utf-8")
            self._skills[name] = Skill(
                name=name,
                description=meta.get("description", ""),
                instructions=body,
                path=skill_dir,
                files=files,
            )

    def get(self, name: str) -> Skill | None:
        return self._skills.get(name)

    def list(self) -> list[Skill]:
        return list(self._skills.values())

    def descriptions(self) -> str:
        lines = []
        for s in self._skills.values():
            lines.append(f"- {s.name}: {s.description}")
        return "\n".join(lines)