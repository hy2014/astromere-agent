import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { ParamVarStatus } from "../fn-params-vibe";

export class PropsVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "props",
      priority: 10,
      match: (node) =>
        ts.isFunctionDeclaration(node) || ts.isArrowFunction(node),
      make: (_, node) =>
        new PropsVibe("PropsVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "function 第一个参数 → props";
  }

  computeResults(): VibeStatus[] {
    const fn = this.content as ts.FunctionDeclaration | ts.ArrowFunction;
    const params = fn.parameters;
    if (params.length === 0) return [];

    const first = params[0];
    const type = first.type?.getText();
    const defValue = first.initializer?.getText();

    if (ts.isObjectBindingPattern(first.name)) {
      return first.name.elements
        .map((e) => {
          if (!ts.isIdentifier(e.name)) return null;
          return new ParamVarStatus(e.name.text, type, defValue, "props");
        })
        .filter((s): s is ParamVarStatus => s !== null);
    }

    if (ts.isIdentifier(first.name)) {
      return [new ParamVarStatus(first.name.text, type, defValue, "props")];
    }

    return [];
  }
}
