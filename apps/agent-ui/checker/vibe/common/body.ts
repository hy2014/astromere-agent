import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { DeclaredVarStatus, DefineAssignVibe, SetVibe } from "../assign";
import { ReturnVibe } from "./expr";
import { FunctionCallVibe } from "./fn-call";
import { ConditionsVibe } from "./conditions";
import { LoopVibe } from "./loop";
import { TryVibe } from "./try";

export class BodyVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "body",
      priority: 10,
      match: (node) => ts.isBlock(node),
      make: (_, node) => {
        const vibe = new BodyVibe("BodyVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [
          ReturnVibe.rule(vibe),
          DefineAssignVibe.rule(vibe),
          SetVibe.rule(vibe),
          ConditionsVibe.rule(vibe),
          LoopVibe.rule(vibe),
          TryVibe.rule(vibe),
          FunctionCallVibe.rule(vibe),
        ];
        return vibe;
      },
    };
  }

  resolveSubContents(): any[] {
    return (this.content as ts.Block).statements;
  }

  allowDescription(): string {
    return "{ ... } 语句块";
  }

  computeResults(): VibeStatus[] {
    return [];
  }
}
