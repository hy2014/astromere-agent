// replaces the original main section
// parser/index.ts
import * as fs from "fs";
import * as path from "path";
import { Project, Node } from "ts-morph";
import { buildCodeGraph, collectStateAndProps, extractIPCMethods, extractCallsFromNode, getBodyNode, detectWriteStateFields, extractRenderViewTargets } from "./parser";
import type { CodeGraph, ViewNode, FnDetail } from "./types";

const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
});

// walk files and output JSON
const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const dIndex = args.indexOf("-d");
const targetDir = dirIndex !== -1 && args.length > dirIndex + 1
    ? args[dirIndex + 1]
    : dIndex !== -1 && args.length > dIndex + 1
        ? args[dIndex + 1]
        : "src";

function collectFiles(dir: string): { tsx: string[]; ts: string[] } {
    const result: { tsx: string[]; ts: string[] } = { tsx: [], ts: [] };

    function walk(currentDir: string) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
                    walk(fullPath);
                }
            } else if (entry.name.endsWith(".tsx")) {
                result.tsx.push(fullPath);
            } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
                result.ts.push(fullPath);
            }
        }
    }

    walk(dir);
    return result;
}

// ========== Main ==========

const files = collectFiles(targetDir);

console.error(`🔍 分析目录: ${targetDir}`);
console.error(`   TSX 文件: ${files.tsx.length}`);
console.error(`   TS 文件: ${files.ts.length}`);

const allViews: ViewNode[] = [];
const allFns: FnDetail[] = [];

// first analyze all TSX (containing View + renderFn)
for (const filePath of files.tsx) {
    try {
        const { view, fns } = buildCodeGraph(filePath);
        allViews.push(view);
        allFns.push(...fns);
    } catch (e: any) {
        console.error(`⚠️  跳过 ${filePath}: ${e.message}`);
    }
}

// then analyze plain TS files (extract functions only)
for (const filePath of files.ts) {
    try {
        const sourceFile = project.getSourceFile(filePath);
        if (!sourceFile) continue;

        const { states } = collectStateAndProps(sourceFile);
        const ipcMethods = extractIPCMethods(sourceFile);
        const writeStateMap = detectWriteStateFields(sourceFile);

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
            // skip renderFn (shouldn't exist in TS files, but just in case)
            if (name.startsWith("render")) return;

            const calls = extractCallsFromNode(body, states, ipcMethods, writeStateMap);
            const renderViewTargets = extractRenderViewTargets(body);
            allFns.push({
                id: `${filePath}:${name}`,
                writes: calls.filter(c => c.type === "write").map(c => c.target!),
                ipcs: calls.filter(c => c.type === "ipc").map(c => `ipc:${c.text}`),
                fns: calls.filter(c => c.type === "call").map(c => c.text),
                views: renderViewTargets.map(t => `${filePath}:${t}`),
            });
        });
    } catch (e: any) {
        console.error(`⚠️  跳过 ${filePath}: ${e.message}`);
    }
}

const graph: CodeGraph = {
    version: new Date().toISOString(),
    views: allViews,
    fns: allFns,
};

// output to file
const outputPath = args.includes("--output")
    ? args[args.indexOf("--output") + 1]
    : "code-graph.json";

fs.writeFileSync(outputPath, JSON.stringify(graph, null, 2));
console.error(`✅ Code Graph 已生成: ${outputPath}`);
console.error(`   Views: ${allViews.length}`);
console.error(`   Fns: ${allFns.length}`);