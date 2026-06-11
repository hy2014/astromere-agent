import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { DeclaredVarStatus } from "../assign";
import { BodyVibe } from "./body";

// ─── CatchVarVibe ──────────────────────────────────────────────────────

export class CatchVarVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "catchVar",
      priority: 10,
      match: (node) => node !== null && ts.isVariableDeclaration(node),
      make: (_, node) =>
        new CatchVarVibe("CatchVarVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "catch 异常变量";
  }

  computeResults(): VibeStatus[] {
    const decl = this.content as ts.VariableDeclaration;
    if (ts.isIdentifier(decl.name)) {
      return [new DeclaredVarStatus(decl.name.text, "CatchVarVibe")];
    }
    return [];
  }
}

// ─── TryVibe ───────────────────────────────────────────────────────────

export class TryVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "try",
      priority: 10,
      match: (node) => ts.isTryStatement(node),
      make: (_, node) => {
        const vibe = new TryVibe("TryVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [
          CatchVarVibe.rule(vibe),
          BodyVibe.rule(vibe),
        ];
        return vibe;
      },
    };
  }

  resolveSubContents(): any[] {
    const stmt = this.content as ts.TryStatement;
    const children: any[] = [stmt.tryBlock];

    if (stmt.catchClause) {
      // catch 变量先注入 status，再处理 catch block
      children.push(stmt.catchClause.variableDeclaration ?? null);
      children.push(stmt.catchClause.block);
    }

    if (stmt.finallyBlock) {
      children.push(stmt.finallyBlock);
    }

    return children;
  }

  allowDescription(): string {
    return "try / catch / finally";
  }

  computeResults(): VibeStatus[] {
    return [];
  }
}
