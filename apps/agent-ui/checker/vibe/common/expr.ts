import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";

/**
 * Expression Vibe
 *
 * TODO: JSX check — expressions returned/assigned in a FnVibe context must not contain JSX
 * Currently a pure pass-through; match accepts any expression node.
 */
export class ExprVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "expr",
      priority: 10,
      match: () => true,
      make: (_, node) => new ExprVibe("ExprVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "expression";
  }

  computeResults(): VibeStatus[] {
    return [];
  }
}

/**
 * Return-statement Vibe
 *
 * Follow-up: checkStatus should verify the return value contains no JSX (in a FnVibe context)
 */
export class ReturnVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "return",
      priority: 100,
      match: (node) => ts.isReturnStatement(node),
      make: (_, node) => {
        const vibe = new ReturnVibe("ReturnVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [ExprVibe.rule(vibe)];
        return vibe;
      },
    };
  }

  resolveSubContents(): any[] {
    const stmt = this.content as ts.ReturnStatement;
    return stmt.expression ? [stmt.expression] : [];
  }

  allowDescription(): string {
    return "return ...";
  }

  computeResults(): VibeStatus[] {
    return [];
  }
}
