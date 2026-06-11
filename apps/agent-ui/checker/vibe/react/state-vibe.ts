import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "../vibe";
import { DeclaredVarStatus } from "../assign";

export class StateVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "state",
      priority: 95,
      match: (node) => {
        if (!ts.isVariableStatement(node)) return false;
        if ((node.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
        const decl = node.declarationList.declarations[0];
        if (!decl || !decl.initializer) return false;
        if (!ts.isArrayBindingPattern(decl.name)) return false;
        if (!ts.isCallExpression(decl.initializer)) return false;
        const callee = decl.initializer.expression;
        return ts.isIdentifier(callee) && callee.text === "useState";
      },
      make: (_, node) => {
        const vibe = new StateVibe("StateVibe", parentVibe, node, parentVibe.status);
        return vibe;
      },
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "const [state, setState] = useState(init);";
  }

  computeResults(): VibeStatus[] {
    const stmt = this.content as ts.VariableStatement;
    const decl = stmt.declarationList.declarations[0];
    const nameNode = decl.name as ts.ArrayBindingPattern;
    const elements = nameNode.elements;

    const results: DeclaredVarStatus[] = [];
    if (elements.length >= 1) {
      const stateEl = elements[0];
      if (ts.isBindingElement(stateEl) && ts.isIdentifier(stateEl.name)) {
        results.push(new DeclaredVarStatus(stateEl.name.text, "StateVibe", false, "state"));
      }
    }
    if (elements.length >= 2) {
      const setterEl = elements[1];
      if (ts.isBindingElement(setterEl) && ts.isIdentifier(setterEl.name)) {
        results.push(new DeclaredVarStatus(setterEl.name.text, "StateVibe", false, "stateSetter"));
      }
    }
    return results;
  }

  checkStatus(): { rule: string; message: string; node: any } | null {
    return null;
  }
}
