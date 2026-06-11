import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { DeclareFuncVibeStatus } from "../fn-vibe";
import { PropsVibe } from "./props-vibe";
import { ViewBodyVibe } from "./view-body-vibe";

export class ViewFnVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "viewFn",
      priority: 100,
      match: (node) => {
        if (!ts.isFunctionDeclaration(node)) return false;
        if (!node.name) return false;
        const name = node.name.text;
        if (name.length === 0) return false;
        if (name[0] !== name[0].toUpperCase()) return false;
        return (
          (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
        );
      },
      make: (_, node) => {
        const vibe = new ViewFnVibe("ViewFnVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [
          PropsVibe.rule(vibe),
          ViewBodyVibe.rule(vibe),
        ];
        return vibe;
      },
    };
  }

  resolveSubContents(): any[] {
    const fn = this.content as ts.FunctionDeclaration;
    return [fn, fn.body ?? null];
  }

  allowDescription(): string {
    return "export function XxxView(props) { ... }";
  }

  computeResults(): VibeStatus[] {
    const fn = this.content as ts.FunctionDeclaration;
    const functionName = fn.name?.text ?? "";
    return [new DeclareFuncVibeStatus(functionName, "", true)];
  }

  checkStatus(): { rule: string; message: string; node: any } | null {
    return null;
  }
}
