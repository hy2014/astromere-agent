import * as ts from "typescript";
import { Vibe } from "../vibe";
import { WriteStateVibe } from "../write-state";

const DUMMY_PARENT = { name: "test" } as unknown as Vibe;

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("test.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function test(
  description: string,
  code: string,
  expected: boolean,
) {
  const sf = parse(code);
  const rule = WriteStateVibe.rule(DUMMY_PARENT);
  const stmts = sf.statements;
  const result = stmts.length > 0 ? rule.match(stmts[0]) : false;

  const pass = result === expected;
  const status = pass ? "PASS" : "FAIL";
  console.log(`${status} | ${description}`);
  if (!pass) {
    console.log(`       expected: ${expected}, got: ${result}`);
    console.log(`       code: ${code}`);
  }
}

// ====== should match ======
test("const WriteState = {}", `const WriteState = {};`, true);
test("const WriteState = {} as any", `const WriteState = {} as any;`, true);
test("const WriteState: Typed = {} as any", `const WriteState: { setRows: () => void } = {} as any;`, true);
test("const WriteState = {}", `const WriteState = { setRows: (v) => v };`, true);
test("const WriteState: SomeType = val", `const WriteState: SomeType = val;`, true);

// ====== should NOT match ======
test("export const WriteState = {}", `export const WriteState = {};`, false);
test("let WriteState = {}", `let WriteState = {};`, false);
test("var WriteState = {}", `var WriteState = {};`, false);
test("const OtherName = {}", `const OtherName = {};`, false);
test("function WriteState() {}", `function WriteState() {}`, false);
test("const WriteState: X = {} with export", `export const WriteState: { x: number } = {} as any;`, false);
test("const WriteState = function() {}", `const WriteState = function() {};`, false);
test("const WriteState = () => {}", `const WriteState = () => {};`, false);
