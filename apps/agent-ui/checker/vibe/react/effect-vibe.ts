import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";

export class EffectVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "effect",
      priority: 95,
      match: (node) => {
        if (!ts.isExpressionStatement(node)) return false;
        const expr = node.expression;
        if (!ts.isCallExpression(expr)) return false;
        const callee = expr.expression;
        return ts.isIdentifier(callee) && callee.text === "useEffect";
      },
      make: (_, node) =>
        new EffectVibe("EffectVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "useEffect(fn, deps);";
  }

  computeResults(): VibeStatus[] {
    return [];
  }
}
