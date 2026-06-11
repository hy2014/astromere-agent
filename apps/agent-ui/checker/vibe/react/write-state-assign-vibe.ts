import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { DeclaredVarStatus } from "../assign";

export class WriteStateAssignVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "writeStateAssign",
      priority: 85,
      match: (node) => {
        if (!ts.isExpressionStatement(node)) return false;
        const expr = node.expression;
        if (!ts.isBinaryExpression(expr)) return false;
        if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
        const lhs = expr.left;
        if (!ts.isPropertyAccessExpression(lhs)) return false;
        if (!ts.isIdentifier(lhs.expression)) return false;
        return lhs.expression.text === "WriteState";
      },
      make: (_, node) =>
        new WriteStateAssignVibe("WriteStateAssignVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "WriteState.setXxx = setter";
  }

  computeResults(): VibeStatus[] {
    return [];
  }

  checkStatus(): { rule: string; message: string; node: any } | null {
    const stmt = this.content as ts.ExpressionStatement;
    const expr = stmt.expression as ts.BinaryExpression;
    const lhs = expr.left as ts.PropertyAccessExpression;
    const rhs = expr.right;

    const propName = lhs.name.text;
    if (!propName.startsWith("set")) {
      return {
        rule: "WriteState 赋值",
        message: `WriteState 属性名必须以 "set" 开头，当前: ${propName}`,
        node: lhs.name,
      };
    }

    if (!ts.isIdentifier(rhs)) {
      return {
        rule: "WriteState 赋值",
        message: "WriteState 赋值的右侧必须是 identifier（useState 的 setter）",
        node: rhs,
      };
    }

    const rhsName = rhs.text;
    const declaredVars = this.status.filter(
      (s): s is DeclaredVarStatus => s instanceof DeclaredVarStatus,
    );
    const setter = declaredVars.find(
      (s) => s.name === rhsName && s.kind === "stateSetter",
    );
    if (!setter) {
      return {
        rule: "WriteState 赋值",
        message: `"${rhsName}" 不是 useState 的 setter，WriteState 只能绑定 state setter`,
        node: rhs,
      };
    }

    return null;
  }
}
