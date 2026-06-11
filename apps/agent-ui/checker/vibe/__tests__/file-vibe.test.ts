import * as ts from "typescript";
import { FileVibe } from "../file-vibe";
import { DeclareFuncVibeStatus } from "../fn-vibe";
import { ImportVarVibeStatus } from "../pass-through";
import { VibeStatus } from "../vibe";

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("test.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

let passCount = 0;
let failCount = 0;

function test(description: string, fn: () => void) {
  try { fn(); passCount++; console.log(`PASS | ${description}`); }
  catch (e) { failCount++; console.log(`FAIL | ${description}\n       ${(e as Error).message}`); }
}

test("FileVibe: resolve simple file", () => {
  const sf = parse(`
    import { something } from "./foo";
    const MAX = 10;
    function hello() { const x = 5; }
  `);
  const vibe = FileVibe.fromFile(sf);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

test("FileVibe: result has exported functions only", () => {
  const sf = parse(`
    export function hello() { const x = 5; }
    export function bar() { return 5; }
    function internal() { }
  `);
  const vibe = FileVibe.fromFile(sf);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  const funcs = r.results.filter((s): s is DeclareFuncVibeStatus => s instanceof DeclareFuncVibeStatus);
  if (funcs.length !== 2) throw new Error(`expected 2 exported functions, got ${funcs.length}`);
  const names = funcs.map((f) => f.functionName).sort();
  if (JSON.stringify(names) !== JSON.stringify(["bar", "hello"])) {
    throw new Error(`bad names: ${names}`);
  }
});

test("FileVibe: status has all functions", () => {
  const sf = parse(`
    export function hello() { const x = 5; }
    function internal() { }
  `);
  const vibe = FileVibe.fromFile(sf);
  const r = vibe.resolve();
  const allFuncs = vibe.status.filter(
    (s): s is DeclareFuncVibeStatus => s instanceof DeclareFuncVibeStatus,
  );
  if (allFuncs.length !== 2) throw new Error(`expected 2 in status, got ${allFuncs.length}`);
});

test("FileVibe: status has imports", () => {
  const sf = parse(`
    import { load, save } from "./data";
    function main() { load(); }
  `);
  const vibe = FileVibe.fromFile(sf);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  const imports = vibe.status.filter(
    (s): s is ImportVarVibeStatus => s instanceof ImportVarVibeStatus,
  );
  if (imports.length !== 2) throw new Error(`expected 2 imports, got ${imports.length}`);
});

test("FileVibe: import * is violation", () => {
  const sf = parse(`import * as foo from "./bar";`);
  const vibe = FileVibe.fromFile(sf);
  const r = vibe.resolve();
  if ("results" in r) throw new Error("expected violation for import *");
});

test("FileVibe: side-effect import is violation", () => {
  const sf = parse(`import "./side-effect";`);
  const vibe = FileVibe.fromFile(sf);
  const r = vibe.resolve();
  if ("results" in r) throw new Error("expected violation for side-effect import");
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
