// parser/parser.ts
//
// 改进记录（对比原始版本）：
// 1. WriteState.setXxx 模式检测（全局 setter 对象）
// 2. Event 绑定精确解析 — events 参数中的名字即文件级函数名，不再猜测 handleXxx
// 3. Exts 跟踪（第4个 render 参数）
// 4. Memo 跟踪（第5个 render 参数）
// 5. render() 调用 → 子 RenderFnNode 的状态/props/ext/memo 传递分析
// 6. 移除内部重复类型定义，统一使用 types.ts
// 7. 支持 Fn 调用链追踪（fn 调 fn，透传 WriteState 回调等）

import { Project, Node, SyntaxKind, type ArrowFunction, type FunctionExpression, type FunctionDeclaration } from "ts-morph";
import type {
    EventBinding,
    FnDetail,
    RenderFnNode,
    ViewNode,
    CodeGraph,
    StateInfo,
    PropInfo,
    ClassifiedCall,
    PropSource,
} from "./types";

const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
});

// ========== IPC 提取 ==========

/**
 * 从 runtime import 中提取 IPC 方法名
 */
export function extractIPCMethods(sourceFile: ReturnType<typeof project.getSourceFile>): string[] {
    const methods: string[] = [];
    if (!sourceFile) return methods;
    sourceFile.getImportDeclarations().forEach(importDecl => {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        if (moduleSpecifier.includes("runtime")) {
            importDecl.getNamedImports().forEach(namedImport => {
                methods.push(namedImport.getName());
            });
        }
    });
    return methods;
}

// ========== State / Props 收集 ==========

/**
 * 收集文件中的所有 useState state 和 Props 类型定义
 */
export function collectStateAndProps(sourceFile: ReturnType<typeof project.getSourceFile>) {
    const states: StateInfo[] = [];
    const props: PropInfo[] = [];
    if (!sourceFile) return { states, props };

    // --- Props 类型 ---
    sourceFile.forEachDescendant((node) => {
        if (Node.isTypeAliasDeclaration(node) && node.getName() === "Props") {
            const typeLiteral = node.getTypeNode();
            if (Node.isTypeLiteral(typeLiteral)) {
                typeLiteral.getMembers().forEach((member) => {
                    if (Node.isPropertySignature(member)) {
                        props.push({ name: member.getName(), type: member.getTypeNode()?.getText() ?? "unknown" });
                    }
                });
            }
        }
    });

    // 防兜底：如果没找到 Props 类型，从 View 函数参数中收集
    if (props.length === 0) {
        sourceFile.forEachDescendant((node) => {
            if (Node.isFunctionDeclaration(node) && node.isExported()) {
                for (const param of node.getParameters()) {
                    if (Node.isObjectBindingPattern(param.getNameNode())) {
                        for (const el of param.getNameNode().getElements()) {
                            props.push({ name: el.getName(), type: "unknown" });
                        }
                    }
                }
            }
        });
    }

    // --- useState ---
    sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        if (node.getExpression().getText() !== "useState") return;
        const parent = node.getParent();
        if (Node.isVariableDeclaration(parent)) {
            const nameNode = parent.getNameNode();
            if (Node.isArrayBindingPattern(nameNode)) {
                const elements = nameNode.getElements();
                if (elements.length >= 2) {
                    states.push({
                        name: elements[0].getText(),
                        setter: elements[1].getText(),
                        initialValue: node.getArguments()[0]?.getText() ?? "undefined",
                    });
                }
            }
        }
    });

    return { states, props };
}

// ========== WriteState 检测 ==========

/**
 * 扫描 WriteState 类型声明，提取所有 setter → state field 映射
 * 例如 WriteState.setRows → "rows"
 */
export function detectWriteStateFields(sourceFile: ReturnType<typeof project.getSourceFile>): Map<string, string> {
    const map = new Map<string, string>();

    sourceFile.forEachDescendant((node) => {
        // const WriteState: { setRows: ...; setConfigPath: ... } = {} as any;
        if (!Node.isVariableDeclaration(node)) return;
        if (node.getName() !== "WriteState") return;

        const typeNode = node.getTypeNode();
        if (!typeNode || !Node.isTypeLiteral(typeNode)) return;

        for (const member of typeNode.getMembers()) {
            if (Node.isPropertySignature(member)) {
                const name = member.getName();
                if (name.startsWith("set")) {
                    // "setRows" → "rows"
                    const stateField = name[3].toLowerCase() + name.slice(4);
                    map.set(name, stateField);
                }
            }
        }
    });

    return map;
}

// ========== Caller 分析 ==========

function isSetter(name: string, states: StateInfo[]): boolean {
    return states.some(s => s.setter === name);
}

function getPureFuncName(text: string): string {
    const parts = text.split("(")[0].split(".");
    return parts[parts.length - 1];
}

function isIgnoreCall(text: string): boolean {
    const ignores = [
        "log", "stringify", "parse", "entries", "keys", "values", "isArray",
        "String", "Number", "Boolean", "Error", "all", "resolve", "reject",
        "randomUUID", "stopPropagation", "encodeURIComponent", "decodeURIComponent",
        "trim", "filter", "map", "flatMap", "find", "some", "every", "includes",
        "replace", "toLowerCase", "toUpperCase", "startsWith", "endsWith",
        "slice", "splice", "push", "pop", "shift", "unshift", "concat", "join",
        "indexOf", "lastIndexOf", "reduce", "sort", "reverse", "toFixed", "toString",
        "toExponential", "toPrecision", "toLocaleString", "toSource",
    ];
    const pureName = getPureFuncName(text);
    // 同时也忽略链式调用如 "xxx.split", "xxx.map", "xxx.filter" 等 - 分段检查
    const parts = text.split(".");
    // 如果链上最后一个方法名在 ignores 中，跳过
    for (const part of parts) {
        const pn = part.trim();
        if (pn.includes("(") && ignores.includes(pn.split("(")[0].trim())) {
            return true;
        }
    }
    return ignores.includes(pureName);
}

/**
 * 对函数体中的一个 CallExpression 进行分类。
 * 新增支持：WriteState.setXxx(...) 检测
 */
function classifyCall(
    node: Node,
    states: StateInfo[],
    ipcMethods: string[],
    writeStateMap: Map<string, string>,
): ClassifiedCall | null {
    const callText = node.getExpression().getText();

    if (isIgnoreCall(node.getText())) return null;
    if (callText === "useState" || callText === "useEffect" || callText === "import" ||
        callText === "render" || callText.endsWith(".render") ||
        callText === "useMemo" || callText === "useCallback") return null;

    // IPC 调用
    if (callText === "invoke" || callText === "remoteJson" || ipcMethods.includes(callText)) {
        return { type: "ipc", text: callText };
    }

    // WriteState.setXxx(...)
    if (callText.startsWith("WriteState.")) {
        const methodName = callText.slice("WriteState.".length);
        if (writeStateMap.has(methodName)) {
            const stateField = writeStateMap.get(methodName)!;
            return { type: "write", text: methodName, target: stateField };
        }
    }

    // 普通 useState setter: setXxx(...)
    if (isSetter(callText, states)) {
        const stateName = states.find(s => s.setter === callText)?.name ?? callText;
        return { type: "write", text: stateName, target: stateName };
    }

    return { type: "call", text: callText };
}

export function getBodyNode(node: ArrowFunction | FunctionExpression): Node | undefined {
    return node.getBody() ?? undefined;
}

/**
 * 从函数体中提取所有的分类调用。只分析顶层 CallExpression（不递归进嵌套函数/方法）
 */
export function extractCallsFromNode(
    node: Node,
    states: StateInfo[],
    ipcMethods: string[],
    writeStateMap: Map<string, string>,
): ClassifiedCall[] {
    const results: ClassifiedCall[] = [];

    if (Node.isCallExpression(node)) {
        const classified = classifyCall(node, states, ipcMethods, writeStateMap);
        if (classified) results.push(classified);

        // 递归分析回调参数（箭头函数 / 函数表达式 / 直接调用中的回调）
        node.getArguments().forEach(arg => {
            if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
                const body = getBodyNode(arg);
                if (body) results.push(...extractCallsFromNode(body, states, ipcMethods, writeStateMap));
            }
        });
        return results;
    }

    node.forEachDescendant((descendant, traversal) => {
        // 跳过嵌套的函数声明（避免分析到不相关的内部函数）
        if (Node.isFunctionDeclaration(descendant) || Node.isMethodDeclaration(descendant)) { traversal.skip(); return; }
        if (Node.isVariableDeclaration(descendant)) {
            const init = descendant.getInitializer();
            if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) { traversal.skip(); return; }
        }

        if (Node.isCallExpression(descendant)) {
            const classified = classifyCall(descendant, states, ipcMethods, writeStateMap);
            if (classified) results.push(classified);
        }
    });

    return results;
}

// ========== renderFn 识别与解析 ==========

/**
 * 判断一个节点是否为 renderFn：
 * - 名字以 "render" 开头
 * - 有 3-5 个参数
 * - param[0] (state): ObjectBindingPattern
 * - param[1] (props): ObjectBindingPattern
 * - param[2] (events): ObjectBindingPattern
 * - param[3] (exts): Identifier (可有可无)
 * - param[4] (memo): ObjectBindingPattern (可有可无)
 */
function isRenderFn(node: Node): boolean {
    let fnNode: Node | undefined;
    let name: string | undefined;

    if (Node.isFunctionDeclaration(node)) {
        fnNode = node;
        name = node.getName();
    } else if (Node.isVariableDeclaration(node)) {
        name = node.getName();
        const init = node.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
            fnNode = init;
        }
    }

    if (!fnNode || !name) return false;
    if (!name.startsWith("render")) return false;

    const params = (fnNode as any).getParameters?.() ?? [];
    if (params.length < 3 || params.length > 5) return false;

    // state param = ObjectBindingPattern
    if (!Node.isObjectBindingPattern(params[0].getNameNode())) return false;
    // props param = ObjectBindingPattern
    if (!Node.isObjectBindingPattern(params[1].getNameNode())) return false;
    // events param = ObjectBindingPattern
    if (!Node.isObjectBindingPattern(params[2].getNameNode())) return false;
    // ext param = Identifier (e.g. "ext" or "_ext")
    if (params.length >= 4 && !Node.isIdentifier(params[3].getNameNode())) return false;
    // memo param = ObjectBindingPattern
    if (params.length === 5 && !Node.isObjectBindingPattern(params[4].getNameNode())) return false;

    return true;
}

function getRenderFnName(node: Node): string {
    if (Node.isFunctionDeclaration(node)) return node.getName() ?? "anonymous";
    if (Node.isVariableDeclaration(node)) return node.getName();
    return "anonymous";
}

/**
 * 从 ext 参数的 type annotation 中提取字段名
 * 例如: ext: { envRows: McpEnvDraftRow[]; rowId: string } → ["envRows", "rowId"]
 * 或者从函数体内的解构中提取: const { envRows, rowId } = ext;
 */
function extractExtFields(fnNode: Node, extParamName: string): string[] {
    const extFields: string[] = [];

    // 方法1：type annotation 中提取
    const params = (fnNode as any).getParameters();
    if (params.length >= 4) {
        const typeNode = params[3].getTypeNode();
        if (typeNode && Node.isTypeLiteral(typeNode)) {
            for (const member of typeNode.getMembers()) {
                if (Node.isPropertySignature(member)) {
                    extFields.push(member.getName());
                }
            }
        }
    }

    // 方法2：如果 type annotation 没有（或没有字段），从函数体解构中提取
    if (extFields.length === 0) {
        const body = fnNode.getKind() === SyntaxKind.ArrowFunction
            ? (fnNode as ArrowFunction).getBody()
            : (fnNode as FunctionDeclaration).getBody() ?? (fnNode as FunctionExpression).getBody();

        if (body) {
            body.forEachDescendant((descendant) => {
                if (!Node.isVariableDeclaration(descendant)) return;
                const nameNode = descendant.getNameNode();
                if (!Node.isObjectBindingPattern(nameNode)) return;
                const init = descendant.getInitializer();
                if (init && init.getText() === extParamName) {
                    for (const el of nameNode.getElements()) {
                        extFields.push(el.getName());
                    }
                }
            });
        }
    }

    return extFields;
}

// ========== 为 renderFn 构建 EventBinding ==========

/**
 * 从一个 renderFn 节点的 JSX 中提取 EventBinding。
 * 在 mcp-test.tsx 模式中, events 参数名与文件级函数名一致。
 * 例如 events: { reloadMcpSettings } → JSX 中 onClick={reloadMcpSettings}
 * 这意味着 reloadMcpSettings 就是一个文件级函数。
 */
function extractEventBindings(
    fnNode: Node,
    param2EventNames: Set<string>,
    filePath: string,
    fnName: string,
): EventBinding[] {
    const bindings: EventBinding[] = [];

    fnNode.forEachDescendant((descendant) => {
        if (!Node.isJsxAttribute(descendant)) return;
        const attrName = descendant.getNameNode().getText();
        if (!/^on[A-Z]/.test(attrName)) return;

        const init = descendant.getInitializer();
        if (!init) return;

        let expr = init;
        if (Node.isJsxExpression(init)) expr = init.getExpression() ?? init;

        // 情况1: 直接引用 onClick={handlerName}
        if (Node.isIdentifier(expr) && param2EventNames.has(expr.getText())) {
            bindings.push({
                id: `${filePath}:${fnName}#${expr.getText()}`,
                bindTo: attrName,
                handleFnId: `${filePath}:${expr.getText()}`,
            });
        }
        // 情况2: 箭头适配 onClick={(e) => handlerName(...)}
        else if (Node.isArrowFunction(expr)) {
            const arrowBody = expr.getBody();
            const callExpr = Node.isBlock(arrowBody)
                ? arrowBody.getStatements().find(s =>
                    Node.isReturnStatement(s)
                        ? (s as any).getExpression()?.getKind() === SyntaxKind.CallExpression
                        : Node.isExpressionStatement(s) && Node.isCallExpression((s as any).getExpression())
                            ? (s as any).getExpression()
                            : false
                )
                : Node.isCallExpression(arrowBody) ? arrowBody : null;

            if (callExpr) {
                const actualExpr = Node.isReturnStatement(callExpr)
                    ? (callExpr as any).getExpression()
                    : callExpr;
                if (actualExpr && Node.isCallExpression(actualExpr)) {
                    const callee = actualExpr.getExpression();
                    if (Node.isIdentifier(callee) && param2EventNames.has(callee.getText())) {
                        bindings.push({
                            id: `${filePath}:${fnName}#${callee.getText()}`,
                            bindTo: attrName,
                            handleFnId: `${filePath}:${callee.getText()}`,
                        });
                    }
                }
            }
        }
        // 情况3: 直接调用 onClick={handlerName()}
        else if (Node.isCallExpression(expr)) {
            const callee = expr.getExpression();
            if (Node.isIdentifier(callee) && param2EventNames.has(callee.getText())) {
                bindings.push({
                    id: `${filePath}:${fnName}#${callee.getText()}`,
                    bindTo: attrName,
                    handleFnId: `${filePath}:${callee.getText()}`,
                });
            }
        }
        // 情况4: 其他非匿名函数引用
        else if (!Node.isArrowFunction(expr) && !Node.isFunctionExpression(expr)) {
            const handlerText = expr.getText();
            const matchesFnName = param2EventNames.has(handlerText);
            bindings.push({
                id: `${filePath}:${fnName}#${attrName}`,
                bindTo: attrName,
                handleFnId: matchesFnName ? `${filePath}:${handlerText}` : "",
            });
        }
    });

    return bindings;
}

// ========== render() 调用分析 ==========

interface RenderCallSite {
    fnName: string;           // 被调用的 renderFn 名字
    stateFields: string[];    // state: { xxx, yyy } 中传递的字段
    memoFields: string[];     // memo: { ... } 中传递的字段
    extFields: string[];      // exts: { ... } 中传递的字段
    eventNames: string[];     // events: { ... } 中传递的函数名
}

/**
 * 从 renderFn 函数体中解析所有 render({...}) 调用点
 * 例如:
 *   render({state: { configPath }, props: {}, fn: renderMcpServersViewHero, events: {}})
 *   → RenderCallSite { fnName: "renderMcpServersViewHero", stateFields: ["configPath"], ... }
 */
function extractRenderCalls(fnNode: Node): RenderCallSite[] {
    const sites: RenderCallSite[] = [];

    fnNode.forEachDescendant((descendant) => {
        if (!Node.isCallExpression(descendant)) return;
        const callee = descendant.getExpression();
        const calleeText = callee.getText();

        // 匹配 render({...}) 或 xxx.render({...})
        const isRenderCall = (Node.isIdentifier(callee) && calleeText === "render")
            || (Node.isPropertyAccessExpression(callee) && callee.getName() === "render");

        if (!isRenderCall) return;

        const firstArg = descendant.getArguments()[0];
        if (!firstArg || !Node.isObjectLiteralExpression(firstArg)) return;

        let fnName = "";
        const stateFields: string[] = [];
        const memoFields: string[] = [];
        const extFields: string[] = [];
        const eventNames: string[] = [];

        for (const prop of firstArg.getProperties()) {
            if (!Node.isPropertyAssignment(prop)) continue;
            const propName = prop.getName();
            const init = prop.getInitializer();

            if (propName === "fn" && init && Node.isIdentifier(init)) {
                fnName = init.getText();
            }

            if (propName === "state" && init && Node.isObjectLiteralExpression(init)) {
                for (const sp of init.getProperties()) {
                    if (Node.isShorthandPropertyAssignment(sp) || Node.isPropertyAssignment(sp)) {
                        stateFields.push(sp.getName());
                    }
                }
            }

            if (propName === "memo" && init && Node.isObjectLiteralExpression(init)) {
                for (const sp of init.getProperties()) {
                    if (Node.isShorthandPropertyAssignment(sp) || Node.isPropertyAssignment(sp)) {
                        memoFields.push(sp.getName());
                    }
                }
            }

            if (propName === "exts" && init && Node.isObjectLiteralExpression(init)) {
                for (const sp of init.getProperties()) {
                    if (Node.isShorthandPropertyAssignment(sp) || Node.isPropertyAssignment(sp)) {
                        extFields.push(sp.getName());
                    }
                }
            }

            if (propName === "events" && init && Node.isObjectLiteralExpression(init)) {
                for (const ep of init.getProperties()) {
                    if (Node.isShorthandPropertyAssignment(ep)) {
                        eventNames.push(ep.getName());
                    } else if (Node.isPropertyAssignment(ep)) {
                        eventNames.push(ep.getName());
                    }
                }
            }
        }

        if (fnName) {
            sites.push({ fnName, stateFields, memoFields, extFields, eventNames });
        }
    });

    return sites;
}

// ========== 查找 View 组件名 ==========

function findViewName(sourceFile: ReturnType<typeof project.getSourceFile>): string {
    // 尝试找 export function XxxView()
    const viewFn = sourceFile?.getFunctions().find(f =>
        f.isExported() && (f.getName()?.endsWith("View"))
    );
    if (viewFn?.getName()) return viewFn.getName();

    // 尝试找 export const XxxView
    const viewVar = sourceFile?.getVariableDeclarations().find(v =>
        v.isExported() && v.getName().endsWith("View")
    );
    if (viewVar?.getName()) return viewVar.getName();

    return "default";
}

// ========== 构建函数详情 ==========

/**
 * 收集文件中的所有非 renderFn（EventHandler 和工具函数）
 */
function buildFnDetails(
    sourceFile: ReturnType<typeof project.getSourceFile>,
    states: StateInfo[],
    ipcMethods: string[],
    writeStateMap: Map<string, string>,
    viewName: string,
    renderFnSet: Set<string>,
    filePath: string,
): FnDetail[] {
    const fns: FnDetail[] = [];

    sourceFile?.forEachDescendant((node) => {
        let name: string | undefined;
        let body: Node | undefined;

        if (Node.isFunctionDeclaration(node)) {
            name = node.getName();
            body = node.getBody();
        } else if (Node.isVariableDeclaration(node)) {
            name = node.getName();
            const init = node.getInitializer();
            if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
                body = getBodyNode(init);
            }
        }

        if (!name || !body) return;
        if (name.startsWith("render") && renderFnSet.has(name)) return; // 跳过 renderFn
        if (name === viewName) return;  // 跳过 View 组件
        if (name === "WriteState" || name === "render" || name.startsWith("_latest")) return;

        const calls = extractCallsFromNode(body, states, ipcMethods, writeStateMap);
        // 去重 + 排序
        const writes = [...new Set(calls.filter(c => c.type === "write").map(c => c.target!))].sort();
        const ipcs = [...new Set(calls.filter(c => c.type === "ipc").map(c => `ipc:${c.text}`))].sort();
        const funcCalls = [...new Set(calls.filter(c => c.type === "call").map(c => c.text))].sort();

        fns.push({
            id: `${filePath}:${name}`,
            writes,
            ipcs,
            fns: funcCalls,
        });
    });

    return fns;
}

// ========== Memo → State 依赖解析 ==========

/**
 * 从 View 函数体中提取所有 memo/派生值 → 原始 state 的依赖映射。
 *
 * 处理两类模式：
 * 1. useMemo 调用: const X = useMemo(() => ..., [stateA, stateB])
 * 2. 非 memo 派生值: const X = stateA !== stateB 或 const X = fn(stateA)
 *
 * 结果递归解析到原始 state，例如:
 *   draftSettings = useMemo(..., [rows])         → "draftSettings" → ["rows"]
 *   draftText = useMemo(..., [draftSettings])     → "draftText" → ["rows"]
 *   hasUnsavedChanges = draftText !== savedText   → "hasUnsavedChanges" → ["rows", "savedText"]
 */
function buildMemoDepMap(
    sourceFile: ReturnType<typeof project.getSourceFile>,
    stateNameSet: Set<string>,
): Map<string, string[]> {
    const rawMap = new Map<string, string[]>();     // memoName → immediate deps (可能含其他 memo)
    const viewFn = sourceFile?.getFunctions().find(f =>
        f.isExported() && (f.getName()?.endsWith("View"))
    );
    if (!viewFn) return rawMap;

    const viewBody = viewFn.getBody();
    if (!viewBody) return rawMap;

    // 1. 找出 useMemo 调用
    viewBody.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        if (node.getExpression().getText() !== "useMemo") return;

        const parent = node.getParent();
        if (!Node.isVariableDeclaration(parent)) return;
        const memoName = parent.getName();

        // 第二个参数是依赖数组
        const args = node.getArguments();
        if (args.length < 2) return;
        const depArray = args[1];
        if (!Node.isArrayLiteralExpression(depArray)) return;

        const deps: string[] = [];
        for (const el of depArray.getElements()) {
            if (Node.isIdentifier(el)) {
                deps.push(el.getText());
            }
        }
        rawMap.set(memoName, deps);
    });

    // 2. 找出非 useMemo 的派生值 (const X = expr，其中 expr 引用了 state/memo)
    viewBody.forEachDescendant((node) => {
        if (!Node.isVariableDeclaration(node)) return;
        const name = node.getName();
        if (rawMap.has(name)) return; // 已经是 useMemo

        const init = node.getInitializer();
        if (!init) return;

        // 跳过函数/箭头/hook 调用
        if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) return;
        if (Node.isCallExpression(init)) {
            const callee = init.getExpression().getText();
            if (callee.startsWith("use") || callee === "render") return;
        }

        // 从 init 表达式中提取所有 Identifier 引用
        const depSet = new Set<string>();
        init.forEachDescendant((sub) => {
            if (Node.isIdentifier(sub)) {
                const text = sub.getText();
                if (stateNameSet.has(text) || rawMap.has(text)) {
                    depSet.add(text);
                }
            }
        });

        if (depSet.size > 0) {
            rawMap.set(name, [...depSet]);
        }
    });

    // 3. 递归解析：直到所有 deps 都解析为原始 state
    function resolve(name: string, visited: Set<string>): string[] {
        if (stateNameSet.has(name)) return [name];
        const deps = rawMap.get(name);
        if (!deps || deps.length === 0) return [];

        const result = new Set<string>();
        for (const dep of deps) {
            if (visited.has(dep)) continue;
            visited.add(dep);
            const resolved = resolve(dep, visited);
            for (const r of resolved) result.add(r);
        }
        return [...result];
    }

    const resolvedMap = new Map<string, string[]>();
    for (const [name] of rawMap) {
        resolvedMap.set(name, resolve(name, new Set()));
    }

    return resolvedMap;
}

// ========== useEffect 提取 ==========

/**
 * 从 View 函数体的 useEffect 回调中，提取调用的 handler 函数名列表。
 *
 * 例如 useEffect(() => { void reloadMcpSettings(); }, [])
 * → 提取 "reloadMcpSettings" → 返回 ["reloadMcpSettings"]
 */
function extractUseEffectHandlers(viewBody: Node): string[] {
    const handlers: string[] = [];

    viewBody.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        if (node.getExpression().getText() !== "useEffect") return;

        const args = node.getArguments();
        if (args.length < 1) return;

        const callback = args[0];
        if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) return;

        const body = getBodyNode(callback);
        if (!body) return;

        // 遍历回调体，找函数调用（如 reloadMcpSettings()）
        body.forEachDescendant((sub) => {
            if (!Node.isCallExpression(sub)) return;
            const callee = sub.getExpression();
            if (Node.isIdentifier(callee)) {
                handlers.push(callee.getText());
            }
        });
    });

    return [...new Set(handlers)];
}

// ========== 主函数：buildCodeGraph ==========

export function buildCodeGraph(filePath: string): { view: ViewNode; fns: FnDetail[] } {
    const sourceFile = project.getSourceFile(filePath);
    if (!sourceFile) throw new Error(`File not found: ${filePath}`);

    const { states, props: propInfos } = collectStateAndProps(sourceFile);
    const ipcMethods = extractIPCMethods(sourceFile);
    const writeStateMap = detectWriteStateFields(sourceFile);

    const viewName = findViewName(sourceFile);
    const fileSource = filePath.replace(/^.*\/src\//, "src/");
    const stateNameSet = new Set(states.map(s => s.name));
    const memoDepMap = buildMemoDepMap(sourceFile, stateNameSet);

    // 1. 收集所有 renderFn
    const renderFnMap = new Map<string, {
        node: Node;
        fnNode: Node;
        stateNames: string[];
        propNames: string[];
        eventsNames: string[];
        memoNames: string[];
        extFields: string[];
        bindings: EventBinding[];
        renderCalls: RenderCallSite[];
    }>();

    sourceFile.forEachDescendant((node) => {
        if (!isRenderFn(node)) return;
        const name = getRenderFnName(node);

        let fnNode: Node;
        if (Node.isVariableDeclaration(node)) {
            fnNode = node.getInitializer()!;
        } else {
            fnNode = node;
        }

        const params = (fnNode as any).getParameters();

        // param[0] = state 解构
        const stateNames = Node.isObjectBindingPattern(params[0].getNameNode())
            ? params[0].getNameNode().getElements().map((e: any) => e.getName())
            : [];

        // param[1] = props 解构
        const propNames = Node.isObjectBindingPattern(params[1].getNameNode())
            ? params[1].getNameNode().getElements().map((e: any) => e.getName())
            : [];

        // param[2] = events 解构
        const eventsNames = Node.isObjectBindingPattern(params[2].getNameNode())
            ? params[2].getNameNode().getElements().map((e: any) => e.getName())
            : [];
        const eventNameSet = new Set(eventsNames);

        // param[3] = ext (Identifier, 函数体内解构提取字段)
        const extParamName = params.length >= 3 && Node.isIdentifier(params[3]?.getNameNode())
            ? params[3].getNameNode().getText()
            : "";
        const extFields = extParamName ? extractExtFields(fnNode, extParamName) : [];

        // param[4] = memo 解构
        const memoNames = params.length >= 5 && Node.isObjectBindingPattern(params[4].getNameNode())
            ? params[4].getNameNode().getElements().map((e: any) => e.getName())
            : [];

        // Event bindings
        const bindings = extractEventBindings(fnNode, eventNameSet, fileSource, name);

        // render() 调用分析
        const renderCalls = extractRenderCalls(fnNode);

        renderFnMap.set(name, {
            node,
            fnNode,
            stateNames,
            propNames,
            eventsNames,
            memoNames,
            extFields,
            bindings,
            renderCalls,
        });
    });

    // 2. 构建 renderFn 树
    // 收集所有被其他 renderFn 引用的名字
    const allChildNames = new Set<string>();
    for (const [, info] of renderFnMap) {
        for (const rc of info.renderCalls) {
            if (renderFnMap.has(rc.fnName)) {
                allChildNames.add(rc.fnName);
            }
        }
    }

    /**
     * 递归构建 RenderFnNode 树。
     * 每个节点记录：
     * - 自身依赖的状态/props/memos/exts
     * - 事件绑定（含处理函数 ID）
     * - 子节点
     */
    function buildRenderFnNode(name: string): RenderFnNode {
        const info = renderFnMap.get(name)!;

        // 将 memo 名字解析为原始 state 名字，合并到 states
        const resolvedStates = new Set(info.stateNames);
        for (const memoName of info.memoNames) {
            const stateDeps = memoDepMap.get(memoName);
            if (stateDeps) {
                for (const s of stateDeps) resolvedStates.add(s);
            }
        }

        const children: RenderFnNode[] = [];
        for (const rc of info.renderCalls) {
            if (renderFnMap.has(rc.fnName)) {
                children.push(buildRenderFnNode(rc.fnName));
            }
        }

        return {
            id: `${fileSource}:${name}`,
            states: [...resolvedStates].sort(),
            props: [...info.propNames],
            exts: [...info.extFields],
            events: info.bindings,
            children,
        };
    }

    // 根节点 = 没被任何人作为子 renderFn 引用的 renderFn
    const roots: RenderFnNode[] = [];
    for (const [name] of renderFnMap) {
        if (!allChildNames.has(name)) {
            roots.push(buildRenderFnNode(name));
        }
    }

    // 3. 提取 useEffect 中调用的 handler 名
    const viewFnNode = sourceFile.getFunctions().find(f => f.getName() === viewName);
    const useEffectHandlerNames = viewFnNode?.getBody()
        ? extractUseEffectHandlers(viewFnNode.getBody())
        : [];

    // 4. 收集函数详情
    const renderFnSet = new Set(renderFnMap.keys());
    const fns = buildFnDetails(sourceFile, states, ipcMethods, writeStateMap, viewName, renderFnSet, fileSource);

    // 5. 构建 useEffect 的 FnDetail（描述 effect 回调自身做了什么）
    let useEffect: FnDetail | null = null;
    if (useEffectHandlerNames.length > 0) {
        useEffect = {
            id: `${fileSource}:${viewName}#useEffect`,
            writes: [],
            ipcs: [],
            fns: useEffectHandlerNames,
        };
    }

    // 6. 构建 ViewNode
    const view: ViewNode = {
        id: `${fileSource}:${viewName}`,
        states: states.map(s => s.name),
        props: Object.fromEntries(
            propInfos.map(p => [p.name, { type: "state" as const, viewId: view.id, sourceName: p.name }])
        ),
        useEffect,
        children: roots,
    };

    return { view, fns };
}

// ========== CLI Entry ==========

const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const fIndex = args.indexOf("-f");
const cliFilePath = fileIndex !== -1 && args.length > fileIndex + 1
    ? args[fileIndex + 1]
    : fIndex !== -1 && args.length > fIndex + 1
        ? args[fIndex + 1]
        : null;

if (!cliFilePath) {
    console.error("Usage: npx tsx parser/parser.ts --file <path>");
    process.exit(1);
}

const allViews: ViewNode[] = [];
const allFns: FnDetail[] = [];

for (const filePath of [cliFilePath]) {
    const { view, fns } = buildCodeGraph(filePath);
    allViews.push(view);
    allFns.push(...fns);
}

const graph: CodeGraph = {
    version: new Date().toISOString(),
    views: allViews,
    fns: allFns,
};

console.log(JSON.stringify(graph, null, 2));
