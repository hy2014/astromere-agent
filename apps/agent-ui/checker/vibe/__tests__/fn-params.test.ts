import * as ts from "typescript";
import { Vibe } from "../vibe";
import { FnArgsVibe, SimpleParamVibe, DestructureParamVibe, ParamVarStatus } from "../fn-params-vibe";
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

function paramsOf(code: string): ts.ParameterDeclaration[] {
  const sf = parse(code);
  const decl = sf.statements[0];
  if (ts.isFunctionDeclaration(decl)) return decl.parameters as ts.ParameterDeclaration[];
  if (ts.isVariableStatement(decl)) {
    const vd = decl.declarationList.declarations[0];
    if (vd?.initializer && ts.isArrowFunction(vd.initializer)) {
      return vd.initializer.parameters as ts.ParameterDeclaration[];
    }
  }
  throw new Error("not a function");
}

function getParamStatus(param: ts.ParameterDeclaration) {
  const rule = SimpleParamVibe.rule(DUMMY_PARENT);
  if (!rule.match(param)) {
    const drule = DestructureParamVibe.rule(DUMMY_PARENT);
    if (!drule.match(param)) throw new Error("no rule matched");
    const vibe = drule.make(DUMMY_PARENT, param);
    const r = vibe.resolve();
    if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
    return r.results.filter((s): s is ParamVarStatus => s instanceof ParamVarStatus);
  }
  const vibe = rule.make(DUMMY_PARENT, param);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  return r.results.filter((s): s is ParamVarStatus => s instanceof ParamVarStatus);
}

// ─── SimpleParamVibe ───────────────────────────────────────────────────

test("SimpleParamVibe: name: string", () => {
  const ps = paramsOf(`function f(name: string) {}`);
  const status = getParamStatus(ps[0]);
  if (status[0].name !== "name" || status[0].type !== "string") throw new Error("wrong status");
});

test("SimpleParamVibe: x = 5 (default)", () => {
  const ps = paramsOf(`function f(x = 5) {}`);
  const status = getParamStatus(ps[0]);
  if (status[0].defaultValue !== "5") throw new Error("wrong default");
});

test("SimpleParamVibe: no type, no default", () => {
  const ps = paramsOf(`function f(x) {}`);
  const status = getParamStatus(ps[0]);
  if (status[0].type !== undefined) throw new Error("expected no type");
  if (status[0].defaultValue !== undefined) throw new Error("expected no default");
});

// ─── DestructureParamVibe ──────────────────────────────────────────────

test("DestructureParamVibe: { a, b }: Type", () => {
  const ps = paramsOf(`function f({ a, b }: { a: number; b: string }) {}`);
  const status = getParamStatus(ps[0]);
  const names = status.map((s) => s.name);
  if (JSON.stringify(names.sort()) !== JSON.stringify(["a", "b"])) throw new Error(`bad names: ${names}`);
  if (status[0].type === undefined) throw new Error("expected type");
});

test("DestructureParamVibe: [x, y]", () => {
  const ps = paramsOf(`function f([x, y]: [number, number]) {}`);
  const status = getParamStatus(ps[0]);
  const names = status.map((s) => s.name);
  if (JSON.stringify(names.sort()) !== JSON.stringify(["x", "y"])) throw new Error(`bad names: ${names}`);
});

test("DestructureParamVibe: instanceof DeclaredVarStatus", () => {
  const ps = paramsOf(`function f({ a }: { a: number }) {}`);
  const status = getParamStatus(ps[0]);
  if (!(status[0] instanceof DeclaredVarStatus)) throw new Error("not instanceof DeclaredVarStatus");
});

// ─── FnArgsVibe ────────────────────────────────────────────────────────

test("FnArgsVibe: aggregate all params", () => {
  const sf = parse(`function f(a: string, { b, c }: { b: number; c: boolean }) {}`);
  const decl = sf.statements[0];
  const rule = FnArgsVibe.rule(DUMMY_PARENT);
  if (!rule.match(decl)) throw new Error("FnArgsVibe should match");
  const vibe = rule.make(DUMMY_PARENT, decl);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  const names = r.results
    .filter((s): s is ParamVarStatus => s instanceof ParamVarStatus)
    .map((s) => s.name);
  if (JSON.stringify(names.sort()) !== JSON.stringify(["a", "b", "c"])) throw new Error(`bad names: ${names}`);
});

// ─── Results ───────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
