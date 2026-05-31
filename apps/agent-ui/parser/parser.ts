// parser/index.ts
// parser/parser.ts
import { Project, Node, SyntaxKind, type ArrowFunction, type FunctionExpression, type FunctionDeclaration } from "ts-morph";
import type { EventBinding, FnDetail, RenderFnNode, ViewNode, PropSource } from "./types";

// 所有解析逻辑：collectStateAndProps、extractIPCMethods、isRenderFn、buildCodeGraph 等
// ========== 复用你的原有逻辑，几乎不改 ==========

const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
});

interface StateInfo {
    name: string;
    setter: string;
    initialValue: string;
}

interface PropInfo {
    name: string;
    type: string;
}

function extractIPCMethods(sourceFile: ReturnType<typeof project.getSourceFile>): string[] {
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

function collectStateAndProps(sourceFile: ReturnType<typeof project.getSourceFile>) {
    const states: StateInfo[] = [];
    const props: PropInfo[] = [];
    if (!sourceFile) return { states, props };

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

    if (props.length === 0) {
        sourceFile.forEachDescendant((node) => {
            if (Node.isFunctionDeclaration(node)) {
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
        "indexOf", "lastIndexOf", "reduce", "sort", "reverse",
    ];
    return ignores.includes(getPureFuncName(text));
}

interface ClassifiedCall {
    type: "write" | "ipc" | "call";
    text: string;
    target?: string;
}

function classifyCall(node: Node, states: StateInfo[], ipcMethods: string[]): ClassifiedCall | null {
    const callText = node.getExpression().getText();
    if (isIgnoreCall(node.getText())) return null;
    if (callText === "useState" || callText === "useEffect" || callText === "import") return null;

    if (callText === "invoke" || callText === "remoteJson" || ipcMethods.includes(callText)) {
        return { type: "ipc", text: callText };
    }

    if (isSetter(callText, states)) {
        const stateName = states.find(s => s.setter === callText)?.name ?? callText;
        return { type: "write", text: stateName, target: stateName };
    }

    return { type: "call", text: callText };
}

function getBodyNode(node: ArrowFunction | FunctionExpression): Node | undefined {
    return node.getBody() ?? undefined;
}

function extractCallsFromNode(node: Node, states: StateInfo[], ipcMethods: string[]): ClassifiedCall[] {
    const results: ClassifiedCall[] = [];
    if (Node.isCallExpression(node)) {
        const classified = classifyCall(node, states, ipcMethods);
        if (classified) results.push(classified);
        node.getArguments().forEach(arg => {
            if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
                const body = getBodyNode(arg);
                if (body) results.push(...extractCallsFromNode(body, states, ipcMethods));
            }
        });
        return results;
    }
    node.forEachDescendant((descendant, traversal) => {
        if (Node.isFunctionDeclaration(descendant) || Node.isMethodDeclaration(descendant)) { traversal.skip(); return; }
        if (Node.isVariableDeclaration(descendant)) {
            const init = descendant.getInitializer();
            if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) { traversal.skip(); return; }
        }
        if (Node.isCallExpression(descendant)) {
            const classified = classifyCall(descendant, states, ipcMethods);
            if (classified) results.push(classified);
        }
    });
    return results;
}

// ========== 新增：renderFn 识别 ==========

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
    if (params.length < 3 || params.length > 4) return false;

    if (!Node.isObjectBindingPattern(params[0].getNameNode())) return false;
    if (!Node.isObjectBindingPattern(params[1].getNameNode())) return false;
    if (!Node.isIdentifier(params[2].getNameNode())) return false;
    if (params.length === 4 && !Node.isIdentifier(params[3].getNameNode())) return false;

    return true;
}

function getRenderFnName(node: Node): string {
    if (Node.isFunctionDeclaration(node)) return node.getName() ?? "anonymous";
    if (Node.isVariableDeclaration(node)) return node.getName();
    return "anonymous";
}

// ========== 新增：构建 Code Graph ==========

interface EventBinding {
    id: string;
    bindTo: string;
    handleFnId: string;
}

interface FnDetail {
    id: string;
    writes: string[];
    ipcs: string[];
    fns: string[];
}

interface RenderFnNode {
    id: string;
    states: string[];
    props: string[];
    events: EventBinding[];
    children: RenderFnNode[];
}

interface PropSource {
    type: "state" | "fn";
    viewId: string;
    sourceName: string;
}

interface ViewNode {
    id: string;
    states: string[];
    props: Record<string, PropSource>;
    children: RenderFnNode[];
}

interface CodeGraph {
    version: string;
    views: ViewNode[];
    fns: FnDetail[];
}

function buildCodeGraph(filePath: string): { view: ViewNode; fns: FnDetail[] } {
    const sourceFile = project.getSourceFile(filePath);
    if (!sourceFile) throw new Error(`File not found: ${filePath}`);

    const { states, props: propInfos } = collectStateAndProps(sourceFile);
    const ipcMethods = extractIPCMethods(sourceFile);

    // 找 View 组件名
    const viewName = sourceFile.getClasses().map(c => c.getName()).find(n => n && n.endsWith("View"))
        ?? sourceFile.getFunctions().find(f => f.isExported() && !f.getName()?.startsWith("render"))?.getName()
        ?? "default";

    // 收集所有 renderFn
    const renderFnMap = new Map<string, { node: Node; states: string[]; props: string[]; events: EventBinding[]; children: string[] }>();

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
        const stateNames = Node.isObjectBindingPattern(params[0].getNameNode())
            ? params[0].getNameNode().getElements().map((e: any) => e.getName())
            : [];
        const propNames = Node.isObjectBindingPattern(params[1].getNameNode())
            ? params[1].getNameNode().getElements().map((e: any) => e.getName())
            : [];
        const eventsParamName = params[2].getNameNode().getText();

        // 收集 events 绑定
        const bindings: EventBinding[] = [];
        fnNode.forEachDescendant((descendant) => {
            if (!Node.isJsxAttribute(descendant)) return;
            const attrName = descendant.getNameNode().getText();
            if (!/^on[A-Z]/.test(attrName)) return;
            const init = descendant.getInitializer();
            if (!init) return;

            let expr = init;
            if (Node.isJsxExpression(init)) expr = init.getExpression() ?? init;

            if (Node.isPropertyAccessExpression(expr)) {
                const obj = expr.getExpression();
                if (Node.isIdentifier(obj) && obj.getText() === eventsParamName) {
                    const handlerText = expr.getName();
                    bindings.push({
                        id: `${filePath}:${name}#${handlerText}`,
                        bindTo: attrName,
                        handleFnId: "",  // 暂时留空，后面补充
                    });
                }
            } else if (!Node.isArrowFunction(expr) && !Node.isFunctionExpression(expr)) {
                // 直接引用外部函数：onClick={handleEdit}
                const handlerText = expr.getText();
                bindings.push({
                    id: `${filePath}:${name}#on${attrName.slice(2)}`,
                    bindTo: attrName,
                    handleFnId: handlerText.includes(".") ? handlerText : `${filePath}:${handlerText}`,
                });
            }
        });

        // 收集子 renderFn 调用
        const childNames: string[] = [];
        fnNode.forEachDescendant((descendant) => {
            if (Node.isCallExpression(descendant)) {
                const callee = descendant.getExpression();
                if (Node.isIdentifier(callee) && callee.getText().startsWith("render")) {
                    childNames.push(callee.getText());
                }
            }
        });

        renderFnMap.set(name, {
            node,
            states: stateNames,
            props: propNames,
            events: bindings,
            children: childNames,
        });
    });

    // 建立嵌套树：被引用的是子节点
    const childNames = new Set<string>();
    for (const [, info] of renderFnMap) {
        for (const c of info.children) {
            childNames.add(c);
        }
    }

    function buildNode(name: string): RenderFnNode {
        const info = renderFnMap.get(name)!;
        return {
            id: `${filePath}:${name}`,
            states: info.states,
            props: info.props,
            events: info.events,
            children: info.children.filter(c => renderFnMap.has(c)).map(buildNode),
        };
    }

    // 根节点 = 没被任何人作为子节点的 renderFn
    const roots: RenderFnNode[] = [];
    for (const [name] of renderFnMap) {
        if (!childNames.has(name)) {
            roots.push(buildNode(name));
        }
    }

    // 收集普通函数（非 renderFn、非 View 组件）
    const fns: FnDetail[] = [];
    sourceFile.forEachDescendant((node) => {
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
        if (name.startsWith("render") && renderFnMap.has(name)) return;  // 跳过 renderFn
        if (name === viewName) return;  // 跳过 View 组件

        const calls = extractCallsFromNode(body, states, ipcMethods);
        fns.push({
            id: `${filePath}:${name}`,
            writes: calls.filter(c => c.type === "write").map(c => c.target!),
            ipcs: calls.filter(c => c.type === "ipc").map(c => `ipc:${c.text}`),
            fns: calls.filter(c => c.type === "call").map(c => c.text),
        });
    });

    // 补充 eventBinding 的 handleFnId
    for (const [, info] of renderFnMap) {
        for (const binding of info.events) {
            if (!binding.handleFnId) {
                // events.xxx 形式，尝试匹配同名 handle 函数
                const eventName = binding.id.split("#")[1];
                const expectedHandler = `handle${eventName[0].toUpperCase()}${eventName.slice(1)}`;
                const matchedFn = fns.find(f => f.id === `${filePath}:${expectedHandler}`);
                if (matchedFn) {
                    binding.handleFnId = matchedFn.id;
                }
            }
        }
    }

    return {
        view: {
            id: `${filePath}:${viewName}`,
            states: states.map(s => s.name),
            props: {},
            children: roots,
        },
        fns,
    };
}

// ========== Main ==========

const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const fIndex = args.indexOf("-f");
const cliFilePath = fileIndex !== -1 && args.length > fileIndex + 1
    ? args[fileIndex + 1]
    : fIndex !== -1 && args.length > fIndex + 1
        ? args[fIndex + 1]
        : null;

const TARGET_FILES = ["src/app/WorktreePanel.tsx"];
const filesToAnalyze = cliFilePath ? [cliFilePath] : TARGET_FILES;

const allViews: ViewNode[] = [];
const allFns: FnDetail[] = [];

for (const filePath of filesToAnalyze) {
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