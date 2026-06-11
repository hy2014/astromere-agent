import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "./vibe";

export class WriteStateVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "writeState",
      priority: 80,
      match: (node) => {
        if (!ts.isVariableStatement(node)) return false;
        if ((node.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
        if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return false;
        const firstDecl = node.declarationList.declarations[0];
        if (!firstDecl || !ts.isIdentifier(firstDecl.name)) return false;
        const init = firstDecl.initializer;
        if (init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init))) return false;
        return firstDecl.name.text === "WriteState";
      },
      make: (_, node) => new WriteStateVibe("WriteStateVibe", parentVibe, node),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  computeResults(): VibeStatus[] {
    return [];
  }

  allowDescription(): string {
    return "const WriteState = ...";
  }
}
