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
    addViolation: (rule: string, message: string, node?: ts.Node) => void;
}