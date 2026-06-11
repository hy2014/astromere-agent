export abstract class VibeStatus {
  constructor(public source: string) {}
}

export type Rule = {
  name: string;
  priority: number;
  match(node: any): boolean;
  make(vibe: Vibe, node: any): Vibe;
};

export abstract class Vibe {
  name: string;
  status: VibeStatus[];
  parent: Vibe | null;
  subVibeRules: Rule[];
  content: any;

  constructor(name: string, parent: Vibe | null, content: any, inheritStatus: VibeStatus[] = []) {
    this.name = name;
    this.status = [...inheritStatus];
    this.parent = parent;
    this.subVibeRules = [];
    this.content = content;
  }

  abstract resolveSubContents(): any[];
  abstract allowDescription(): string;
  abstract computeResults(): VibeStatus[];

  checkStatus(): { rule: string; message: string; node: any } | null {
    return null;
  }

  resolve(): { results: VibeStatus[] } | { violations: { rule: string; message: string; node: any }[] } {
    const children = this.resolveSubContents();

    for (const child of children) {
      if (!child) continue;

      const matched = this.subVibeRules
        .filter((r) => r.match(child))
        .sort((a, b) => b.priority - a.priority);

      const best = matched[0];
      if (!best) {
        return {
          violations: [
            {
              rule: "vibe 操作许可",
              message: `${this.describe(child)} 不在 ${this.name} 的许可操作中\n当前 ${this.name} 允许：${this.allowDescription()}${this.parent ? `\n可能应在 ${this.parent.name} 中处理` : ""}`,
              node: child,
            },
          ],
        };
      }

      const sub = best.make(this, child);
      const out = sub.resolve();
      if ("violations" in out) return out;

      this.status = this.status.concat(out.results);
    }

    const check = this.checkStatus();
    if (check) {
      return { violations: [check] };
    }

    return { results: this.computeResults() };
  }

  private describe(node: any): string {
    return String(node).slice(0, 40);
  }
}
