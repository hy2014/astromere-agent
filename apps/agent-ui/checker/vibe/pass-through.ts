import * as ts from "typescript";
import { Vibe, VibeStatus, Rule } from "./vibe";
import { isConstantLiteral } from "../rules/check-no-mutable-module-vars";

/**
 * 透传 Vibe：不抛出错误，不检查子节点，仅是占位让父节点
 * 知道这个子节点是合法的，不需要进一步递归。
 *
 * resolveSubContents → [] → resolve 循环体不会执行
 * computeResults    → [] → 无状态产出
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
 * const MAX = 10 / const NAME = "hello" 等模块级字面量常量
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

/**
 * import { X } from "./foo"
 */
export class ImportVibe extends PassThroughVibe {
  static rule(parentVibe: Vibe): Rule {
    return {
      name: "import",
      priority: 10,
      match: (node) => ts.isImportDeclaration(node),
      make: (_, node) => new ImportVibe("ImportVibe", parentVibe, node),
    };
  }

  allowDescription(): string {
    return "import 声明";
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
