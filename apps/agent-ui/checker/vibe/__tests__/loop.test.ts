import * as ts from "typescript";
import { Vibe } from "../vibe";
import { LoopVibe } from "../common/loop";
import { DeclaredVarStatus } from "../assign";

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

function getLoopStmt(code: string): ts.Statement | undefined {
  const sf = parse(code);
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  return fn.body?.statements[0];
}

// ─── match ─────────────────────────────────────────────────────────────

test("LoopVibe: match for", () => {
  const stmt = getLoopStmt(`function f() { for (let i = 0; i < 10; i++) { fn(); } }`);
  const rule = LoopVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
});

test("LoopVibe: match for...of", () => {
  const stmt = getLoopStmt(`function f() { for (const item of items) { fn(item); } }`);
  const rule = LoopVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
});

test("LoopVibe: match while", () => {
  const stmt = getLoopStmt(`function f() { while (cond) { fn(); } }`);
  const rule = LoopVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
});

test("LoopVibe: no match const", () => {
  const stmt = getLoopStmt(`function f() { const x = 5; }`);
  const rule = LoopVibe.rule(DUMMY_PARENT);
  if (stmt && rule.match(stmt)) throw new Error("expected no match");
});

// ─── loop var extraction ───────────────────────────────────────────────

test("LoopVibe: for...of extracts item var", () => {
  const stmt = getLoopStmt(`function f() { for (const item of items) { fn(item); } }`);
  const rule = LoopVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  // status should contain item
  const found = vibe.status.some(
    (s) => s instanceof DeclaredVarStatus && s.name === "item",
  );
  if (!found) throw new Error("item not in status");
});

test("LoopVibe: for with i extracts i", () => {
  const stmt = getLoopStmt(`function f() { for (let i = 0; i < 10; i++) { fn(i); } }`);
  const rule = LoopVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  const found = vibe.status.some(
    (s) => s instanceof DeclaredVarStatus && s.name === "i",
  );
  if (!found) throw new Error("i not in status");
});

test("LoopVibe: computeResults is []", () => {
  const stmt = getLoopStmt(`function f() { for (const item of items) { fn(item); } }`);
  const rule = LoopVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  if (r.results.length !== 0) throw new Error(`expected empty results, got ${r.results.length}`);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
