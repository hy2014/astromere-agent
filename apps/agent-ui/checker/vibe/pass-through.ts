import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "./vibe";
import { isConstantLiteral } from "../rules/check-no-mutable-module-vars";

/**
 * Pass-through Vibe: does not throw errors or check child nodes; it is just a
 * placeholder so the parent node knows this child is valid and needs no further recursion.
 *
 * resolveSubContents → [] → the resolve loop body will not execute
 * computeResults    → [] → no stateful output
 */
export abstract class PassThroughVibe extends Vibe {
  resolveSubContents(): any[] {
    return [];
  }

  computeResults(): VibeStatus[] {
    return [];
  }
}

/**
 * module-level literal constants such as const MAX = 10 / const NAME = "hello"
 */
export class ConstVibe extends PassThroughVibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "const",
      priority: 10,
      match: (node) => {
        if (!ts.isVariableStatement(node)) return false;
        if ((node.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
        return node.declarationList.declarations.every(
          (d: ts.VariableDeclaration) => !!d.initializer && isConstantLiteral(d.initializer),
        );
      },
      make: (_, node) => new ConstVibe("ConstVibe", parentVibe, node),
    };
  }

  allowDescription(): string {
    return "const 字面量常量声明";
  }
}

// ─── ImportVarVibeStatus ───────────────────────────────────────────────

export class ImportVarVibeStatus extends VibeStatus {
  constructor(
    public varName: string,
    public fromFileName: string,
  ) {
    super("ImportVibe");
  }
}

/**
 * import { X, Y } from "./foo"
 * import X from "./foo"
 *
 * import * and side-effect imports are not allowed
 */
export class ImportVibe extends Vibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "import",
      priority: 10,
      match: (node) => {
        if (!ts.isImportDeclaration(node)) return false;
        if (!node.importClause) return false; // side-effect import
        if (!node.importClause.namedBindings) {
          // import X from "./foo" (default import)
          return true;
        }
        // import { X } from "./foo" (named imports)
        return ts.isNamedImports(node.importClause.namedBindings);
      },
      make: (_, node) => new ImportVibe("ImportVibe", parentVibe, node, parentVibe.status),
    };
  }

  resolveSubContents(): any[] {
    return [];
  }

  allowDescription(): string {
    return "import { X } / import X from";
  }

  computeResults(): VibeStatus[] {
    const decl = this.content as ts.ImportDeclaration;
    const modulePath = (decl.moduleSpecifier as ts.StringLiteral).text;
    const imports: ImportVarVibeStatus[] = [];

    if (decl.importClause?.namedBindings) {
      // import { X, Y } from "./foo"
      const bindings = decl.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const elem of bindings.elements) {
          imports.push(new ImportVarVibeStatus(elem.name.text, modulePath));
        }
      }
    } else if (decl.importClause?.name) {
      // import X from "./foo"
      imports.push(new ImportVarVibeStatus(decl.importClause.name.text, modulePath));
    }

    return imports;
  }
}

/**
 * interface XxxProps { ... } / type Xxx = ...
 */
export class TypeVibe extends PassThroughVibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "type",
      priority: 10,
      match: (node) =>
        ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node),
      make: (_, node) => new TypeVibe("TypeVibe", parentVibe, node),
    };
  }

  allowDescription(): string {
    return "interface / type 类型声明";
  }
}
