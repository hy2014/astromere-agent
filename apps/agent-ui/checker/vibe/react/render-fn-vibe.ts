import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { DeclaredVarStatus } from "../assign";
import { PropsVibe } from "./props-vibe";
import { RfBodyVibe } from "./rf-body-vibe";

const kindOrder = ["state", "props", "callback", "memo"];

function injectParamStatus(
  vibe: Vibe,
  fn: ts.FunctionDeclaration,
): { status: VibeStatus[]; violations?: { rule: string; message: string; node: any }[] } {
  const params = fn.parameters;
  const added: VibeStatus[] = [];

  for (let i = 0; i < params.length && i < kindOrder.length; i++) {
    const param = params[i];
    const kind = kindOrder[i];
    const names = extractParamNames(param);

    if (names.length === 0 && kind !== "memo") {
      const isExplicitEmpty = ts.isObjectBindingPattern(param.name) && param.name.elements.length === 0;
      if (!isExplicitEmpty) {
        return {
          status: added,
          violations: [{
            rule: "renderFn 参数",
            message: `renderXXXX 第 ${i + 1} 个参数（${kind}）格式错误，应使用解构或简单标识符`,
            node: param,
          }],
        };
      }
    }

    for (const name of names) {
      added.push(new DeclaredVarStatus(name, "RenderFnParamsVibe", false, kind));
    }
  }

  return { status: added };
}

function extractParamNames(param: ts.ParameterDeclaration): string[] {
  if (ts.isIdentifier(param.name)) {
    return param.name.text ? [param.name.text] : [];
  }
  if (ts.isObjectBindingPattern(param.name)) {
    return param.name.elements
      .map((e) => (ts.isIdentifier(e.name) ? e.name.text : null))
      .filter((n): n is string => n !== null);
  }
  if (ts.isArrayBindingPattern(param.name)) {
    return param.name.elements
      .map((e) =>
        ts.isBindingElement(e) && ts.isIdentifier(e.name) ? e.name.text : null,
      )
      .filter((n): n is string => n !== null);
  }
  return [];
}

export class RenderFnVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "renderFn",
      priority: 90,
      match: (node) => {
        if (!ts.isFunctionDeclaration(node)) return false;
        if (!node.name) return false;
        return node.name.text.startsWith("render");
      },
      make: (_, node) => {
        const vibe = new RenderFnVibe("RenderFnVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [
          RfBodyVibe.rule(vibe),
        ];
        return vibe;
      },
    };
  }

  resolve(): { results: VibeStatus[] } | { violations: { rule: string; message: string; node: any }[] } {
    const fn = this.content as ts.FunctionDeclaration;

    const paramResult = injectParamStatus(this, fn);
    if (paramResult.violations) return { violations: paramResult.violations };
    this.status = this.status.concat(paramResult.status);

    const bodyChild = fn.body ?? null;
    if (!bodyChild) return { results: this.computeResults() };

    const matched = this.subVibeRules
      .filter((r) => r.match(bodyChild))
      .sort((a, b) => b.priority - a.priority);

    const best = matched[0];
    if (!best) {
      return {
        violations: [{
          rule: "vibe 操作许可",
          message: `renderXXXX 函数体不在许可操作中`,
          node: bodyChild,
        }],
      };
    }

    const sub = best.make(this, bodyChild);
    const out = sub.resolve();
    if ("violations" in out) return out;

    this.status = this.status.concat(out.results);

    const check = this.checkStatus();
    if (check) return { violations: [check] };

    return { results: this.computeResults() };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "function renderXxx(state, props, callback, memo?)";
  }

  computeResults(): VibeStatus[] {
    const fn = this.content as ts.FunctionDeclaration;
    return [];
  }

  checkStatus(): { rule: string; message: string; node: any } | null {
    return null;
  }
}
