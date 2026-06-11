import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { BodyVibe } from "./body";

// ─── Branch wrapper ────────────────────────────────────────────────────

type Branch = { body: ts.Block };

// ─── ConditionVibe ─────────────────────────────────────────────────────

export class ConditionVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "condition",
      priority: 10,
      match: () => true,
      make: (_, node) => {
        const vibe = new ConditionVibe("ConditionVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [BodyVibe.rule(vibe)];
        return vibe;
      },
    };
  }

  resolveSubContents(): any[] {
    const branch = this.content as Branch;
    return [branch.body];
  }

  allowDescription(): string {
    return "if / else-if / else 分支";
  }

  computeResults(): VibeStatus[] {
    return [];
  }
}

// ─── ConditionsVibe ────────────────────────────────────────────────────

export class ConditionsVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "conditions",
      priority: 45,
      match: (node) => ts.isIfStatement(node),
      make: (_, node) => {
        const vibe = new ConditionsVibe("ConditionsVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [ConditionVibe.rule(vibe)];
        return vibe;
      },
    };
  }

  resolveSubContents(): Branch[] {
    const branches: Branch[] = [];
    let current: ts.IfStatement | null = this.content as ts.IfStatement;

    while (current) {
      const thenBody = current.thenStatement;
      if (!ts.isBlock(thenBody)) {
        // non-block caught by checkStatus, return empty to avoid crash
        return [];
      }
      branches.push({ body: thenBody });

      if (!current.elseStatement) {
        break;
      }

      if (ts.isIfStatement(current.elseStatement)) {
        current = current.elseStatement;
      } else {
        const elseBody = current.elseStatement;
        if (!ts.isBlock(elseBody)) return [];
        branches.push({ body: elseBody });
        break;
      }
    }

    return branches;
  }

  allowDescription(): string {
    return "if / else-if / else";
  }

  computeResults(): VibeStatus[] {
    return [];
  }

  checkStatus(): { rule: string; message: string; node: any } | null {
    let current: ts.IfStatement | null = this.content as ts.IfStatement;

    while (current) {
      if (!ts.isBlock(current.thenStatement)) {
        return {
          rule: "if 语句块",
          message: "if 体必须用花括号 { } 包裹，即使只有一行",
          node: current.thenStatement,
        };
      }

      if (!current.elseStatement) break;

      if (ts.isIfStatement(current.elseStatement)) {
        current = current.elseStatement;
      } else {
        if (!ts.isBlock(current.elseStatement)) {
          return {
            rule: "if 语句块",
            message: "else 体必须用花括号 { } 包裹，即使只有一行",
            node: current.elseStatement,
          };
        }
        break;
      }
    }

    return null;
  }
}
