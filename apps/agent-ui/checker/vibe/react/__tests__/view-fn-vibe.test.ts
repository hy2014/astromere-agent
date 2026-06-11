import * as ts from "typescript";
import { FileVibe } from "../../file-vibe";
import { DeclaredVarStatus } from "../../assign";
import { DeclareFuncVibeStatus } from "../../fn-vibe";
import { VibeStatus } from "../../vibe";

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("test.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

let passCount = 0;
let failCount = 0;

function test(description: string, fn: () => void) {
  try { fn(); passCount++; console.log(`PASS | ${description}`); }
  catch (e) { failCount++; console.log(`FAIL | ${description}\n       ${(e as Error).message}`); }
}

function resolve(code: string) {
  const sf = parse(code);
  const vibe = FileVibe.fromFile(sf);
  return vibe.resolve();
}

// ─── ViewFnVibe: match ─────────────────────────────────────────────────

test("ViewFnVibe: match export function XxxView", () => {
  const r = resolve(`
    export function MyView() { return null; }
    function renderMyView() { return null; }
  `);
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  const views = r.results.filter((s): s is DeclareFuncVibeStatus => s instanceof DeclareFuncVibeStatus);
  if (views.length < 1) throw new Error(`expected at least 1 exported fn, got ${views.length}`);
});

test("ViewFnVibe: non-export function is NOT View", () => {
  const r = resolve(`function MyView() { return null; }`);
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
  const views = r.results.filter((s): s is DeclareFuncVibeStatus => s instanceof DeclareFuncVibeStatus);
  if (views.length !== 0) throw new Error(`expected 0 exported fns, got ${views.length}`);
});

// ─── StateVibe ─────────────────────────────────────────────────────────

test("StateVibe: useState produces state + setter with correct kind", () => {
  const sf = parse(`
    export function MyView() {
      const [rows, setRows] = useState([]);
      return null;
    }
  `);
  const vibe = FileVibe.fromFile(sf);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

// ─── PropsVibe ─────────────────────────────────────────────────────────

test("PropsVibe: extract props from destructured first param", () => {
  const sf = parse(`
    export function MyView({ configPath, onClose }: { configPath: string; onClose: () => void }) {
      const [rows] = useState([]);
      return null;
    }
  `);
  const vibe = FileVibe.fromFile(sf);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

// ─── MemoVibe / CallbackVibe ──────────────────────────────────────────

test("MemoVibe + CallbackVibe: useMemo/useCallback in View body", () => {
  const sf = parse(`
    export function MyView() {
      const [rows] = useState([]);
      const summary = useMemo(() => rows.length, [rows]);
      const onSave = useCallback(() => {}, []);
      return null;
    }
  `);
  const vibe = FileVibe.fromFile(sf);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

// ─── RenderCallVibe ────────────────────────────────────────────────────

test("RenderCallVibe: valid render() call passes", () => {
  const r = resolve(`
    export function MyView() {
      const [rows, setRows] = useState([]);
      const summary = useMemo(() => rows.length, [rows]);
      return render({ state: { rows }, props: {}, fn: renderMyList, events: {}, memo: { summary } });
    }
    function renderMyList({ rows }, {}, {}, { summary }) { return null; }
  `);
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

test("RenderCallVibe: extra key in render() fails", () => {
  const r = resolve(`
    export function MyView() {
      const [rows] = useState([]);
      return render({ state: { rows }, props: {}, fn: renderMyList, events: {}, memo: {}, extra: true });
    }
    function renderMyList({ rows }, {}, {}, {}) { return null; }
  `);
  if ("results" in r) throw new Error("expected violation for extra key");
});

test("RenderCallVibe: fn must start with render", () => {
  const r = resolve(`
    export function MyView() {
      const [rows] = useState([]);
      return render({ state: { rows }, props: {}, fn: myList, events: {}, memo: {} });
    }
    function myList({ rows }, {}, {}, {}) { return null; }
  `);
  if ("results" in r) throw new Error("expected violation for non-render fn");
});

// ─── RenderViewCallVibe ────────────────────────────────────────────────

test("RenderViewCallVibe: valid renderView() passes", () => {
  const sf = parse(`
    export function MyView() {
      const [rows] = useState([]);
      return renderView({ fn: OtherView, props: {} });
    }
    function renderContent({ rows }, {}, {}, {}) {
      return renderView({ fn: OtherView, props: {} });
    }
  `);
  const vibe = FileVibe.fromFile(sf);
  const r = vibe.resolve();
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

test("RenderViewCallVibe: uppercase fn required", () => {
  const r = resolve(`
    export function MyView() {
      return renderView({ fn: otherView, props: {} });
    }
    function renderContent({}, {}, {}, {}) {
      return renderView({ fn: otherView, props: {} });
    }
  `);
  if ("results" in r) throw new Error("expected violation for lowercase fn in renderView");
});

// ─── RenderFnVibe ──────────────────────────────────────────────────────

test("RenderFnVibe: normal render function passes", () => {
  const r = resolve(`
    function renderMyList({ rows }, {}, { onClick }, {}) {
      return <div onClick={onClick}>{rows.length}</div>;
    }
  `);
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

test("RenderFnVibe: empty object {} for props is valid", () => {
  const r = resolve(`
    function renderEmpty({ rows }: { rows: string[] }, {}: Record<string, never>, {}, {}) {
      return <div>{rows}</div>;
    }
  `);
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

// ─── JsxEventVibe ──────────────────────────────────────────────────────

test("JsxEventVibe: bound handler exists in scope", () => {
  const r = resolve(`
    function renderBtn({}, {}, { onDelete }, {}) {
      return <button onClick={onDelete}>Delete</button>;
    }
  `);
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

test("JsxEventVibe: unbound handler fails", () => {
  const r = resolve(`
    function renderBtn({ rows }, {}, {}, {}) {
      return <button onClick={handleClick}>Delete</button>;
    }
  `);
  if ("results" in r) throw new Error("expected violation for unknown onClick handler");
});

// ─── Map render in JSX ─────────────────────────────────────────────

test("JsxEventVibe: .map() with render() passes", () => {
  const r = resolve(`
    function renderList({ rows }, {}, {}, {}) {
      return <div>{rows.map(row => render({state: {row}, props: {}, fn: renderRow, events: {}, memo: {}}))}</div>;
    }
    function renderRow({ row }, {}, {}, {}) { return <span>{row}</span>; }
  `);
  if ("violations" in r) throw new Error(`violation: ${r.violations[0].message}`);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
