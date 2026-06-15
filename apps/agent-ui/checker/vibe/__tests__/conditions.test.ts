import * as ts from "typescript";
import { Vibe } from "../vibe";
import { ConditionsVibe } from "../common/conditions";
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

function getStmt(code: string): ts.Statement | undefined {
  const sf = parse(code);
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  return fn.body?.statements[0];
}

// ─── match ─────────────────────────────────────────────────────────────

test("ConditionsVibe: match if", () => {
  const stmt = getStmt(`function f() { if (x) { fn(); } }`);
  const rule = ConditionsVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
});

test("ConditionsVibe: match if/else", () => {
  const stmt = getStmt(`function f() { if (x) { fn(); } else { bar(); } }`);
  const rule = ConditionsVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
});

test("ConditionsVibe: match if/else-if/else", () => {
  const stmt = getStmt(`function f() { if (x) { fn(); } else if (y) { bar(); } else { baz(); } }`);
  const rule = ConditionsVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
});

test("ConditionsVibe: no match const", () => {
  const stmt = getStmt(`function f() { const x = 5; }`);
  const rule = ConditionsVibe.rule(DUMMY_PARENT);
  if (stmt && rule.match(stmt)) throw new Error("expected no match");
});

// ─── resolve ───────────────────────────────────────────────────────────

test("ConditionsVibe: resolve if/else", () => {
  const stmt = getStmt(`function f() { if (x) { const a = 1; } else { const b = 2; } }`);
  const rule = ConditionsVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  if (r.results.length !== 0) throw new Error(`expected empty, got ${r.results.length}`);
});

test("ConditionsVibe: no leak outer var", () => {
  const stmt = getStmt(`function f() { if (x) { const a = 1; } }`);
  const rule = ConditionsVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  // block scope: a 不应泄漏
  if (r.results.length !== 0) throw new Error(`expected empty, got ${r.results.length}`);
});

test("ConditionsVibe: nested if resolves", () => {
  const stmt = getStmt(
    `function f() { if (x) { if (y) { const a = 1; } } }`,
  );
  const rule = ConditionsVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

// ─── no {} violation ───────────────────────────────────────────────────

test("ConditionsVibe: if without {} is violation", () => {
  const stmt = getStmt(`function f() { if (x) fn(); }`);
  const rule = ConditionsVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("results" in r) throw new Error("expected violation");
  if (!r.violations[0].message.includes("花括号")) throw new Error(`bad msg: ${r.violations[0].message}`);
});

test("ConditionsVibe: else without {} is violation", () => {
  const stmt = getStmt(`function f() { if (x) { fn(); } else bar(); }`);
  const rule = ConditionsVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("results" in r) throw new Error("expected violation");
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
