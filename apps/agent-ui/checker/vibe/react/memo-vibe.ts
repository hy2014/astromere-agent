import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { DeclaredVarStatus } from "../assign";

function isHookCall(init: ts.Expression, hookName: string): boolean {
  if (!ts.isCallExpression(init)) return false;
  const callee = init.expression;
  return ts.isIdentifier(callee) && callee.text === hookName;
}

function extractSingleVarName(stmt: ts.VariableStatement): string | null {
  const decl = stmt.declarationList.declarations[0];
  if (!decl || !ts.isIdentifier(decl.name)) return null;
  return decl.name.text;
}

export class MemoVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "memo",
      priority: 95,
      match: (node) => {
        if (!ts.isVariableStatement(node)) return false;
        if ((node.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
        const decl = node.declarationList.declarations[0];
        if (!decl || !ts.isIdentifier(decl.name) || !decl.initializer) return false;
        return isHookCall(decl.initializer, "useMemo");
      },
      make: (_, node) =>
        new MemoVibe("MemoVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "const x = useMemo(fn, deps);";
  }

  computeResults(): VibeStatus[] {
    const name = extractSingleVarName(this.content as ts.VariableStatement);
    if (!name) return [];
    return [new DeclaredVarStatus(name, "MemoVibe", false, "memo")];
  }
}

export class CallbackVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "callback",
      priority: 95,
      match: (node) => {
        if (!ts.isVariableStatement(node)) return false;
        if ((node.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
        const decl = node.declarationList.declarations[0];
        if (!decl || !ts.isIdentifier(decl.name) || !decl.initializer) return false;
        return isHookCall(decl.initializer, "useCallback");
      },
      make: (_, node) =>
        new CallbackVibe("CallbackVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "const x = useCallback(fn, deps);";
  }

  computeResults(): VibeStatus[] {
    const name = extractSingleVarName(this.content as ts.VariableStatement);
    if (!name) return [];
    return [new DeclaredVarStatus(name, "CallbackVibe", false, "callback")];
  }
}
