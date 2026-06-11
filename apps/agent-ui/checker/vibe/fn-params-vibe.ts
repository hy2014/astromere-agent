import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "./vibe";
import { DeclaredVarStatus } from "./assign";

// ─── ParamVarStatus ────────────────────────────────────────────────────

export class ParamVarStatus extends DeclaredVarStatus {
  constructor(
    name: string,
    public type?: string,
    public defaultValue?: string,
    kind: string = "var",
  ) {
    super(name, "ParamVibe", false, kind);
  }
}

// ─── FnArgsVibe ────────────────────────────────────────────────────────

export class FnArgsVibe extends Vibe {
  private _declaredResults: VibeStatus[] = [];

  static rule(parentVibe: Vibe): Rule {
    return {
      name: "fnArgs",
      priority: 10,
      match: (node) =>
        ts.isFunctionDeclaration(node) || ts.isArrowFunction(node),
      make: (_, node) => {
        const vibe = new FnArgsVibe("FnArgsVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [
          SimpleParamVibe.rule(vibe),
          DestructureParamVibe.rule(vibe),
        ];
        return vibe;
      },
    };
  }

  resolve(): { results: VibeStatus[] } | { violations: { rule: string; message: string; node: any }[] } {
    const children = this.resolveSubContents();
    this._declaredResults = [];

    for (const child of children) {
      if (!child) continue;

      const matched = this.subVibeRules
        .filter((r) => r.match(child))
        .sort((a, b) => b.priority - a.priority);

      const best = matched[0];
      if (!best) {
        return {
          violations: [{
            rule: "vibe 操作许可",
            message: `${String(child).slice(0, 40)} 不在 ${this.name} 的许可操作中\n当前 ${this.name} 允许：${this.allowDescription()}`,
            node: child,
          }],
        };
      }

      const sub = best.make(this, child);
      const out = sub.resolve();
      if ("violations" in out) return out;

      this.status = this.status.concat(out.results);
      this._declaredResults = this._declaredResults.concat(out.results);
    }

    const check = this.checkStatus();
    if (check) return { violations: [check] };

    return { results: this.computeResults() };
  }

  resolveSubContents(): any[] {
    const fn = this.content as ts.FunctionDeclaration | ts.ArrowFunction;
    return fn.parameters;
  }

  allowDescription(): string {
    return "函数参数列表";
  }

  computeResults(): VibeStatus[] {
    return this._declaredResults.filter(
      (s): s is ParamVarStatus => s instanceof ParamVarStatus,
    );
  }
}

// ─── SimpleParamVibe ───────────────────────────────────────────────────

export class SimpleParamVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "simpleParam",
      priority: 10,
      match: (node) =>
        ts.isParameter(node) && ts.isIdentifier(node.name),
      make: (_, node) =>
        new SimpleParamVibe("SimpleParamVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "简单参数: name: Type = default";
  }

  computeResults(): VibeStatus[] {
    const p = this.content as ts.ParameterDeclaration;
    const name = (p.name as ts.Identifier).text;
    const type = p.type?.getText();
    const defaultValue = p.initializer?.getText();
    return [new ParamVarStatus(name, type, defaultValue)];
  }
}

// ─── DestructureParamVibe ──────────────────────────────────────────────

export class DestructureParamVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "destructureParam",
      priority: 10,
      match: (node) =>
        ts.isParameter(node) &&
        (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)),
      make: (_, node) =>
        new DestructureParamVibe("DestructureParamVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "解构参数: { a, b }: Type = default";
  }

  computeResults(): VibeStatus[] {
    const p = this.content as ts.ParameterDeclaration;
    const type = p.type?.getText();
    const names = getBindingNames(p.name);
    return names.map((n) => new ParamVarStatus(n, type));
  }
}

// ─── getBindingNames ───────────────────────────────────────────────────

function getBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];

  if (ts.isObjectBindingPattern(name)) {
    return name.elements
      .map((e) => (ts.isIdentifier(e.name) ? e.name.text : null))
      .filter((n): n is string => n !== null);
  }

  if (ts.isArrayBindingPattern(name)) {
    return name.elements
      .map((e) =>
        ts.isBindingElement(e) && ts.isIdentifier(e.name) ? e.name.text : null,
      )
      .filter((n): n is string => n !== null);
  }

  return [];
}
