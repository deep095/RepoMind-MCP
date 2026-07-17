import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { DependencyCache } from "./cache.js";

// Constants for ignored patterns
export const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".cache",
  "coverage",
  ".nyc_output",
  "bower_components",
  "venv",
  ".venv",
  "env",
  ".env",
  "__pycache__",
]);

export const IGNORED_EXTENSIONS = new Set([
  // Images & Assets
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "svg",
  // Media
  "mp3", "wav", "mp4", "webm", "mov", "avi",
  // Archives
  "zip", "tar", "gz", "rar", "7z", "tgz",
  // Documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "epub",
  // Fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // Executables
  "exe", "dll", "so", "dylib", "bin", "class", "o", "obj", "pyc",
  // Database & Cache
  "db", "sqlite", "lock",
]);

export const IGNORED_FILENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "pnpm-workspace.yaml",
  ".ds_store",
  "thumbs.db",
]);

export const MAX_SCAN_FILES = 5000;

export interface FileStat {
  absolutePath: string;
  relativePath: string;
  size: number;
  extension: string;
  lastModified: string;
  error?: string;
}

// Recursively walks the directory and populates files details
export async function walkDirectory(
  dir: string,
  basePath: string,
  existingFiles: Set<string>,
  results: FileStat[]
): Promise<void> {
  if (results.length >= MAX_SCAN_FILES) {
    return;
  }

  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch (error: any) {
    results.push({
      absolutePath: dir,
      relativePath: path.relative(basePath, dir),
      size: 0,
      extension: "",
      lastModified: "",
      error: `Could not read directory: ${error.message}`,
    });
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_SCAN_FILES) {
      break;
    }

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(basePath, fullPath);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await walkDirectory(fullPath, basePath, existingFiles, results);
    } else if (entry.isFile()) {
      const lowerName = entry.name.toLowerCase();
      if (IGNORED_FILENAMES.has(lowerName)) {
        continue;
      }

      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (IGNORED_EXTENSIONS.has(ext)) {
        continue;
      }

      existingFiles.add(fullPath);

      try {
        const stats = fs.statSync(fullPath);
        results.push({
          absolutePath: fullPath,
          relativePath: relPath,
          size: stats.size,
          extension: ext,
          lastModified: stats.mtime.toISOString(),
        });
      } catch (error: any) {
        results.push({
          absolutePath: fullPath,
          relativePath: relPath,
          size: 0,
          extension: ext,
          lastModified: "",
          error: `Could not stat file: ${error.message}`,
        });
      }
    }
  }
}

// Tree builder node
export interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

// Build ASCII directory tree
export function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "root", children: new Map(), isFile: false };
  for (const p of paths) {
    const parts = p.split(/[/\\]/);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      const isLast = i === parts.length - 1;
      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map(), isFile: isLast });
      }
      current = current.children.get(part)!;
    }
  }
  return root;
}

export function renderTree(node: TreeNode, prefix: string = "", depth: number = 0, maxDepth: number = 3): string {
  if (depth > maxDepth) {
    return prefix + "...\n";
  }
  let result = "";
  const entries = Array.from(node.children.entries()).sort((a, b) => {
    if (a[1].isFile !== b[1].isFile) {
      return a[1].isFile ? 1 : -1;
    }
    return a[0].localeCompare(b[0]);
  });

  for (let i = 0; i < entries.length; i++) {
    const [name, child] = entries[i];
    const isLast = i === entries.length - 1;
    const marker = isLast ? "└── " : "├── ";
    result += `${prefix}${marker}${name}${child.isFile ? "" : "/"}\n`;
    if (!child.isFile && child.children.size > 0) {
      const nextPrefix = prefix + (isLast ? "    " : "│   ");
      result += renderTree(child, nextPrefix, depth + 1, maxDepth);
    }
  }
  return result;
}

// Find workspace root by traversing upwards
export async function findWorkspaceRoot(startPath: string): Promise<string> {
  let current = path.resolve(startPath);
  try {
    const stat = fs.statSync(current);
    if (!stat.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  const rootIndicators = ["package.json", "tsconfig.json", ".git", "requirements.txt", "go.mod", "Cargo.toml"];

  while (true) {
    for (const indicator of rootIndicators) {
      const checkPath = path.join(current, indicator);
      try {
        await fsPromises.access(checkPath);
        return current;
      } catch {}
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}

// JavaScript/TypeScript module parser
export function parseJsTsImports(content: string): string[] {
  const imports: string[] = [];
  let match;

  // 1. Static imports and exports: import ... from 'path' or export ... from 'path'
  const staticImportExportRegex = /^[ \t]*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;
  while ((match = staticImportExportRegex.exec(content)) !== null) {
    if (match[1]) imports.push(match[1]);
  }

  // 2. Simple imports: import 'path'
  const simpleImportRegex = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
  while ((match = simpleImportRegex.exec(content)) !== null) {
    if (match[1]) imports.push(match[1]);
  }

  // 3. require('path') calls
  const requireRegex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    if (match[1]) imports.push(match[1]);
  }

  // 4. Dynamic import('path') calls
  const dynamicImportRegex = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(content)) !== null) {
    if (match[1]) imports.push(match[1]);
  }

  return Array.from(new Set(imports));
}

// Python module parser
export interface PyImport {
  path: string;
  isRelative: boolean;
  dotsCount: number;
}

export function parsePythonImports(content: string): PyImport[] {
  const imports: PyImport[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;

    // from .foo.bar import baz
    const fromImportMatch = trimmed.match(/^from\s+(\.+[a-zA-Z0-9_.]*)\s+import/);
    if (fromImportMatch) {
      const specifier = fromImportMatch[1];
      const dotMatch = specifier.match(/^\.+/);
      const dotsCount = dotMatch ? dotMatch[0].length : 0;
      const cleanPath = specifier.slice(dotsCount).replace(/\./g, "/");
      imports.push({
        path: cleanPath,
        isRelative: dotsCount > 0,
        dotsCount,
      });
      continue;
    }

    // import foo, bar
    const importMatch = trimmed.match(/^import\s+([a-zA-Z0-9_.,\s]+)/);
    if (importMatch) {
      const modules = importMatch[1].split(",");
      for (const mod of modules) {
        const cleanMod = mod.trim().replace(/\./g, "/");
        if (cleanMod) {
          imports.push({
            path: cleanMod,
            isRelative: false,
            dotsCount: 0,
          });
        }
      }
    }
  }
  return imports;
}

// Resolve Javascript/TypeScript imports using in-memory file index
export function resolveJsTsImport(
  sourceFile: string,
  importPath: string,
  existingFiles: Set<string>
): string | null {
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
    return null; // External or path-mapped module
  }

  const sourceDir = path.dirname(sourceFile);
  
  // ESM import extensions map to source files (e.g. ./cache.js -> ./cache.ts)
  let cleanImportPath = importPath;
  if (importPath.endsWith(".js")) {
    cleanImportPath = importPath.slice(0, -3);
  } else if (importPath.endsWith(".jsx")) {
    cleanImportPath = importPath.slice(0, -4);
  }

  const resolvedBase = path.resolve(sourceDir, cleanImportPath);

  const extensions = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".json"];
  for (const ext of extensions) {
    const candidate = resolvedBase + ext;
    if (existingFiles.has(candidate)) {
      return candidate;
    }
  }

  const indexExtensions = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.json"];
  for (const idxExt of indexExtensions) {
    const candidate = resolvedBase + idxExt;
    if (existingFiles.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

// Resolve Python imports using in-memory file index
export function resolvePythonImport(
  sourceFile: string,
  imp: PyImport,
  existingFiles: Set<string>
): string | null {
  let resolvedBase = "";

  if (imp.isRelative) {
    let currentDir = path.dirname(sourceFile);
    for (let i = 1; i < imp.dotsCount; i++) {
      currentDir = path.dirname(currentDir);
    }
    resolvedBase = imp.path ? path.resolve(currentDir, imp.path) : currentDir;
  } else {
    // Non-relative import: check relative to the repository root directory
    return null;
  }

  const candidates = [
    resolvedBase + ".py",
    path.join(resolvedBase, "__init__.py"),
  ];

  for (const candidate of candidates) {
    if (existingFiles.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

// Parse single file dependencies, checking/updating the dependency cache
export async function parseFileDependencies(
  filePath: string,
  existingFiles: Set<string>,
  cache: DependencyCache
): Promise<string[]> {
  const cached = cache.get(filePath);
  if (cached) {
    return cached.dependencies;
  }

  const resolvedDeps: string[] = [];
  try {
    const content = await fsPromises.readFile(filePath, "utf-8");
    const ext = path.extname(filePath).slice(1).toLowerCase();

    if (["js", "jsx", "ts", "tsx"].includes(ext)) {
      const imports = parseJsTsImports(content);
      for (const imp of imports) {
        const resolved = resolveJsTsImport(filePath, imp, existingFiles);
        if (resolved && resolved !== filePath) {
          resolvedDeps.push(resolved);
        }
      }
    } else if (ext === "py") {
      const pyImports = parsePythonImports(content);
      for (const imp of pyImports) {
        const resolved = resolvePythonImport(filePath, imp, existingFiles);
        if (resolved && resolved !== filePath) {
          resolvedDeps.push(resolved);
        }
      }
    }
  } catch {
    // Fail silently, dependencies remain empty
  }

  cache.set(filePath, resolvedDeps);
  return resolvedDeps;
}

export interface DependencyGraph {
  adjacencyList: Map<string, string[]>;
  reverseAdjacencyList: Map<string, string[]>;
}

// Build global workspace dependency graph
export async function buildWorkspaceGraph(
  workspaceRoot: string,
  existingFiles: Set<string>,
  cache: DependencyCache
): Promise<DependencyGraph> {
  // Prune any deleted or moved files from cache to prevent memory leaks
  cache.prune(existingFiles);

  const adjacencyList = new Map<string, string[]>();
  const reverseAdjacencyList = new Map<string, string[]>();

  for (const file of existingFiles) {
    adjacencyList.set(file, []);
    reverseAdjacencyList.set(file, []);
  }

  for (const file of existingFiles) {
    const deps = await parseFileDependencies(file, existingFiles, cache);
    adjacencyList.set(file, deps);

    for (const dep of deps) {
      if (!reverseAdjacencyList.has(dep)) {
        reverseAdjacencyList.set(dep, []);
      }
      reverseAdjacencyList.get(dep)!.push(file);
    }
  }

  return { adjacencyList, reverseAdjacencyList };
}

export interface ImpactedFile {
  relativePath: string;
  depth: number;
  importChain: string[];
}

// Calculate reverse lookup dependents for downstream blast radius calculation
export async function getDownstreamDependents(
  targetPath: string,
  workspaceRoot: string,
  cache: DependencyCache,
  maxDepth: number = 3
): Promise<ImpactedFile[]> {
  const targetAbs = path.resolve(targetPath);
  
  // Resolve workspace root
  const existingFiles = new Set<string>();
  const results: FileStat[] = [];
  await walkDirectory(workspaceRoot, workspaceRoot, existingFiles, results);

  if (!existingFiles.has(targetAbs)) {
    return [];
  }

  // Build/retrieve workspace graph
  const graph = await buildWorkspaceGraph(workspaceRoot, existingFiles, cache);

  const queue: [string, number, string[]][] = [[targetAbs, 0, [targetAbs]]];
  const visited = new Set<string>();
  visited.add(targetAbs);

  const impacted: ImpactedFile[] = [];

  while (queue.length > 0) {
    const [current, currentDepth, chain] = queue.shift()!;
    if (currentDepth >= maxDepth) continue;

    const dependents = graph.reverseAdjacencyList.get(current) || [];
    for (const dep of dependents) {
      if (!visited.has(dep)) {
        visited.add(dep);
        const nextChain = [...chain, dep];
        impacted.push({
          relativePath: path.relative(workspaceRoot, dep),
          depth: currentDepth + 1,
          importChain: nextChain.map((p) => path.relative(workspaceRoot, p)),
        });
        queue.push([dep, currentDepth + 1, nextChain]);
      }
    }
  }

  return impacted;
}

// Format sanitized nodes and edges as a Mermaid diagram
export function sanitizeId(p: string): string {
  return "id_" + p.replace(/[^a-zA-Z0-9]/g, "_");
}

export function formatMermaid(
  nodes: { [key: string]: { relativePath: string; extension: string } },
  edges: Array<{ from: string; to: string }>
): string {
  let output = "graph TD\n";

  const groups: { [dir: string]: string[] } = {};
  const rootNodes: string[] = [];

  for (const nodeKey of Object.keys(nodes)) {
    const relPath = nodes[nodeKey].relativePath;
    const dir = path.dirname(relPath);
    if (dir === "." || dir === "") {
      rootNodes.push(nodeKey);
    } else {
      if (!groups[dir]) {
        groups[dir] = [];
      }
      groups[dir].push(nodeKey);
    }
  }

  let subgraphIndex = 0;
  for (const dir of Object.keys(groups)) {
    const dirSanitized = dir.replace(/\\/g, "/");
    const sgId = `subgraph_${subgraphIndex++}`;
    output += `  subgraph ${sgId} ["${dirSanitized}"]\n`;
    for (const nodeKey of groups[dir]) {
      const node = nodes[nodeKey];
      const id = sanitizeId(node.relativePath);
      const label = path.basename(node.relativePath);
      output += `    ${id}["${label}"]\n`;
    }
    output += "  end\n\n";
  }

  for (const nodeKey of rootNodes) {
    const node = nodes[nodeKey];
    const id = sanitizeId(node.relativePath);
    const label = path.basename(node.relativePath);
    output += `  ${id}["${label}"]\n`;
  }

  const edgeSet = new Set<string>();
  for (const edge of edges) {
    const fromNode = nodes[edge.from];
    const toNode = nodes[edge.to];
    if (fromNode && toNode) {
      const fromId = sanitizeId(fromNode.relativePath);
      const toId = sanitizeId(toNode.relativePath);
      const edgeStr = `  ${fromId} --> ${toId}`;
      if (!edgeSet.has(edgeStr)) {
        edgeSet.add(edgeStr);
        output += edgeStr + "\n";
      }
    }
  }

  return output;
}
