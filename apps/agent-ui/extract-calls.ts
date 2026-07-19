import { Project, Node, SyntaxKind, type CallExpression, type ArrowFunction, type FunctionExpression } from "ts-morph";

const project = new Project({
  tsConfigFilePath: "./tsconfig.json",
});

const TARGET_FILES = [
  "src/app/WorktreePanel.tsx",
];

interface StateInfo {
  name: string;
  setter: string;
  initialValue: string;
}

interface PropInfo {
  name: string;
  type: string;
}

// ========== New: IPC method extraction ==========
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
            const name = member.getName();
            const typeNode = member.getTypeNode();
            props.push({ name, type: typeNode?.getText() ?? "unknown" });
          }
        });
      }
    }
  });

  if (props.length === 0) {
    sourceFile.forEachDescendant((node) => {
      if (Node.isFunctionDeclaration(node)) {
        const params = node.getParameters();
        for (const param of params) {
          if (Node.isObjectBindingPattern(param.getNameNode())) {
            const elements = param.getNameNode().getElements();
            for (const el of elements) {
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
          const stateName = elements[0].getText();
          const setterName = elements[1].getText();
          const args = node.getArguments();
          const initialValue = args.length > 0 ? args[0].getText() : "undefined";
          states.push({ name: stateName, setter: setterName, initialValue });
        }
      }
    }
  });

  return { states, props };
}

interface ClassifiedCall {
  type: "write" | "ipc" | "call" | "event" | "effect_register";
  text: string;
  target?: string;
}

interface RenderBinding {
  type: string;
  state: string;
  element: string;
}

interface JSXEventBinding {
  element: string;
  event: string;
  handler: string;
  isAnonymous: boolean;
  bodyCalls: ClassifiedCall[];
}

interface FunctionDef {
  name: string;
  calls: ClassifiedCall[];
}

interface UseEffectDef {
  deps: string;
  calls: ClassifiedCall[];
}

function findComponentFunctions(sourceFile: ReturnType<typeof project.getSourceFile>): string[] {
  const names: string[] = [];
  if (!sourceFile) return names;
  sourceFile.forEachDescendant((node) => {
    if (Node.isFunctionDeclaration(node) && node.getName() && node.isExported()) {
      names.push(node.getName());
    }
  });
  return names;
}

function isStateVar(name: string, states: StateInfo[]): boolean {
  return states.some(s => s.name === name);
}

function isSetter(name: string, states: StateInfo[]): boolean {
  return states.some(s => s.setter === name);
}

function isProp(name: string, props: PropInfo[]): boolean {
  return props.some(p => p.name === name);
}

// ========== Preserve the original IPC detection ==========
function isIPCCall(node: CallExpression): boolean {
  const text = node.getExpression().getText();
  return text === "invoke" || text === "remoteJson";
}

function getPureFuncName(text: string): string {
  const beforeParen = text.split("(")[0];
  const parts = beforeParen.split(".");
  return parts[parts.length - 1];
}

function isIgnoreCall(text: string): boolean {
  const funcName = getPureFuncName(text);
  const ignores = [
    "log", "stringify", "parse",
    "entries", "keys", "values", "isArray",
    "String", "Number", "Boolean", "Error",
    "all", "resolve", "reject",
    "randomUUID", "stopPropagation",
    "encodeURIComponent", "decodeURIComponent", "clientDebugLog",
    "trim", "filter", "map", "flatMap", "find", "some", "every", "includes",
    "replace", "toLowerCase", "toUpperCase", "startsWith", "endsWith",
    "slice", "splice", "push", "pop", "shift", "unshift", "concat", "join",
    "indexOf", "lastIndexOf", "reduce", "sort", "reverse",
  ];
  return ignores.includes(funcName);
}

// ========== classifyCall: add ipcMethods parameter ==========
function classifyCall(node: CallExpression, states: StateInfo[], props: PropInfo[], ipcMethods: string[]): ClassifiedCall | null {
  const expr = node.getExpression();
  const callText = expr.getText();

  if (isIgnoreCall(node.getText())) return null;
  if (callText === "useState") return null;
  if (callText === "useEffect") return { type: "effect_register", text: callText };
  if (callText === "import") return null;

  // existing invoke/remoteJson
  if (isIPCCall(node)) {
    return { type: "ipc", text: callText };
  }

  // new: IPC methods imported from runtime
  if (ipcMethods.includes(callText)) {
    return { type: "ipc", text: callText };
  }

  if (isSetter(callText, states)) {
    const stateName = states.find(s => s.setter === callText)?.name ?? callText;
    return { type: "write", text: stateName, target: stateName };
  }

  if (isProp(callText, props) && callText.startsWith("on")) {
    return { type: "event", text: callText, target: callText };
  }

  return { type: "call", text: callText };
}

// ========== extractCallsFromNode: add ipcMethods parameter ==========
function extractCallsFromNode(node: Node, states: StateInfo[], props: PropInfo[], ipcMethods: string[]): ClassifiedCall[] {
  const results: ClassifiedCall[] = [];

  if (Node.isCallExpression(node)) {
    const classified = classifyCall(node, states, props, ipcMethods);
    if (classified) results.push(classified);
    node.getArguments().forEach(arg => {
      if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
        const body = getBodyNode(arg);
        if (body) results.push(...extractCallsFromNode(body, states, props, ipcMethods));
      }
    });
    return results;
  }

  node.forEachDescendant((descendant, traversal) => {
    if (Node.isFunctionDeclaration(descendant) || Node.isMethodDeclaration(descendant)) {
      traversal.skip();
      return;
    }
    if (Node.isVariableDeclaration(descendant)) {
      const init = descendant.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        traversal.skip();
        return;
      }
    }

    if (Node.isCallExpression(descendant)) {
      const classified = classifyCall(descendant, states, props, ipcMethods);
      if (classified) results.push(classified);
    }
  });

  return results;
}

function getElementTag(node: Node): string {
  if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
    const tag = node.getTagNameNode().getText();
    const className = getClassName(node);
    return className ? `${tag}.${className}` : tag;
  }
  const parent = node.getParent();
  if (parent && (Node.isJsxOpeningElement(parent) || Node.isJsxSelfClosingElement(parent))) {
    const tag = parent.getTagNameNode().getText();
    const className = getClassName(parent);
    return className ? `${tag}.${className}` : tag;
  }
  return "unknown";
}

function getClassName(node: Node): string {
  if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
    const attrs = node.getAttributes();
    for (const attr of attrs) {
      if (Node.isJsxAttribute(attr) && attr.getNameNode().getText() === "className") {
        const val = attr.getInitializer();
        return val ? val.getText().replace(/['"`]/g, "") : "";
      }
    }
  }
  return "";
}

function getJsxExpressionText(initializer: Node): string {
  if (Node.isJsxExpression(initializer)) {
    const inner = initializer.getExpression();
    return inner ? inner.getText() : initializer.getText();
  }
  return initializer.getText();
}

function collectStatesFromCondition(node: Node, states: StateInfo[]): string[] {
  const results: string[] = [];

  function walk(n: Node) {
    if (Node.isBinaryExpression(n) && n.getOperatorToken().getText() === "&&") {
      walk(n.getLeft());
      walk(n.getRight());
    } else if (Node.isParenthesizedExpression(n)) {
      walk(n.getExpression()!);
    } else if (Node.isIdentifier(n)) {
      const name = n.getText();
      if (isStateVar(name, states)) results.push(name);
    } else if (Node.isPrefixUnaryExpression(n) && n.getOperatorToken() === SyntaxKind.ExclamationToken) {
      const op = n.getOperand();
      if (Node.isIdentifier(op)) {
        const name = op.getText();
        if (isStateVar(name, states)) results.push(`!${name}`);
      }
    }
  }

  walk(node);
  return results;
}

function findFirstJsxInParen(node: Node): string {
  const inner = Node.isParenthesizedExpression(node) ? node.getExpression() : node;
  if (!inner) return "unknown";

  if (Node.isJsxElement(inner)) return getElementTag(inner.getOpeningElement());
  if (Node.isJsxSelfClosingElement(inner)) return getElementTag(inner);

  let result = "unknown";
  inner.forEachChild(child => {
    if (result !== "unknown") return;
    if (Node.isJsxElement(child)) result = getElementTag(child.getOpeningElement());
    else if (Node.isJsxSelfClosingElement(child)) result = getElementTag(child);
  });
  return result;
}

function extractRenderBindings(sourceFile: ReturnType<typeof project.getSourceFile>, states: StateInfo[], props: PropInfo[]): RenderBinding[] {
  const results: RenderBinding[] = [];
  if (!sourceFile) return results;

  sourceFile.forEachDescendant((node) => {
    if (Node.isJsxAttribute(node)) {
      const attrName = node.getNameNode().getText();
      const initializer = node.getInitializer();
      if (!initializer) return;

      const initText = getJsxExpressionText(initializer);

      if (["value", "disabled", "checked"].includes(attrName)) {
        if (isStateVar(initText, states)) {
          results.push({ type: attrName, state: initText, element: getElementTag(node.getParent()) });
        }
      }

      if (attrName === "className") {
        states.forEach(s => {
          if (initText.includes(s.name) || initText.includes(s.setter)) {
            results.push({ type: "className", state: s.name, element: getElementTag(node.getParent()) });
          }
        });
        props.forEach(p => {
          if (initText.includes(p.name)) {
            results.push({ type: "className", state: p.name, element: getElementTag(node.getParent()) });
          }
        });
      }
    }

    if (Node.isJsxExpression(node)) {
      const expr = node.getExpression();
      if (!expr) return;

      if (Node.isConditionalExpression(expr)) {
        const condText = expr.getCondition().getText();
        states.forEach(s => {
          if (new RegExp(`\\b${s.name}\\b`).test(condText)) {
            let p = node.getParent();
            while (p) {
              if (Node.isJsxElement(p) || Node.isJsxSelfClosingElement(p)) {
                const el = getElementTag(Node.isJsxElement(p) ? p.getOpeningElement() : p);
                results.push({ type: "conditional_text", state: s.name, element: el });
                break;
              }
              p = p.getParent();
            }
          }
        });
        return;
      }

      if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getText() === "&&") {
        const left = expr.getLeft();
        const right = expr.getRight();

        const conditionStates = collectStatesFromCondition(left, states);
        const target = findFirstJsxInParen(right);

        conditionStates.forEach(s => {
          if (target !== "unknown") {
            results.push({ type: "conditional", state: s, element: target });
          }
        });
      }
    }
  });

  const deduped: RenderBinding[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const key = `${r.type}:${r.state}:${r.element}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }
  return deduped;
}

function getBodyNode(node: ArrowFunction | FunctionExpression): Node | undefined {
  return node.getBody() ?? undefined;
}

// ========== extractJSXEvents: add ipcMethods parameter ==========
function extractJSXEvents(sourceFile: ReturnType<typeof project.getSourceFile>, states: StateInfo[], props: PropInfo[], ipcMethods: string[]): JSXEventBinding[] {
  const results: JSXEventBinding[] = [];
  if (!sourceFile) return results;

  sourceFile.forEachDescendant((node) => {
    if (!Node.isJsxAttribute(node)) return;
    const attrName = node.getNameNode().getText();
    if (!/^on[A-Z]/.test(attrName)) return;

    const elementTag = getElementTag(node.getParent());
    const initializer = node.getInitializer();
    if (!initializer) return;

    let actualInit = initializer;
    if (Node.isJsxExpression(initializer)) {
      const inner = initializer.getExpression();
      if (inner) actualInit = inner;
    }

    if (Node.isArrowFunction(actualInit) || Node.isFunctionExpression(actualInit)) {
      const body = getBodyNode(actualInit);
      const bodyCalls: ClassifiedCall[] = body ? extractCallsFromNode(body, states, props, ipcMethods) : [];
      results.push({ element: elementTag, event: attrName, handler: "<anonymous>", isAnonymous: true, bodyCalls });
    } else {
      results.push({ element: elementTag, event: attrName, handler: actualInit.getText(), isAnonymous: false, bodyCalls: [] });
    }
  });

  return results;
}

// ========== extractFunctions: added ipcMethods parameter ==========
function extractFunctions(sourceFile: ReturnType<typeof project.getSourceFile>, states: StateInfo[], props: PropInfo[], componentNames: string[], ipcMethods: string[]): FunctionDef[] {
  const results: FunctionDef[] = [];
  if (!sourceFile) return results;

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
    if (componentNames.includes(name)) return;

    const calls = extractCallsFromNode(body, states, props, ipcMethods);
    results.push({ name, calls });
  });

  return results;
}

// ========== extractUseEffects: added ipcMethods parameter ==========
function extractUseEffects(sourceFile: ReturnType<typeof project.getSourceFile>, states: StateInfo[], props: PropInfo[], ipcMethods: string[]): UseEffectDef[] {
  const results: UseEffectDef[] = [];
  if (!sourceFile) return results;

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    if (node.getExpression().getText() !== "useEffect") return;

    const args = node.getArguments();
    if (args.length === 0) return;
    const callback = args[0];
    const deps = args[1]?.getText() ?? "[]";

    let calls: ClassifiedCall[] = [];
    if (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) {
      const body = getBodyNode(callback);
      if (body) calls = extractCallsFromNode(body, states, props, ipcMethods);
    }

    results.push({ deps, calls });
  });

  return results;
}

// ========== Main ==========

// Parse the --file command-line argument
const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const fIndex = args.indexOf("-f");
const cliFilePath = fileIndex !== -1 && args.length > fileIndex + 1
  ? args[fileIndex + 1]
  : fIndex !== -1 && args.length > fIndex + 1
  ? args[fIndex + 1]
  : null;

const filesToAnalyze = cliFilePath ? [cliFilePath] : TARGET_FILES;

for (const filePath of filesToAnalyze) {
  const sourceFile = project.getSourceFile(filePath);
  if (!sourceFile) {
    console.log(`\n=== ${filePath} NOT FOUND ===`);
    continue;
  }

  console.log(`\n=== ${filePath} ===`);

  const { states, props } = collectStateAndProps(sourceFile);
  const ipcMethods = extractIPCMethods(sourceFile);
  const componentNames = findComponentFunctions(sourceFile);

  console.log("\n-- States --");
  states.forEach(s => console.log(`  ${s.name} (setter: ${s.setter}, init: ${s.initialValue})`));

  console.log("\n-- Props --");
  props.forEach(p => console.log(`  ${p.name}: ${p.type}`));

  console.log("\n-- IPC Methods (from runtime imports) --");
  ipcMethods.forEach(m => console.log(`  ${m}`));

  console.log("\n-- useEffect --");
  const effects = extractUseEffects(sourceFile, states, props, ipcMethods);
  effects.forEach(e => {
    console.log(`  deps=${e.deps}`);
    e.calls.forEach(c => console.log(`    [${c.type}] ${c.text}`));
  });

  console.log("\n-- JSX Events --");
  const events = extractJSXEvents(sourceFile, states, props, ipcMethods);
  events.forEach(e => {
    if (e.isAnonymous) {
      console.log(`  ${e.element} ${e.event} -> <anonymous>`);
      e.bodyCalls.forEach(c => console.log(`    [${c.type}] ${c.text}`));
    } else {
      console.log(`  ${e.element} ${e.event} -> ${e.handler}`);
    }
  });

  console.log("\n-- Render Bindings --");
  const bindings = extractRenderBindings(sourceFile, states, props);
  bindings.forEach(b => {
    console.log(`  [${b.type}] state=${b.state} -> ${b.element}`);
  });

  console.log("\n-- Functions --");
  const functions = extractFunctions(sourceFile, states, props, componentNames, ipcMethods);
  functions.forEach(f => {
    console.log(`  ${f.name}`);
    f.calls.forEach(c => console.log(`    [${c.type}] ${c.text}`));
  });
}