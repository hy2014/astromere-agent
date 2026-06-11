import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";

/**
 * 表达式 Vibe
 *
 * TODO: JSX 检查 — 在 FnVibe 上下文中 return/assign 的表达式不能包含 JSX
 * 目前纯透传，match 匹配任意表达式节点。
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
 * return 语句 Vibe
 *
 * 后续：checkStatus 检查返回值不含 JSX（在 FnVibe 上下文）
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
