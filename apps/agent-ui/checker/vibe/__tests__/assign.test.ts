import * as ts from "typescript";
import { Vibe } from "../vibe";
import { DefineAssignVibe, SetVibe, DeclaredVarStatus } from "../assign";

// ─── helpers ───────────────────────────────────────────────────────────

const DUMMY_PARENT = { name: "test", status: [] } as unknown as Vibe;

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("test.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

let passCount = 0;
let failCount = 0;

function test(description: string, fn: () => void) {
  try {
    fn();
    passCount++;
    console.log(`PASS | ${description}`);
  } catch (e) {
    failCount++;
    console.log(`FAIL | ${description}`);
    console.log(`       ${(e as Error).message}`);
  }
}

// ─── DefineAssignVibe match ────────────────────────────────────────────

test("DefineAssignVibe: const x = 5", () => {
  const sf = parse(`const x = 5;`);
  const rule = DefineAssignVibe.rule(DUMMY_PARENT);
  if (!rule.match(sf.statements[0])) throw new Error("expected match");
});

test("DefineAssignVibe: let x = 5", () => {
  const sf = parse(`let x = 5;`);
  const rule = DefineAssignVibe.rule(DUMMY_PARENT);
  if (!rule.match(sf.statements[0])) throw new Error("expected match");
});

test("DefineAssignVibe: var x = 5", () => {
  const sf = parse(`var x = 5;`);
  const rule = DefineAssignVibe.rule(DUMMY_PARENT);
  if (!rule.match(sf.statements[0])) throw new Error("expected match");
});

test("DefineAssignVibe: const { a, b } = obj", () => {
  const sf = parse(`const { a, b } = obj;`);
  const rule = DefineAssignVibe.rule(DUMMY_PARENT);
  if (!rule.match(sf.statements[0])) throw new Error("expected match");
});

test("DefineAssignVibe: const [a, b] = arr", () => {
  const sf = parse(`const [a, b] = arr;`);
  const rule = DefineAssignVibe.rule(DUMMY_PARENT);
  if (!rule.match(sf.statements[0])) throw new Error("expected match");
});

// ─── DefineAssignVibe no match ─────────────────────────────────────────

test("DefineAssignVibe: x = 5 (no keyword)", () => {
  const sf = parse(`x = 5;`);
  const rule = DefineAssignVibe.rule(DUMMY_PARENT);
  if (rule.match(sf.statements[0])) throw new Error("expected no match");
});

// ─── DefineAssignVibe status ───────────────────────────────────────────

test("DefineAssignVibe: const x = 5 produces status", () => {
  const sf = parse(`const x = 5;`);
  const rule = DefineAssignVibe.rule(DUMMY_PARENT);
  const stmt = sf.statements[0];
  const vibe = rule.make(DUMMY_PARENT, stmt);
  const result = vibe.resolve();
  if ("violations" in result) throw new Error(`violation: ${result.violations[0].message}`);
  const names = result.results.filter((s): s is DeclaredVarStatus => s instanceof DeclaredVarStatus).map(s => s.name);
  if (names.length !== 1 || names[0] !== "x") throw new Error(`expected ["x"], got ${JSON.stringify(names)}`);
});

test("DefineAssignVibe: destructure produces multiple status", () => {
  const sf = parse(`const { a, b } = obj;`);
  const rule = DefineAssignVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, sf.statements[0]);
  const result = vibe.resolve();
  if ("violations" in result) throw new Error(`violation: ${result.violations[0].message}`);
  const names = result.results.filter((s): s is DeclaredVarStatus => s instanceof DeclaredVarStatus).map(s => s.name);
  if (JSON.stringify(names.sort()) !== JSON.stringify(["a", "b"])) throw new Error(`unexpected names: ${names}`);
});

test("DefineAssignVibe: array destructure", () => {
  const sf = parse(`const [a, b] = arr;`);
  const rule = DefineAssignVibe.rule(DUMMY_PARENT);
  const vibe = rule.make(DUMMY_PARENT, sf.statements[0]);
  const result = vibe.resolve();
  if ("violations" in result) throw new Error(`violation: ${result.violations[0].message}`);
  const names = result.results.filter((s): s is DeclaredVarStatus => s instanceof DeclaredVarStatus).map(s => s.name);
  if (JSON.stringify(names.sort()) !== JSON.stringify(["a", "b"])) throw new Error(`unexpected names: ${names}`);
});

// ─── SetVibe match ─────────────────────────────────────────────────────

test("SetVibe: x = 5", () => {
  const sf = parse(`x = 5;`);
  const rule = SetVibe.rule(DUMMY_PARENT);
  if (!rule.match(sf.statements[0])) throw new Error("expected match");
});

test("SetVibe: obj.prop = val", () => {
  const sf = parse(`obj.prop = val;`);
  const rule = SetVibe.rule(DUMMY_PARENT);
  if (!rule.match(sf.statements[0])) throw new Error("expected match");
});

test("SetVibe: arr[0] = val", () => {
  const sf = parse(`arr[0] = val;`);
  const rule = SetVibe.rule(DUMMY_PARENT);
  if (!rule.match(sf.statements[0])) throw new Error("expected match");
});

// ─── SetVibe no match ──────────────────────────────────────────────────

test("SetVibe: fn() (not assignment)", () => {
  const sf = parse(`fn();`);
  const rule = SetVibe.rule(DUMMY_PARENT);
  if (rule.match(sf.statements[0])) throw new Error("expected no match");
});

// ─── Results ───────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
