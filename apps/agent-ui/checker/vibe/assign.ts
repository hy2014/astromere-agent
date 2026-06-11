import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "./vibe";
import { ExprVibe } from "./common/expr";

// ─── DeclaredVarStatus ────────────────────────────────────────────────

export class DeclaredVarStatus extends VibeStatus {
  constructor(public name: string) {
    super();
  }
}

// ─── Assign child wrapper ──────────────────────────────────────────────

export type AssignChild = {
  side: "lhs" | "rhs";
  node: ts.Node | null;
};

// ─── AssignVibe (abstract) ─────────────────────────────────────────────

export abstract class AssignVibe extends Vibe {
  /**
   * 返回 [lhsNode, rhsNode]。
   * 子类负责从自己的 content 中提取左右两边。
   */
  abstract resolveSubContents(): any[];

  abstract allowDescription(): string;

  abstract computeResults(): VibeStatus[];

  constructor(name: string, parent: Vibe, content: any, inheritStatus: VibeStatus[] = []) {
    super(name, parent, content, inheritStatus);
    // subVibRules 由子类在构造时设置
  }
}

// ─── LeftDefineVibe ────────────────────────────────────────────────────

export class LeftDefineVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "leftDefine",
      priority: 10,
      match: (child: AssignChild) => child.side === "lhs",
      make: (_, child: AssignChild) =>
        new LeftDefineVibe("LeftDefineVibe", parentVibe, child.node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "声明新变量";
  }

  computeResults(): VibeStatus[] {
    const name = this.getVarNames();
    return name.map((n) => new DeclaredVarStatus(n));
  }

  checkStatus(): { rule: string; message: string; node: any } | null {
    const names = this.getVarNames();
    if (names.length === 0) return null;

    for (const name of names) {
      const declared = this.status
        .filter((s): s is DeclaredVarStatus => s instanceof DeclaredVarStatus)
        .find((s) => s.name === name);
      if (declared) {
        return {
          rule: "变量声明",
          message: `变量 "${name}" 在当前作用域中重复声明`,
          node: this.content,
        };
      }
    }
    return null;
  }

  private getVarNames(): string[] {
    const node = this.content;
    if (ts.isIdentifier(node)) return [node.text];
    if (ts.isObjectBindingPattern(node)) {
      return node.elements
        .map((e) => (ts.isIdentifier(e.name) ? e.name.text : null))
        .filter((n): n is string => n !== null);
    }
    if (ts.isArrayBindingPattern(node)) {
      return node.elements
        .map((e) => (ts.isBindingElement(e) && ts.isIdentifier(e.name) ? e.name.text : null))
        .filter((n): n is string => n !== null);
    }
    return [];
  }
}

// ─── DefineAssignVibe ──────────────────────────────────────────────────

export class DefineAssignVibe extends AssignVibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "defineAssign",
      priority: 60,
      match: (node) => {
        if (!ts.isVariableStatement(node)) return false;
        const decl = node.declarationList.declarations[0];
        if (!decl || !ts.isIdentifier(decl.name)) {
          // 解构声明也接受: const { a, b } = ...
          return decl !== undefined;
        }
        return true;
      },
      make: (_, node) => {
        const vibe = new DefineAssignVibe("DefineAssignVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [
          LeftDefineVibe.rule(vibe),
          ExprVibe.rule(vibe),
        ];
        return vibe;
      },
    };
  }

  resolveSubContents(): AssignChild[] {
    const stmt = this.content as ts.VariableStatement;
    const decl = stmt.declarationList.declarations[0];
    if (!decl) return [];
    return [
      { side: "lhs", node: decl.name },
      { side: "rhs", node: decl.initializer ?? null },
    ];
  }

  allowDescription(): string {
    return "const / let / var xxx = ...";
  }

  computeResults(): VibeStatus[] {
    return this.ownStatus().filter((s): s is DeclaredVarStatus => s instanceof DeclaredVarStatus);
  }
}

// ─── LeftSetVibe ───────────────────────────────────────────────────────

export class LeftSetVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "leftSet",
      priority: 10,
      match: (child: AssignChild) => child.side === "lhs",
      make: (_, child: AssignChild) =>
        new LeftSetVibe("LeftSetVibe", parentVibe, child.node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "赋值目标";
  }

  computeResults(): VibeStatus[] {
    return [];
  }

  checkStatus(): { rule: string; message: string; node: any } | null {
    const targetName = this.getAssignTargetName();
    if (!targetName) return null;

    const found = this.status
      .filter((s): s is DeclaredVarStatus => s instanceof DeclaredVarStatus)
      .find((s) => s.name === targetName);
    if (!found) {
      return {
        rule: "变量赋值",
        message: `变量 "${targetName}" 在当前作用域中未声明`,
        node: this.content,
      };
    }
    return null;
  }

  private getAssignTargetName(): string | null {
    const node = this.content;
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      return node.expression.text;
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      return node.expression.text;
    }
    return null;
  }
}

// ─── SetVibe ───────────────────────────────────────────────────────────

export class SetVibe extends AssignVibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "set",
      priority: 50,
      match: (node) => {
        if (!ts.isExpressionStatement(node)) return false;
        const expr = node.expression;
        if (!ts.isBinaryExpression(expr)) return false;
        return expr.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      },
      make: (_, node) => {
        const vibe = new SetVibe("SetVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [
          LeftSetVibe.rule(vibe),
          ExprVibe.rule(vibe),
        ];
        return vibe;
      },
    };
  }

  resolveSubContents(): AssignChild[] {
    const stmt = this.content as ts.ExpressionStatement;
    const expr = stmt.expression as ts.BinaryExpression;
    return [
      { side: "lhs", node: expr.left },
      { side: "rhs", node: expr.right },
    ];
  }

  allowDescription(): string {
    return "xxx = XXXX";
  }

  computeResults(): VibeStatus[] {
    return [];
  }
}
