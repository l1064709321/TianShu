export type ToolFn = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface ToolDef {
  name: string;
  description: string;
  func: ToolFn;
  parameters?: Record<string, unknown>;
  format_result?: "json" | "RAW";
  requires_review?: boolean;
}

export class Tool {
  name: string;
  description: string;
  func: ToolFn;
  parameters: Record<string, unknown>;
  format_result: "json" | "RAW";
  requires_review: boolean;

  constructor(def: ToolDef) {
    this.name = def.name;
    this.description = def.description;
    this.func = def.func;
    this.parameters = def.parameters ?? { type: "object", properties: {} };
    this.format_result = def.format_result ?? "json";
    this.requires_review = def.requires_review ?? false;
  }

  get schema(): Record<string, unknown> {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }
}

export class ToolRegistry {
  private _tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this._tools.set(tool.name, tool);
  }

  get(name: string): Tool | null {
    return this._tools.get(name) ?? null;
  }

  list(): Tool[] {
    return [...this._tools.values()];
  }

  schemas(): Array<Record<string, unknown>> {
    return this.list().map((t) => t.schema);
  }
}