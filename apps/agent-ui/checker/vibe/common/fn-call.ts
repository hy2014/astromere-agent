import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { ExprVibe } from "./expr";

// ─── CallFuncVibeStatus ────────────────────────────────────────────────

export class CallFuncVibeStatus extends VibeStatus {
  constructor(
    public callee: string,
    public args: string[],
  ) {
    super("FunctionCallVibe");
  }
}

// ─── CalleeVibe ────────────────────────────────────────────────────────

export class CalleeVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "callee",
      priority: 10,
      match: () => true,
      make: (_, node) => new CalleeVibe("CalleeVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "调用目标";
  }

  computeResults(): VibeStatus[] {
    return [];
  }

  checkStatus(): { rule: string; message: string; node: any } | null {
    const calleeName = this.getCalleeName();
    if (!calleeName) return null;

    const found = this.status.some(
      (s) => s instanceof VibeStatus && "name" in s && (s as any).name === calleeName,
    );
    if (!found) return null;

    return null; // No violation reported for now; to be extended later
  }

  private getCalleeName(): string {
    const node = this.content;
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) {
      const parts: string[] = [];
      let cur: ts.Node = node;
      while (ts.isPropertyAccessExpression(cur)) {
        parts.unshift(cur.name.text);
        cur = cur.expression;
      }
      if (ts.isIdentifier(cur)) parts.unshift(cur.text);
      return parts.join(".");
    }
    return "";
  }
}

// ─── FunctionCallVibe ──────────────────────────────────────────────────

export class FunctionCallVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "fnCall",
      priority: 10,
      match: (node) => {
        if (!ts.isExpressionStatement(node)) return false;
        return ts.isCallExpression(node.expression);
      },
      make: (_, node) => {
        const vibe = new FunctionCallVibe("FunctionCallVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [
          CalleeVibe.rule(vibe),
          ExprVibe.rule(vibe),
        ];
        return vibe;
      },
    };
  }

  resolveSubContents(): any[] {
    const stmt = this.content as ts.ExpressionStatement;
    const call = stmt.expression as ts.CallExpression;
    return [call.expression, ...call.arguments];
  }

  allowDescription(): string {
    return "fn() / obj.method()";
  }

  computeResults(): VibeStatus[] {
    const stmt = this.content as ts.ExpressionStatement;
    const call = stmt.expression as ts.CallExpression;
    const calleeName = this.getCalleeText(call.expression);
    const args = call.arguments.map((a) => a.getText());
    return [new CallFuncVibeStatus(calleeName, args)];
  }

  private getCalleeText(expr: ts.Expression): string {
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) return expr.getText();
    return "";
  }
}
