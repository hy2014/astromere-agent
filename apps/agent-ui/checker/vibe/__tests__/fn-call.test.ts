import * as ts from "typescript";
import { Vibe } from "../vibe";
import { FunctionCallVibe, CallFuncVibeStatus } from "../common/fn-call";

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

function getFirstStmt(code: string): ts.Statement | undefined {
  const sf = parse(code);
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  return fn.body?.statements[0];
}

// ─── match ─────────────────────────────────────────────────────────────

test("FunctionCallVibe: match fn()", () => {
  const stmt = getFirstStmt(`function f() { fn(); }`);
  const rule = FunctionCallVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
});

test("FunctionCallVibe: match obj.method()", () => {
  const stmt = getFirstStmt(`function f() { obj.method(); }`);
  const rule = FunctionCallVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
});

test("FunctionCallVibe: match fn(a, b)", () => {
  const stmt = getFirstStmt(`function f() { fn(a, b); }`);
  const rule = FunctionCallVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
});

test("FunctionCallVibe: no match assignment", () => {
  const stmt = getFirstStmt(`function f() { x = 5; }`);
  const rule = FunctionCallVibe.rule(DUMMY_PARENT);
  if (stmt && rule.match(stmt)) throw new Error("expected no match");
});

test("FunctionCallVibe: no match const", () => {
  const stmt = getFirstStmt(`function f() { const x = 5; }`);
  const rule = FunctionCallVibe.rule(DUMMY_PARENT);
  if (stmt && rule.match(stmt)) throw new Error("expected no match");
});

// ─── resolve ───────────────────────────────────────────────────────────

test("FunctionCallVibe: resolve fn() → CallFuncVibeStatus", () => {
  const stmt = getFirstStmt(`function f() { fn(); }`);
  const rule = FunctionCallVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  const status = r.results.filter((s): s is CallFuncVibeStatus => s instanceof CallFuncVibeStatus);
  if (status.length !== 1) throw new Error(`expected 1 status, got ${status.length}`);
  if (status[0].callee !== "fn") throw new Error(`bad callee: ${status[0].callee}`);
});

test("FunctionCallVibe: resolve fn(a, b) → args", () => {
  const stmt = getFirstStmt(`function f() { fn(a, b); }`);
  const rule = FunctionCallVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  const status = r.results.filter((s): s is CallFuncVibeStatus => s instanceof CallFuncVibeStatus);
  if (JSON.stringify(status[0].args) !== JSON.stringify(["a", "b"]))
    throw new Error(`bad args: ${status[0].args}`);
});

test("FunctionCallVibe: resolve obj.method() → callee", () => {
  const sf = parse(`function f() { obj.method(); }`);
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  const stmt = fn.body?.statements[0];
  const rule = FunctionCallVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  const status = r.results.filter((s): s is CallFuncVibeStatus => s instanceof CallFuncVibeStatus);
  if (status[0].callee !== "obj.method") throw new Error(`bad callee: ${status[0].callee}`);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
