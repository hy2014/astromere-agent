import * as ts from "typescript";
import { Vibe } from "../vibe";
import { ReturnVibe } from "../common/expr";

const DUMMY_PARENT = { name: "test", status: [] } as unknown as Vibe;

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("test.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

let passCount = 0;
let failCount = 0;

function test(description: string, fn: () => void) {
  try { fn(); passCount++; console.log(`PASS | ${description}`); }
  catch (e) { failCount++; console.log(`FAIL | ${description}\n       ${(e as Error).message}`); }
}

test("ReturnVibe: match return statement", () => {
  const sf = parse(`function f() { return 5; }`);
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  const stmt = fn.body?.statements[0];
  const rule = ReturnVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
});

test("ReturnVibe: no match on assignment", () => {
  const sf = parse(`function f() { const x = 5; }`);
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  const stmt = fn.body?.statements[0];
  const rule = ReturnVibe.rule(DUMMY_PARENT);
  if (stmt && rule.match(stmt)) throw new Error("expected no match");
});

test("ReturnVibe: resolve with expression", () => {
  const sf = parse(`function f() { return x + 1; }`);
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  const stmt = fn.body?.statements[0];
  const rule = ReturnVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
  const vibe = rule.make(DUMMY_PARENT, stmt);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

test("ReturnVibe: resolve empty return", () => {
  const sf = parse(`function f() { return; }`);
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  const stmt = fn.body?.statements[0];
  const rule = ReturnVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
  const vibe = rule.make(DUMMY_PARENT, stmt);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
