import * as ts from "typescript";
import { Vibe } from "../vibe";
import { FnVibe, DeclareFuncVibeStatus } from "../fn-vibe";
import { DeclaredVarStatus } from "../assign";
import { ParamVarStatus } from "../fn-params-vibe";

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

// ─── match ─────────────────────────────────────────────────────────────

test("FnVibe: match function declaration", () => {
  const sf = parse(`function foo(a: string) { const x = 5; }`);
  const rule = FnVibe.rule(DUMMY_PARENT);
  if (!rule.match(sf.statements[0])) throw new Error("expected match");
});

test("FnVibe: no match arrow function", () => {
  const sf = parse(`const foo = (a: string) => { const x = 5; };`);
  const rule = FnVibe.rule(DUMMY_PARENT);
  if (rule.match(sf.statements[0])) throw new Error("expected no match");
});

test("FnVibe: no match const literal", () => {
  const sf = parse(`const x = 5;`);
  const rule = FnVibe.rule(DUMMY_PARENT);
  if (rule.match(sf.statements[0])) throw new Error("expected no match");
});

// ─── resolve ───────────────────────────────────────────────────────────

test("FnVibe: computeResults → DeclareFuncVibeStatus", () => {
  const sf = parse(`function foo(a: string) { const x = 5; }`);
  const rule = FnVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, sf.statements[0]);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  const status = r.results.filter((s): s is DeclareFuncVibeStatus => s instanceof DeclareFuncVibeStatus);
  if (status.length !== 1) throw new Error(`expected 1 DeclareFuncVibeStatus, got ${status.length}`);
  if (status[0].functionName !== "foo") throw new Error(`bad name: ${status[0].functionName}`);
});

test("FnVibe: status has params", () => {
  const sf = parse(`function foo(a: string, b: number) { const x = 5; }`);
  const rule = FnVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, sf.statements[0]);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  // params 在 status 中，body vars 在 BodyVibe.status 中
  const declared = vibe.status.filter((s): s is DeclaredVarStatus => s instanceof DeclaredVarStatus);
  const names = declared.map((s) => s.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(["a", "b"])) {
    throw new Error(`bad status names: ${names}`);
  }
});

test("FnVibe: body var assignment finds param", () => {
  // a 是参数，body 里 a = 5 应该合法
  const sf = parse(`function foo(a: number) { a = 5; }`);
  const rule = FnVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, sf.statements[0]);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
