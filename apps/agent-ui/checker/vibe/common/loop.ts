import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { DeclaredVarStatus } from "../assign";
import { BodyVibe } from "./body";

// ─── LoopVarVibe ───────────────────────────────────────────────────────

export class LoopVarVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "loopVar",
      priority: 10,
      match: (node) => ts.isVariableDeclarationList(node),
      make: (_, node) =>
        new LoopVarVibe("LoopVarVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "for 循环变量声明";
  }

  computeResults(): VibeStatus[] {
    const list = this.content as ts.VariableDeclarationList;
    const names: string[] = [];
    for (const decl of list.declarations) {
      if (ts.isIdentifier(decl.name)) {
        names.push(decl.name.text);
      } else if (ts.isObjectBindingPattern(decl.name)) {
        for (const elem of decl.name.elements) {
          if (ts.isIdentifier(elem.name)) names.push(elem.name.text);
        }
      } else if (ts.isArrayBindingPattern(decl.name)) {
        for (const elem of decl.name.elements) {
          if (ts.isBindingElement(elem) && ts.isIdentifier(elem.name)) names.push(elem.name.text);
        }
      }
    }
    return names.map((n) => new DeclaredVarStatus(n, "LoopVarVibe"));
  }
}

// ─── LoopVibe ──────────────────────────────────────────────────────────

export class LoopVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "loop",
      priority: 10,
      match: (node) =>
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node),
      make: (_, node) => {
        const vibe = new LoopVibe("LoopVibe", parentVibe, node, parentVibe.status);
        vibe.subVibeRules = [
          LoopVarVibe.rule(vibe),
          BodyVibe.rule(vibe),
        ];
        return vibe;
      },
    };
  }

  resolveSubContents(): any[] {
    const node = this.content as ts.IterationStatement;
    const body = node.statement;
    // Extract loop variable declaration
    const initializer = ts.isForStatement(node)
      ? node.initializer
      : ts.isForOfStatement(node) || ts.isForInStatement(node)
        ? (node as ts.ForOfStatement | ts.ForInStatement).initializer
        : null;

    return [
      initializer ?? null,
      body,
    ];
  }

  allowDescription(): string {
    return "for / while / do...while";
  }

  computeResults(): VibeStatus[] {
    return [];
  }
}
