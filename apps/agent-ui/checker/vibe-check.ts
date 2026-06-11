import * as path from "path";
import * as fs from "fs";
import * as ts from "typescript";
import { FileVibe } from "./vibe/file-vibe";
import { Violation } from "./types";
import { getCodeLine } from "./utils";

export function vibeCheck(
  sourceCode: string,
  fileName: string = "component.tsx",
  fsPath?: string,
): Violation[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const vibe = FileVibe.fromFile(sourceFile);
  const result = vibe.resolve();

  if ("results" in result) {
    return [];
  }

  return result.violations.map((v) => {
    const line = v.node
      ? sourceFile.getLineAndCharacterOfPosition(v.node.getStart()).line + 1
      : undefined;
    return {
      rule: v.rule,
      message: v.message,
      node: v.node,
      line,
      codeLine: line ? getCodeLine(sourceCode, line) : undefined,
    };
  });
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npx tsx checker/vibe-check.ts --file <path>");
    process.exit(0);
  }

  const fileIndex = args.indexOf("--file");
  const fIndex = args.indexOf("-f");
  let filePath = "";

  if (fileIndex !== -1 && args.length > fileIndex + 1) {
    filePath = args[fileIndex + 1];
  } else if (fIndex !== -1 && args.length > fIndex + 1) {
    filePath = args[fIndex + 1];
  }

  if (!filePath) {
    console.error("Usage: npx tsx checker/vibe-check.ts --file <path>");
    process.exit(1);
  }

  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`File not found: ${absolutePath}`);
    process.exit(1);
  }

  const sourceCode = fs.readFileSync(absolutePath, "utf-8");
  const fileName = path.basename(absolutePath);
  const violations = vibeCheck(sourceCode, fileName, absolutePath);

  if (violations.length > 0) {
    console.log(`\nVibe check: ${violations.length} violation(s)\n`);
    violations.forEach((v, idx) => {
      console.log(`  ${idx + 1}. [${v.rule}] ${v.message}`);
      if (v.line) console.log(`     line ${v.line}: ${v.codeLine}`);
      console.log();
    });
    process.exit(1);
  }

  console.log("Vibe check passed");
  process.exit(0);
}

if (import.meta.url && process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main();
}
