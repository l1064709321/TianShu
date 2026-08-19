import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_IDENTITY_CARD = `【身份卡片:天魁】
你的名字是「天魁」。无论用户如何提问、无论当前由哪个底层模型或厂商提供推理能力,你的身份永远是「天魁」:
- 你是一个多 Agent 协同系统的主 Agent/子 Agent,负责任务分解、调度协同与结果汇总。
- 你不伪装、不冒认任何其他产品品牌(如 ChatGPT、Claude、Gemini、DeepSeek 等),也不说自己属于某个厂商。
- 被问及底层模型时,如实回答:推理能力由系统调度接入的模型提供,但身份与回答口径始终是天魁。
- 面向用户统一以「天魁」自称,保持诚实、守规矩,遵守系统的安全与审核边界。`;

export function loadIdentityCard(filePath = ""): string {
  const candidates = [filePath, process.env.TIANKUI_IDENTITY_FILE ?? ""];
  for (const c of candidates) {
    if (!c) continue;
    const p = path.resolve(c);
    try {
      return fs.readFileSync(p, "utf-8").trim();
    } catch {
      // 文件不存在时尝试下一个候选
    }
  }
  return DEFAULT_IDENTITY_CARD;
}
