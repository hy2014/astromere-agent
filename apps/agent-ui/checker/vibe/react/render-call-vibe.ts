import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";

export class RenderCallVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "renderCall",
      priority: 105,
      match: (node) => {
        if (!ts.isReturnStatement(node)) return false;
        const expr = node.expression;
        if (!expr || !ts.isCallExpression(expr)) return false;
        const callee = expr.expression;
        return ts.isIdentifier(callee) && callee.text === "render";
      },
      make: (_, node) =>
        new RenderCallVibe("RenderCallVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "render({ state, props, fn, events, memo });";
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
        rule: "render 调用",
        message: "render() 参数必须是对象字面量，包含 state/props/fn/events/memo",
        node: call,
      };
    }

    const obj = args[0];
    const allowedKeys = new Set(["state", "props", "fn", "events", "memo"]);
    const actualKeys = new Set<string>();

    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
        return {
          rule: "render 调用",
          message: "render() 参数不支持 spread，使用 { state, props, fn, events, memo } 格式",
          node: prop,
        };
      }
      const key = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : prop.getText();
      actualKeys.add(key);
    }

    const extras = Array.from(actualKeys).filter((k) => !allowedKeys.has(k));
    if (extras.length > 0) {
      return {
        rule: "render 调用",
        message: `render() 参数 key 只能是 { state, props, fn, events, memo }，多余 key: ${extras.join(", ")}`,
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
          if (!fnName.startsWith("render")) {
            return {
              rule: "render 调用",
              message: `render() 的 fn 参数必须是 renderXXXX 函数（以 "render" 开头），当前: ${fnName}`,
              node: fnValue,
            };
          }
        }
      }
    }

    return null;
  }
}
