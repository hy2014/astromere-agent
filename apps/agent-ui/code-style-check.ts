import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";


interface Violation {
  rule: string;
  message: string;
  node?: ts.Node;
  line?: number;
  character?: number;
}

/**
 * 检查 React TSX 组件是否符合编码规范
 * @param sourceCode 源代码字符串
 * @param fileName 可选文件名，用于错误报告
 * @returns 违规信息数组
 */
export function check(sourceCode: string, fileName: string = "component.tsx"): Violation[] {
  const violations: Violation[] = [];
  const sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // 收集全局信息：状态变量、setter函数、Props类型定义
  const stateVariables = new Set<string>();
  const setterFunctions = new Set<string>();
  let propsTypeAlias: ts.TypeAliasDeclaration | undefined;
  let hasPropsType = false;

  // 第一遍：收集 Props 类型和函数组件信息
  function collectGlobalInfo(node: ts.Node) {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "Props") {
      propsTypeAlias = node;
      hasPropsType = true;
    }
    ts.forEachChild(node, collectGlobalInfo);
  }
  collectGlobalInfo(sourceFile);

  // 第二遍：检查每个函数组件
  function visitComponent(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) {
      const functionBody = ts.isFunctionDeclaration(node)
        ? node.body
        : ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer)
        ? node.initializer.body
        : undefined;
      if (!functionBody) return;

      // 判断是否为组件
      let isComponent = false;
      if (ts.isFunctionDeclaration(node) && node.name) {
        isComponent = /^[A-Z]/.test(node.name.text);
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        isComponent = /^[A-Z]/.test(node.name.text);
      }
      if (!isComponent) {
        const hasJSX = (n: ts.Node): boolean => {
          if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) return true;
          return ts.forEachChild(n, hasJSX) || false;
        };
        if (ts.isBlock(functionBody) || ts.isJsxElement(functionBody) || ts.isJsxSelfClosingElement(functionBody)) {
          isComponent = hasJSX(functionBody);
        }
      }
      if (!isComponent) return;

      // 组件级状态收集
      const compStateVars = new Set<string>();
      const compSetters = new Set<string>();

      // 检查参数 Props 规则
      const parameters = ts.isFunctionDeclaration(node)
        ? node.parameters
        : ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer)
        ? node.initializer.parameters
        : [];
      checkPropsRule(parameters, node);

      // 遍历组件函数体
      function visitComponentBody(child: ts.Node) {
        if (ts.isCallExpression(child)) {
          if (child.expression.getText() === "useState") checkUseState(child);
          if (child.expression.getText() === "useEffect") checkUseEffect(child);
          // 禁止动态 import
          if (child.expression.kind === ts.SyntaxKind.ImportKeyword) {
            violations.push({
              rule: "禁止函数体内动态 import",
              message: "组件函数内禁止使用动态 import()。",
              node: child,
              line: sourceFile.getLineAndCharacterOfPosition(child.getStart()).line + 1,
            });
          }
        }

        // 内部函数声明检查（必须用 const 箭头函数）
        if (ts.isFunctionDeclaration(child)) {
          violations.push({
            rule: "组件瘦身令",
            message: `组件内部函数 "${child.name?.text}" 应使用 const 箭头函数声明，禁止 function 声明。`,
            node: child,
            line: sourceFile.getLineAndCharacterOfPosition(child.getStart()).line + 1,
          });
        }
        if (ts.isVariableDeclaration(child) && child.initializer && ts.isFunctionExpression(child.initializer)) {
          violations.push({
            rule: "组件瘦身令",
            message: `组件内部函数 "${child.name.getText()}" 使用了匿名函数表达式，必须使用 const 箭头函数。`,
            node: child,
            line: sourceFile.getLineAndCharacterOfPosition(child.getStart()).line + 1,
          });
        }

        // 检查 JSX 属性规则
        if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
          checkJsxAttributes(child);
        }

        ts.forEachChild(child, visitComponentBody);
      }

      visitComponentBody(functionBody);

      // 条件渲染白名单检查（增强后）
      checkConditionalRenderingInComponent(functionBody);

      // 将组件状态同步到全局
      compStateVars.forEach(v => stateVariables.add(v));
      compSetters.forEach(v => setterFunctions.add(v));

      // ====== 辅助检查函数 ======
      function checkUseState(call: ts.CallExpression) {
        const parent = call.parent;
        if (ts.isVariableDeclaration(parent) && ts.isArrayBindingPattern(parent.name)) {
          const elements = parent.name.elements;
          if (elements.length !== 2) {
            violations.push({
              rule: "useState 解构规范",
              message: "useState 解构必须恰好为 [state, setter] 双元素。",
              node: call,
              line: sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1,
            });
          } else {
            const stateName = elements[0].name.getText();
            const setterName = elements[1].name.getText();
            const expectedSetter = "set" + stateName.charAt(0).toUpperCase() + stateName.slice(1);
            if (setterName !== expectedSetter) {
              violations.push({
                rule: "useState 解构命名对称性",
                message: `setter 应命名为 "${expectedSetter}"，实际为 "${setterName}"。`,
                node: elements[1],
                line: sourceFile.getLineAndCharacterOfPosition(elements[1].getStart()).line + 1,
              });
            }
            compStateVars.add(stateName);
            compSetters.add(setterName);
          }
          if (call.arguments.length === 0) {
            violations.push({
              rule: "useState 初始化",
              message: "useState 必须显式传入初始值，禁止隐式 undefined。",
              node: call,
              line: sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1,
            });
          }
        } else {
          violations.push({
            rule: "useState 使用方式",
            message: "useState 返回值必须通过数组解构赋值。",
            node: call,
            line: sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1,
          });
        }
      }

      function checkUseEffect(call: ts.CallExpression) {
        if (call.arguments.length < 2) {
          violations.push({
            rule: "useEffect 依赖数组",
            message: "useEffect 必须携带依赖数组参数，即使是空数组 []。",
            node: call,
            line: sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1,
          });
        }
      }

      function checkJsxAttributes(jsx: ts.JsxElement | ts.JsxSelfClosingElement) {
        const attributes = ts.isJsxElement(jsx) ? jsx.openingElement.attributes : jsx.attributes;
        for (const attr of attributes.properties) {
          if (ts.isJsxAttribute(attr)) {
            const attrName = attr.name.text;
            // 原子属性绑定：value, disabled, checked 必须直接是状态变量
            if (attrName === "value" || attrName === "disabled" || attrName === "checked") {
              if (attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
                const expr = attr.initializer.expression;
                if (
                    !ts.isIdentifier(expr) &&
                    !ts.isPropertyAccessExpression(expr) &&
                    !ts.isElementAccessExpression(expr)
                ) {
                  violations.push({
                    rule: "原子属性绑定",
                    message: `属性 "${attrName}" 的值必须是单一状态变量标识符，禁止表达式。`,
                    node: attr,
                    line: sourceFile.getLineAndCharacterOfPosition(attr.getStart()).line + 1,
                  });
                }
              }
            }

            // 样式状态化隔离：动态 className 必须包含 state 或 setter
            if (attrName === "className" && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
              const expr = attr.initializer.expression;
              if (!ts.isStringLiteral(expr)) {
                let containsStateOrSetter = false;
                function checkNodeForState(node: ts.Node) {
                  if (ts.isIdentifier(node) && (compStateVars.has(node.text) || compSetters.has(node.text))) {
                    containsStateOrSetter = true;
                  }
                  ts.forEachChild(node, checkNodeForState);
                }
                checkNodeForState(expr);
                if (!containsStateOrSetter) {
                  violations.push({
                    rule: "样式状态化隔离",
                    message: "className 的动态计算必须引用组件的 state 或 setter。",
                    node: attr,
                    line: sourceFile.getLineAndCharacterOfPosition(attr.getStart()).line + 1,
                  });
                }
              }
            }

            // 事件处理内联函数限制
            if (attrName.startsWith("on") && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
              const handler = attr.initializer.expression;
              if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
                const body = handler.body;
                if (ts.isBlock(body)) {
                  if (body.statements.length > 1) {
                    violations.push({
                      rule: "事件处理内联逻辑限制",
                      message: "内联事件处理函数禁止包含复杂逻辑，请提取为独立函数。",
                      node: handler,
                      line: sourceFile.getLineAndCharacterOfPosition(handler.getStart()).line + 1,
                    });
                  } else if (body.statements.length === 1) {
                    const stmt = body.statements[0];
                    if (ts.isExpressionStatement(stmt)) {
                      const callExpr = stmt.expression;
                      if (ts.isCallExpression(callExpr)) {
                        const callee = callExpr.expression;
                        if (!ts.isIdentifier(callee) || !compSetters.has(callee.text)) {
                          violations.push({
                            rule: "事件处理内联逻辑限制",
                            message: "内联事件处理函数只允许调用 setter 函数或简单逻辑。",
                            node: handler,
                            line: sourceFile.getLineAndCharacterOfPosition(handler.getStart()).line + 1,
                          });
                        }
                      } else {
                        violations.push({
                          rule: "事件处理内联逻辑限制",
                          message: "内联事件处理函数内部逻辑过于复杂，请提取。",
                          node: handler,
                          line: sourceFile.getLineAndCharacterOfPosition(handler.getStart()).line + 1,
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // 增强的条件渲染白名单检查
      function checkConditionalRenderingInComponent(body: ts.Node) {
        function checkNode(node: ts.Node) {
          if (ts.isJsxExpression(node)) {
            const innerExpr = node.expression;
            if (innerExpr) {
              checkConditionalPattern(innerExpr, node);
            }
          }
          ts.forEachChild(node, checkNode);
        }
        checkNode(body);
      }

      function checkConditionalPattern(expr: ts.Expression, jsxExprNode: ts.JsxExpression) {
        // 逻辑与：必须为 (condition) && (JSX) 形式
        if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          const left = expr.left;
          const right = expr.right;
          if (!ts.isParenthesizedExpression(left)) {
            violations.push({
              rule: "条件渲染白名单",
              message: "逻辑与左侧条件必须用括号包裹，例如 (condition) && (JSX)",
              node: left,
              line: sourceFile.getLineAndCharacterOfPosition(left.getStart()).line + 1,
            });
          }
          if (!ts.isParenthesizedExpression(right)) {
            violations.push({
              rule: "条件渲染白名单",
              message: "逻辑与右侧 JSX 必须用括号包裹，例如 (condition) && (JSX)",
              node: right,
              line: sourceFile.getLineAndCharacterOfPosition(right.getStart()).line + 1,
            });
          } else {
            const rightInner = right.expression;
            if (!ts.isJsxElement(rightInner) && !ts.isJsxSelfClosingElement(rightInner) && !ts.isJsxFragment(rightInner)) {
              violations.push({
                rule: "条件渲染白名单",
                message: "逻辑与右侧括号内必须是 JSX 元素",
                node: rightInner,
                line: sourceFile.getLineAndCharacterOfPosition(rightInner.getStart()).line + 1,
              });
            }
          }
        }
        // 三元表达式：仅允许字符串分支
        else if (ts.isConditionalExpression(expr)) {
          if (!ts.isStringLiteral(expr.whenTrue) || !ts.isStringLiteral(expr.whenFalse)) {
            violations.push({
              rule: "条件渲染白名单",
              message: "三元表达式只能用于字符串条件渲染，分支必须为字符串字面量",
              node: expr,
              line: sourceFile.getLineAndCharacterOfPosition(expr.getStart()).line + 1,
            });
          }
        }
        // 其他表达式不检查
      }
    }

    ts.forEachChild(node, visitComponent);
  }

  function checkPropsRule(parameters: ts.NodeArray<ts.ParameterDeclaration>, componentNode: ts.Node) {
    if (parameters.length === 0) return;
    const param = parameters[0];
    if (hasPropsType) {
      if (!ts.isObjectBindingPattern(param.name)) {
        violations.push({
          rule: "独占式属性定义",
          message: "已定义 Props 类型，组件参数必须使用对象解构。",
          node: param,
          line: sourceFile.getLineAndCharacterOfPosition(param.getStart()).line + 1,
        });
      }
    } else {
      if (!ts.isObjectBindingPattern(param.name)) {
        violations.push({
          rule: "退步容错",
          message: "未定义 Props 类型时，组件参数入口必须使用对象解构。",
          node: param,
          line: sourceFile.getLineAndCharacterOfPosition(param.getStart()).line + 1,
        });
      }
    }

    // 检查 props.xxx 内联引用
    if (ts.isIdentifier(param.name) && param.name.text === "props") {
      function checkPropsUsage(body: ts.Node) {
        if (ts.isPropertyAccessExpression(body)) {
          if (ts.isIdentifier(body.expression) && body.expression.text === "props") {
            violations.push({
              rule: "退步容错",
              message: "禁止使用 props.xxx 内联引用，请使用解构。",
              node: body,
              line: sourceFile.getLineAndCharacterOfPosition(body.getStart()).line + 1,
            });
          }
        }
        ts.forEachChild(body, checkPropsUsage);
      }
      if (ts.isFunctionDeclaration(componentNode)) {
        componentNode.body && checkPropsUsage(componentNode.body);
      } else if (ts.isVariableDeclaration(componentNode) && componentNode.initializer && ts.isArrowFunction(componentNode.initializer)) {
        checkPropsUsage(componentNode.initializer.body);
      }
    }
  }

  ts.forEachChild(sourceFile, visitComponent);
  return violations;
}

function main() {
  const args = process.argv.slice(2);
  
  // 显示帮助
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: ts-node code-style-check.ts --file <path-to-component.tsx>

Options:
  -f, --file <path>   指定要检查的 TSX 文件
  -h, --help          显示帮助信息
`);
    process.exit(0);
  }

  // 解析 --file 或 -f 参数
  let filePath = "";
  const fileIndex = args.indexOf("--file");
  const fIndex = args.indexOf("-f");

  if (fileIndex !== -1 && args.length > fileIndex + 1) {
    filePath = args[fileIndex + 1];
  } else if (fIndex !== -1 && args.length > fIndex + 1) {
    filePath = args[fIndex + 1];
  }

  if (!filePath) {
    console.error("错误：必须指定要检查的文件路径。使用 --file <path> 或 -f <path>");
    process.exit(1);
  }

  const absolutePath = path.resolve(filePath);
  
  // 检查文件是否存在
  if (!fs.existsSync(absolutePath)) {
    console.error(`错误：文件不存在 - ${absolutePath}`);
    process.exit(1);
  }

  // 读取文件内容
  const sourceCode = fs.readFileSync(absolutePath, "utf-8");
  const fileName = path.basename(absolutePath);

  // 执行检查
  const violations = check(sourceCode, fileName);

  if (violations.length > 0) {
    console.log(`\n❌ 发现 ${violations.length} 条不规范项：\n`);
    violations.forEach((v, idx) => {
      console.log(`  ${idx + 1}. [${v.rule}] ${v.message} (行 ${v.line})`);
    });
    console.log("\n检查未通过。\n");
    process.exit(1);
  } else {
    console.log("✅ 编码规范检查通过。\n");
    process.exit(0);
  }
}

// 如果直接运行此脚本，则执行命令行入口
if (import.meta.url && process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main();
}

// 导出 check 函数，方便在其他模块中引用
