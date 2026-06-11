import * as ts from "typescript";
import { Vibe } from "../vibe";
import { BodyVibe } from "../common/body";
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

function getBlock(code: string): ts.Block {
  const sf = parse(code);
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  const block = fn.body! as ts.Block;
  if (!ts.isBlock(block)) throw new Error("not a block");
  return block;
}

// ─── match ─────────────────────────────────────────────────────────────

test("BodyVibe: match block", () => {
  const block = getBlock(`function f() { const x = 5; }`);
  const rule = BodyVibe.rule(DUMMY_PARENT);
  if (!rule.match(block)) throw new Error("expected match");
});

test("BodyVibe: no match on statement", () => {
  const block = getBlock(`function f() { const x = 5; }`);
  const stmt = block.statements[0];
  const rule = BodyVibe.rule(DUMMY_PARENT);
  if (rule.match(stmt)) throw new Error("expected no match");
});

// ─── resolve ───────────────────────────────────────────────────────────

test("BodyVibe: resolve const x = 5 → DeclaredVarStatus", () => {
  const block = getBlock(`function f() { const x = 5; }`);
  const rule = BodyVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, block);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  if (r.results.length !== 0) throw new Error(`expected empty results, got ${r.results.length}`);
  // DeclaredVarStatus is in vibe.status (lookup), not in results
  const status = vibe.status.filter((s): s is DeclaredVarStatus => s instanceof DeclaredVarStatus);
  if (status.length !== 1 || status[0].name !== "x") throw new Error(`bad status`);
});

test("BodyVibe: resolve multiple statements", () => {
  const block = getBlock(`function f() { const x = 5; const y = 10; }`);
  const rule = BodyVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, block);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  if (r.results.length !== 0) throw new Error(`expected empty results`);
  const names = vibe.status
    .filter((s): s is DeclaredVarStatus => s instanceof DeclaredVarStatus)
    .map(s => s.name);
  if (JSON.stringify(names.sort()) !== JSON.stringify(["x", "y"])) throw new Error(`bad names: ${names}`);
});

test("BodyVibe: resolve with return", () => {
  const block = getBlock(`function f() { const x = 5; return x; }`);
  const rule = BodyVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, block);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

test("BodyVibe: resolve with fn call", () => {
  const block = getBlock(`function f() { const x = 5; fn(x); }`);
  const rule = BodyVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, block);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
