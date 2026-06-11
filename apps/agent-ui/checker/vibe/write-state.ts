import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "./vibe";

export class WriteStateVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "writeState",
      priority: 80,
      match: (node) => {
        const decl = ts.isVariableStatement(node) &&
          (node.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
          !(node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
            ? node.declarationList.declarations[0]
            : null;
        const init = decl &&
          ts.isIdentifier(decl.name) &&
          decl.name.text === "WriteState" &&
          decl.initializer
            ? decl.initializer
            : null;
        return init !== null && ts.isObjectLiteralExpression(init) && init.properties.length === 0;
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
