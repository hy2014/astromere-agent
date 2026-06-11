import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { DeclaredVarStatus } from "../assign";

function isJsxReturn(node: ts.Node): node is ts.ReturnStatement & { expression: ts.JsxElement | ts.JsxSelfClosingElement } {
  if (!ts.isReturnStatement(node)) return false;
  const expr = node.expression;
  if (!expr) return false;
  return ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr);
}

function collectJsxAttrs(
  el: ts.JsxElement | ts.JsxSelfClosingElement,
): ts.JsxAttribute[] {
  const attrs: ts.JsxAttribute[] = [];
  const opener = ts.isJsxElement(el) ? el.openingElement : el;
  for (const attr of opener.attributes.properties) {
    if (ts.isJsxAttribute(attr)) attrs.push(attr);
  }
  return attrs;
}

function walkJsxForMapRender(
  node: ts.Node,
): { rule: string; message: string; node: any } | null {
  if (ts.isJsxExpression(node)) {
    const expr = node.expression;
    if (expr && ts.isCallExpression(expr)) {
      const callee = expr.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "map") {
        return validateMapCall(expr);
      }
    }
    if (expr) return walkJsxForMapRender(expr);
    return null;
  }

  if (ts.isJsxElement(node)) {
    for (const child of node.children) {
      const result = walkJsxForMapRender(child);
      if (result) return result;
    }
    const opener = node.openingElement;
    for (const attr of opener.attributes.properties) {
      if (ts.isJsxAttribute(attr) && attr.initializer) {
        const result = walkJsxForMapRender(attr.initializer);
        if (result) return result;
      }
    }
  }

  if (ts.isJsxSelfClosingElement(node)) {
    for (const attr of node.attributes.properties) {
      if (ts.isJsxAttribute(attr) && attr.initializer) {
        const result = walkJsxForMapRender(attr.initializer);
        if (result) return result;
      }
    }
  }

  return null;
}

function validateMapCall(
  call: ts.CallExpression,
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
        if (!isRenderCall(retExpr)) {
          return {
            rule: "map render",
            message: ".map() 回调必须返回 render({...}) 调用",
            node: retExpr,
          };
        }
      }
    }
  } else if (ts.isCallExpression(body)) {
    if (!isRenderCall(body)) {
      return {
        rule: "map render",
        message: ".map() 回调必须调用 render({...})",
        node: body,
      };
    }
  }

  return null;
}

function isRenderCall(expr: ts.CallExpression): boolean {
  const callee = expr.expression;
  return ts.isIdentifier(callee) && callee.text === "render";
}

export class JsxEventVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "jsxEvent",
      priority: 110,
      match: (node) => isJsxReturn(node),
      make: (_, node) =>
        new JsxEventVibe("JsxEventVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "JSX return: onClick={handler} / .map(row => render())";
  }

  computeResults(): VibeStatus[] {
    return [];
  }

  checkStatus(): { rule: string; message: string; node: any } | null {
    const stmt = this.content as ts.ReturnStatement;
    const el = stmt.expression as ts.JsxElement | ts.JsxSelfClosingElement;

    const declaredVars = this.status.filter(
      (s): s is DeclaredVarStatus => s instanceof DeclaredVarStatus,
    );

    const attrs = collectJsxAttrs(el);
    for (const attr of attrs) {
      if (!ts.isIdentifier(attr.name)) continue;
      const attrName = attr.name.text;
      if (!/^on[A-Z]/.test(attrName)) continue;

      const init = attr.initializer;
      if (!init || !ts.isJsxExpression(init)) continue;
      const handlerExpr = init.expression;
      if (!handlerExpr) continue;

      if (ts.isIdentifier(handlerExpr)) {
        const handlerName = handlerExpr.text;
        const found = declaredVars.find((s) => s.name === handlerName);
        if (!found) {
          return {
            rule: "JSX 事件绑定",
            message: `onClick 绑定的 "${handlerName}" 未在当前作用域中声明`,
            node: handlerExpr,
          };
        }
      }
    }

    const mapCheck = walkJsxForMapRender(el);
    if (mapCheck) return mapCheck;

    return null;
  }
}
