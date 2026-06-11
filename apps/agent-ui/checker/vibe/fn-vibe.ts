import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "./vibe";
import { FnArgsVibe } from "./fn-params-vibe";
import { BodyVibe } from "./common/body";

// ─── DeclareFuncVibeStatus ─────────────────────────────────────────────

export class DeclareFuncVibeStatus extends VibeStatus {
  constructor(
    public functionName: string,
    public fileName: string,
    public isExported: boolean,
  ) {
    super("FnVibe");
  }
}

// ─── FnVibe ────────────────────────────────────────────────────────────

export class FnVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "fn",
      priority: 0,
      match: (node) => ts.isFunctionDeclaration(node),
      make: (_, node) => {
        const vibe = new FnVibe("FnVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [
          FnArgsVibe.rule(vibe),
          BodyVibe.rule(vibe),
        ];
        return vibe;
      },
    };
  }

  resolveSubContents(): any[] {
    const node = this.content as ts.FunctionDeclaration;
    return [node, node.body ?? null];
  }

  allowDescription(): string {
    return "function xxx(...) {}";
  }

  computeResults(): VibeStatus[] {
    const node = this.content as ts.FunctionDeclaration;
    const functionName = node.name?.text ?? "";
    const isExported = (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
    return [new DeclareFuncVibeStatus(functionName, "", isExported)];
  }
}
