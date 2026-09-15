# React Vibe 扩展设计

目录：`checker/vibe/react/`

## 文件结构

```
react/
  DESIGN.md              ← 本文件
  view-fn-vibe.ts        → ViewFnVibe：React 组件
  state-vibe.ts          → useState
  props-vibe.ts          → Props 提取（基于 FnArgsVibe）
  memo-vibe.ts           → useMemo
  callback-vibe.ts       → useCallback
  effect-vibe.ts         → useEffect
  render-fn-vibe.ts      → renderXXXX
  render-call-vibe.ts    → RenderCallVibe：render() 调用校验
```

## ViewFnVibe

```
ViewFnVibe
  match: FunctionDeclaration + 首字母大写
  priority: 100

  subVibRules:
    1. PropsVibe           — 提取 props（第一个参数）
    2. StateVibe           — const [x, setX] = useState(...)
    3. MemoVibe            — const x = useMemo(...)
    4. CallbackVibe        — const x = useCallback(...)
    5. EffectVibe          — useEffect(...)
    6. DefineAssignVibe    — derived consts（从 props 派生）
    7. ConditionsVibe      — 条件渲染
    8. ReturnVibe          — JSX 返回
    9. RenderCallVibe      — render({state, props, fn, events, memo}) 调用
    10. RenderFnVibe       — renderXXXX 子组件

  checkStatus:
    - 首字母大写 ✓（match 已保证）
    - props 存在

  computeResults → DeclareFuncVibeStatus
```

## 子 Vibe 设计

| Vibe | match | result |
|------|-------|--------|
| StateVibe | `const [x, setX] = useState(...)` | `VarStatus("x")` |
| MemoVibe | `const x = useMemo(...)` | `VarStatus("x")` |
| CallbackVibe | `const x = useCallback(...)` | `VarStatus("x")` |
| EffectVibe | `useEffect(...)` | `[]` |
| PropsVibe | 函数第一个参数（对象解构或 interface） | `ParamVarStatus(kind="props")` |
| RenderFnVibe | `function renderXXXX` | 仅渲染，见下方完整设计 |

## RenderCallVibe

```
RenderCallVibe
  match: ExpressionStatement + CallExpression + callee === "render"

  content: CallExpression（render(...) 整个调用）

  resolveSubContents → []       // leaf，不递归子节点

  checkStatus:
    - 参数是 ObjectLiteralExpression
    - 对象的 keys ⊆ {state, props, fn, events, memo}
    - 每个 Identifier / ShorthandPropertyAssignment 的 name
      存在于 ViewFnVibe.status 图（state var, memo var, callback, etc.）
    - "fn" key 的值必须是 render 函数标识符（renderXXXX）

  computeResults → []          // 不产生新变量
```

### 例子

```typescript
export function McpServersView() {
  const [rows, setRows] = useState([]);      // → status: DeclaredVarStatus("rows")
  const summary = useMemo(() => ..., [rows]); // → status: DeclaredVarStatus("summary")

  return (
    <div>
      {render({
        state: { rows, editingId },           // ← 检查在 status 中
        props: {},
        fn: renderMcpServersViewServerList,   // ← 检查 fn 是 render 函数
        events: { toggleEditing, removeServerRow },
        memo: { summary },                    // ← 检查在 status 中
      })}
    </div>
  );
}
```

## RenderFnVibe

```
RenderFnVibe
  match: FunctionDeclaration + name.startsWith("render")
  priority: 90

  覆写 resolve():
    1. 先提取参数 kind 注入 this.status：
       第 1 个参数（解构或标识符）→ DeclaredVarStatus(name, kind="state")
       第 2 个参数                       → DeclaredVarStatus(name, kind="props")
       第 3 个参数                       → DeclaredVarStatus(name, kind="callback")
       第 4 个参数（可选）                → DeclaredVarStatus(name, kind="memo")
    2. 再正常 resolve body

  subVibRules:
    ReturnVibe          — JSX 返回
    ConditionsVibe      — if/else 条件渲染
    DefineAssignVibe    — 常量（仅当从 props 派生时）

  checkStatus:
    - body 内不允许 StateVibe / MemoVibe / CallbackVibe / EffectVibe
      （不在 subVibeRules 里 → 自动违规）

  computeResults → DeclareFuncVibeStatus
```

### 参数 kind 标记

`ParamVarStatus` 同步加 `kind: string = "var"`，RenderFnVibe 各子 ParamVibe 传特定 kind。

参数结构（参考 mcp.tsx）：

```typescript
function renderMcpServerTable(
  { rows, editingId }: { rows: McpServerDraftRow[]; editingId: string | null },  // state
  {}: Record<string, never>,                                                      // props
  { toggleEditing, removeServerRow }: { toggleEditing: ...; removeServerRow: ...}, // events
  // memo（可选，示例中无）
) {
  return <div>...</div>;
}
```

### 与 ViewFnVibe 对比

| | ViewFnVibe | RenderFnVibe |
|--|-----------|-------------|
| 允许 | State/Memo/Callback/Effect/DefineAssign/Conditions/Return/RenderCall/RenderFn | Return/Conditions/DefineAssign/RenderCall |
| 不允许 | 裸函数调用 | State/Memo/Callback/Effect/SetVibe |
| status 产出 | DeclaredVarStatus(kind="state"/"memo"/"callback") | 参数标记 kind 后注入 |
| result | DeclareFuncVibeStatus | DeclareFuncVibeStatus |

## DeclaredVarStatus.kind 扩展

`DeclaredVarStatus` 增加 `kind: string = "var"` 字段：

```
export class DeclaredVarStatus extends VibeStatus {
  constructor(
    public name: string,
    source: string,
    public isExported: boolean = false,
    public kind: string = "var",
  ) { super(source); }
}
```

React Vibe 各子 Vibe 传特定 kind：

| Vibe | Status 类型 | kind |
|------|-----------|------|
| StateVibe | DeclaredVarStatus | `"state"` |
| MemoVibe | DeclaredVarStatus | `"memo"` |
| CallbackVibe | DeclaredVarStatus | `"callback"` |
| PropsVibe | ParamVarStatus | `"props"` |
| RenderFnVibe param[0] | ParamVarStatus | `"state"` |
| RenderFnVibe param[1] | ParamVarStatus | `"props"` |
| RenderFnVibe param[2] | ParamVarStatus | `"callback"` |
| RenderFnVibe param[3] | ParamVarStatus | `"memo"` |
| DefineAssignVibe（普通） | DeclaredVarStatus | `"var"`（默认） |

> `ParamVarStatus` 同步加 `kind: string = "var"`

RenderCallVibe.checkStatus 按 kind 区分（工作在 ViewFnVibe 和 RenderFnVibe 各自 body 内）：

```
state  key → s.kind === "state"
memo   key → s.kind === "memo"
events key → s.kind === "callback"
```

## 待讨论

- useState/useMemo/useCallback 作为独立 Vibe 还是复用 FunctionCallVibe？
- 是否需要更多 Hooks（useRef, useContext, useLayoutEffect...）？
- renderFnVibe 的约束细节？
- RenderCallVibe 是否要支持 state/props/events/memo 之外的自定义 key？
