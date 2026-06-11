import * as ts from "typescript";
import { Vibe } from "../vibe";
import { TryVibe } from "../common/try";
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

test("TryVibe: match try/catch", () => {
  const stmt = getStmt(`function f() { try { fn(); } catch (e) { log(e); } }`);
  const rule = TryVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
});

test("TryVibe: match try/finally", () => {
  const stmt = getStmt(`function f() { try { fn(); } finally { cleanup(); } }`);
  const rule = TryVibe.rule(DUMMY_PARENT);
  if (!stmt || !rule.match(stmt)) throw new Error("expected match");
});

test("TryVibe: no match const", () => {
  const stmt = getStmt(`function f() { const x = 5; }`);
  const rule = TryVibe.rule(DUMMY_PARENT);
  if (stmt && rule.match(stmt)) throw new Error("expected no match");
});

// ─── catch var ─────────────────────────────────────────────────────────

test("TryVibe: catch var in status", () => {
  const stmt = getStmt(`function f() { try { fn(); } catch (e) { log(e); } }`);
  const rule = TryVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  const found = vibe.status.some(
    (s) => s instanceof DeclaredVarStatus && s.name === "e",
  );
  if (!found) throw new Error("e not in status");
});

test("TryVibe: computeResults is []", () => {
  const stmt = getStmt(`function f() { try { fn(); } catch (e) { log(e); } }`);
  const rule = TryVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  if (r.results.length !== 0) throw new Error(`expected empty, got ${r.results.length}`);
});

test("TryVibe: no catch clause still works", () => {
  const stmt = getStmt(`function f() { try { fn(); } finally { cleanup(); } }`);
  const rule = TryVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, stmt!);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
