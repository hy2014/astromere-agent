import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { ReturnVibe } from "../common/expr";
import { DefineAssignVibe } from "../assign";
import { ConditionsVibe } from "../common/conditions";
import { StateVibe } from "./state-vibe";
import { MemoVibe, CallbackVibe } from "./memo-vibe";
import { EffectVibe } from "./effect-vibe";
import { RenderCallVibe } from "./render-call-vibe";
import { RenderFnVibe } from "./render-fn-vibe";
import { WriteStateAssignVibe } from "./write-state-assign-vibe";

export class ViewBodyVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "viewBody",
      priority: 10,
      match: (node) => ts.isBlock(node),
      make: (_, node) => {
        const vibe = new ViewBodyVibe("ViewBodyVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [
          StateVibe.rule(vibe),
          MemoVibe.rule(vibe),
          CallbackVibe.rule(vibe),
          EffectVibe.rule(vibe),
          WriteStateAssignVibe.rule(vibe),
          RenderFnVibe.rule(vibe),
          RenderCallVibe.rule(vibe),
          DefineAssignVibe.rule(vibe),
          ConditionsVibe.rule(vibe),
          ReturnVibe.rule(vibe),
        ];
        return vibe;
      },
    };
  }

  resolveSubContents(): any[] {
    return (this.content as ts.Block).statements;
  }

  allowDescription(): string {
    return "View 函数体: useState / useMemo / useCallback / useEffect / renderFn / render() / const / if / return";
  }

  computeResults(): VibeStatus[] {
    return [];
  }
}
