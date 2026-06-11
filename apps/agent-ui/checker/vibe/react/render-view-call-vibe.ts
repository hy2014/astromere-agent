import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";

export class RenderViewCallVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "renderViewCall",
      priority: 106,
      match: (node) => {
        if (!ts.isReturnStatement(node)) return false;
        const expr = node.expression;
        if (!expr || !ts.isCallExpression(expr)) return false;
        const callee = expr.expression;
        return ts.isIdentifier(callee) && callee.text === "renderView";
      },
      make: (_, node) =>
        new RenderViewCallVibe("RenderViewCallVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "renderView({ fn: XxxView, props: {...} });";
  }

  computeResults(): VibeStatus[] {
    return [];
  }

  checkStatus(): { rule: string; message: string; node: any } | null {
    const stmt = this.content as ts.ReturnStatement;
    const call = stmt.expression as ts.CallExpression;
    const args = call.arguments;
    if (args.length === 0 || !ts.isObjectLiteralExpression(args[0])) {
      return {
        rule: "renderView 调用",
        message: "renderView() 参数必须是对象字面量 { fn, props }",
        node: call,
      };
    }

    const obj = args[0];
    const allowedKeys = new Set(["fn", "props"]);
    const actualKeys = new Set<string>();

    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
        return {
          rule: "renderView 调用",
          message: `renderView() 参数不支持 spread，只允许 { fn, props }`,
          node: prop,
        };
      }
      const key = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : prop.getText();
      actualKeys.add(key);
    }

    const extras = Array.from(actualKeys).filter((k) => !allowedKeys.has(k));
    if (extras.length > 0) {
      return {
        rule: "renderView 调用",
        message: `renderView() 参数只能包含 { fn, props }，多余 key: ${extras.join(", ")}`,
        node: obj,
      };
    }

    if (actualKeys.has("fn")) {
      const fnProp = obj.properties.find((p) => {
        if (!p.name || !ts.isIdentifier(p.name)) return false;
        return p.name.text === "fn";
      });
      if (fnProp) {
        const fnValue = ts.isPropertyAssignment(fnProp)
          ? fnProp.initializer
          : ts.isShorthandPropertyAssignment(fnProp)
            ? fnProp.name
            : null;
        if (fnValue && ts.isIdentifier(fnValue)) {
          const fnName = fnValue.text;
          if (fnName[0] !== fnName[0].toUpperCase()) {
            return {
              rule: "renderView 调用",
              message: `renderView() 的 fn 参数必须是首字母大写的 View 组件，当前: ${fnName}`,
              node: fnValue,
            };
          }
        }
      }
    }

    return null;
  }
}
