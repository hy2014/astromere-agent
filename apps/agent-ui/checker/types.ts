// checker/types.ts
import * as ts from "typescript";

export interface Violation {
    rule: string;
    message: string;
    node?: ts.Node;
    line?: number;
    character?: number;
    codeLine?: string;
}

export interface RuleContext {
    sourceFile: ts.SourceFile;
    sourceCode: string;
    violations: Violation[];
    stateVars: Set<string>;
    propVars: Set<string>;
    memoVars: Set<string>;
    importedViewFns: Set<string>;
    typeChecker?: ts.TypeChecker;
    addViolation: (rule: string, message: string, node?: ts.Node) => void;
}