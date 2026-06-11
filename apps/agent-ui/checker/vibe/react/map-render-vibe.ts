import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { DeclaredVarStatus } from "../assign";

function isCallExpression(expr: ts.Expression, name: string): boolean {
  return ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === name;
}

function walkJsxForMapRender(
  node: ts.Node,
  declaredVars: DeclaredVarStatus[],
): { rule: string; message: string; node: any } | null {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node) && !ts.isJsxExpression(node)) {
    return null;
  }

  if (ts.isJsxExpression(node)) {
    const expr = node.expression;
    if (!expr) return null;

    if (ts.isCallExpression(expr)) {
      const callee = expr.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "map") {
        return validateMapCall(expr, declaredVars);
      }
    }

    return walkJsxForMapRender(expr, declaredVars);
  }

  const children = ts.isJsxElement(node) ? [node.openingElement, ...node.children] : [node];
  for (const child of children) {
    const result = walkJsxForMapRender(child, declaredVars);
    if (result) return result;
  }

  if (ts.isJsxOpeningElement(node)) {
    for (const attr of node.attributes.properties) {
      if (ts.isJsxAttribute(attr) && attr.initializer) {
        const result = walkJsxForMapRender(attr.initializer, declaredVars);
        if (result) return result;
      }
    }
  }

  return null;
}

function validateMapCall(
  call: ts.CallExpression,
  declaredVars: DeclaredVarStatus[],
): { rule: string; message: string; node: any } | null {
  const args = call.arguments;
  if (args.length === 0) return null;

  const callback = args[0];
  if (!ts.isArrowFunction(callback)) {
    return {
      rule: "map render",
      message: ".map() 的回调必须是箭头函数: row => render({...})",
      node: callback,
    };
  }

  const body = callback.body;
  if (ts.isBlock(body)) {
    const stmts = body.statements;
    if (stmts.length === 0) return null;
    const lastStmt = stmts[stmts.length - 1];
    if (ts.isReturnStatement(lastStmt)) {
      const retExpr = lastStmt.expression;
      if (retExpr && ts.isCallExpression(retExpr)) {
        if (!isCallExpression(retExpr, "render")) {
          return {
            rule: "map render",
            message: ".map() 回调必须返回 render({...}) 调用",
            node: retExpr,
          };
        }
      }
    }
  } else if (ts.isCallExpression(body)) {
    if (!isCallExpression(body, "render")) {
      return {
        rule: "map render",
        message: ".map() 回调必须调用 render({...})",
        node: body,
      };
    }
  }

  return null;
}

export class MapRenderVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "mapRender",
      priority: 85,
      match: (node) => {
        if (!ts.isReturnStatement(node)) return false;
        if (!node.expression) return false;
        return (
          ts.isJsxElement(node.expression) ||
          ts.isJsxSelfClosingElement(node.expression) ||
          (ts.isParenthesizedExpression(node.expression))
        );
      },
      make: (_, node) =>
        new MapRenderVibe("MapRenderVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "{rows.map(row => render({...}))}";
  }

  computeResults(): VibeStatus[] {
    return [];
  }

  checkStatus(): { rule: string; message: string; node: any } | null {
    const stmt = this.content as ts.ReturnStatement;
    const expr = stmt.expression!;

    const declaredVars = this.status.filter(
      (s): s is DeclaredVarStatus => s instanceof DeclaredVarStatus,
    );

    return walkJsxForMapRender(expr, declaredVars);
  }
}
