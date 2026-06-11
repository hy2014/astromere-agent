import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "./vibe";
import { DeclaredVarStatus, DefineAssignVibe } from "./assign";
import { ImportVibe, TypeVibe } from "./pass-through";
import { WriteStateVibe } from "./write-state";
import { FnVibe, DeclareFuncVibeStatus } from "./fn-vibe";
import { ViewFnVibe } from "./react/view-fn-vibe";
import { RenderFnVibe } from "./react/render-fn-vibe";

export class FileVibe extends Vibe {
  private _declaredResults: VibeStatus[] = [];

  static fromFile(sourceFile: ts.SourceFile): FileVibe {
    const vibe = new FileVibe("FileVibe", null, sourceFile);
    vibe.subVibeRules = [
      ViewFnVibe.rule(vibe),
      RenderFnVibe.rule(vibe),
      WriteStateVibe.rule(vibe),
      DefineAssignVibe.rule(vibe),
      ImportVibe.rule(vibe),
      TypeVibe.rule(vibe),
      FnVibe.rule(vibe),
    ];
    return vibe;
  }

  resolve(): { results: VibeStatus[] } | { violations: { rule: string; message: string; node: any }[] } {
    const children = this.resolveSubContents();
    this._declaredResults = [];

    for (const child of children) {
      if (!child) continue;

      const matched = this.subVibeRules
        .filter((r) => r.match(child))
        .sort((a, b) => b.priority - a.priority);

      const best = matched[0];
      if (!best) {
        return {
          violations: [{
            rule: "vibe 操作许可",
            message: `${String(child).slice(0, 40)} 不在 ${this.name} 的许可操作中\n当前 ${this.name} 允许：${this.allowDescription()}`,
            node: child,
          }],
        };
      }

      const sub = best.make(this, child);
      const out = sub.resolve();
      if ("violations" in out) return out;

      this.status = this.status.concat(out.results);
      this._declaredResults = this._declaredResults.concat(out.results);
    }

    const check = this.checkStatus();
    if (check) return { violations: [check] };

    return { results: this.computeResults() };
  }

  resolveSubContents(): any[] {
    return (this.content as ts.SourceFile).statements;
  }

  allowDescription(): string {
    return "文件级声明: import / const / type / function / WriteState";
  }

  computeResults(): VibeStatus[] {
    return this._declaredResults.filter(
      (s) =>
        (s instanceof DeclareFuncVibeStatus && s.isExported) ||
        (s instanceof DeclaredVarStatus && s.isExported),
    );
  }
}
