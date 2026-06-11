import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { ReturnVibe } from "../common/expr";
import { DefineAssignVibe } from "../assign";
import { ConditionsVibe } from "../common/conditions";
import { RenderCallVibe } from "./render-call-vibe";
import { RenderViewCallVibe } from "./render-view-call-vibe";
import { JsxEventVibe } from "./jsx-event-vibe";

export class RfBodyVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "rfBody",
      priority: 10,
      match: (node) => ts.isBlock(node),
      make: (_, node) => {
        const vibe = new RfBodyVibe("RfBodyVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [
          JsxEventVibe.rule(vibe),
          RenderViewCallVibe.rule(vibe),
          RenderCallVibe.rule(vibe),
          ReturnVibe.rule(vibe),
          DefineAssignVibe.rule(vibe),
          ConditionsVibe.rule(vibe),
        ];
        return vibe;
      },
    };
  }

  resolveSubContents(): any[] {
    return (this.content as ts.Block).statements;
  }

  allowDescription(): string {
    return "renderFn body: return / const / if / render()";
  }

  computeResults(): VibeStatus[] {
    return [];
  }
}
