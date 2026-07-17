#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DependencyCache } from "./cache.js";
import {
  walkDirectory,
  buildTree,
  renderTree,
  findWorkspaceRoot,
  getDownstreamDependents,
  buildWorkspaceGraph,
  formatMermaid,
  MAX_SCAN_FILES,
  FileStat,
} from "./parser.js";

// Initialize dependency cache
const cache = new DependencyCache();

// Keep track of the last workspace root accessed to dynamically populate resources
let lastWorkspaceRoot: string | null = null;

// Initialize Server
const server = new Server(
  {
    name: "repomind-mcp",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// --- TOOLS REGISTRATION & ROUTING ---

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "repomind_scan_workspace",
        description:
          "Recursively scans a workspace directory, mapping its file structure, listing source files, and providing statistics, while ignoring binary/build folders (e.g. node_modules, .git, dist).",
        inputSchema: {
          type: "object",
          properties: {
            basePath: {
              type: "string",
              description: "The absolute path to the workspace root directory to scan.",
            },
          },
          required: ["basePath"],
        },
      },
      {
        name: "repomind_get_dependencies",
        description:
          "Analyzes imports in JavaScript, TypeScript, and Python files within a target path (file or directory) to build a directed dependency graph showing local module relationships.",
        inputSchema: {
          type: "object",
          properties: {
            targetPath: {
              type: "string",
              description: "The absolute path to the file or directory to analyze for dependencies.",
            },
          },
          required: ["targetPath"],
        },
      },
      {
        name: "repomind_generate_diagram",
        description:
          "Generates a beautiful visual Mermaid diagram representing the dependency graph of the files. Can group files by their parent directories into subgraphs.",
        inputSchema: {
          type: "object",
          properties: {
            scopePaths: {
              type: "array",
              items: {
                type: "string",
              },
              description:
                "Optional absolute paths of files or directories to restrict the scope of the diagram. If omitted, maps the entire workspace.",
            },
            workspaceRoot: {
              type: "string",
              description:
                "Optional absolute path of the workspace root to resolve imports. Defaults to finding it from scopePaths or process.cwd().",
            },
            diagramType: {
              type: "string",
              description: "The type of diagram to generate. Currently supports 'mermaid'.",
              enum: ["mermaid"],
              default: "mermaid",
            },
          },
        },
      },
      {
        name: "repomind_impact_analysis",
        description:
          "Calculates the downstream blast radius (reverse dependents) of modifying a target file or module, showing exactly which files depend on it directly or indirectly.",
        inputSchema: {
          type: "object",
          properties: {
            targetPath: {
              type: "string",
              description: "The absolute path to the target file to assess.",
            },
            depth: {
              type: "number",
              description: "The maximum traversal depth for reverse lookup (defaults to 3).",
              default: 3,
            },
          },
          required: ["targetPath"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "repomind_scan_workspace": {
        const basePathArg = args?.basePath as string;
        if (!basePathArg) {
          throw new Error("Missing parameter: basePath");
        }
        const basePath = path.resolve(basePathArg);
        lastWorkspaceRoot = basePath;
        const existingFiles = new Set<string>();
        const results: FileStat[] = [];

        await walkDirectory(basePath, basePath, existingFiles, results);

        let totalSize = 0;
        let totalFiles = 0;
        let totalDirs = 0;
        const fileStats: { [ext: string]: { count: number; size: number } } = {};
        const fileList: any[] = [];
        const dirSet = new Set<string>();

        for (const file of results) {
          if (file.error) {
            fileList.push(file);
            continue;
          }
          totalFiles++;
          totalSize += file.size;

          const ext = file.extension || "no-extension";
          if (!fileStats[ext]) {
            fileStats[ext] = { count: 0, size: 0 };
          }
          fileStats[ext].count++;
          fileStats[ext].size += file.size;

          const dir = path.dirname(file.relativePath);
          if (dir !== "." && dir !== "") {
            dirSet.add(dir);
          }

          fileList.push({
            relativePath: file.relativePath,
            size: file.size,
            extension: file.extension,
            lastModified: file.lastModified,
          });
        }
        totalDirs = dirSet.size;

        const relativePaths = fileList
          .filter((f) => !f.error)
          .map((f) => f.relativePath);
        const asciiTree = renderTree(buildTree(relativePaths), "", 0, 3);

        const summary = {
          basePath,
          totalFiles,
          totalDirectories: totalDirs,
          totalSize,
          fileStats,
          warning: results.length >= MAX_SCAN_FILES ? `Scan truncated at ${MAX_SCAN_FILES} files.` : undefined,
          files: fileList,
          treeOverview: asciiTree,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(summary, null, 2),
            },
          ],
        };
      }

      case "repomind_get_dependencies": {
        const targetPathArg = args?.targetPath as string;
        if (!targetPathArg) {
          throw new Error("Missing parameter: targetPath");
        }

        const targetPath = path.resolve(targetPathArg);
        const workspaceRoot = await findWorkspaceRoot(targetPath);
        lastWorkspaceRoot = workspaceRoot;

        const existingFiles = new Set<string>();
        const workspaceFiles: FileStat[] = [];
        await walkDirectory(workspaceRoot, workspaceRoot, existingFiles, workspaceFiles);

        const scopeFiles: string[] = [];
        let isDirectory = false;
        try {
          const targetStat = await fs.stat(targetPath);
          isDirectory = targetStat.isDirectory();
        } catch (error: any) {
          throw new Error(`Target path does not exist or is inaccessible: ${error.message}`);
        }

        if (isDirectory) {
          for (const file of existingFiles) {
            if (file.startsWith(targetPath)) {
              scopeFiles.push(file);
            }
          }
        } else {
          scopeFiles.push(targetPath);
        }

        const graph = await buildWorkspaceGraph(workspaceRoot, existingFiles, cache);

        const nodes: any[] = [];
        const edges: any[] = [];
        const visited = new Set<string>();

        // Gather subset graph starting from scopeFiles
        const queue = [...scopeFiles];
        while (queue.length > 0 && visited.size < 1000) {
          const current = queue.shift()!;
          if (visited.has(current)) continue;
          visited.add(current);

          const relCurrent = path.relative(workspaceRoot, current);
          const ext = path.extname(current).slice(1).toLowerCase();
          nodes.push({
            relativePath: relCurrent,
            extension: ext,
          });

          const deps = graph.adjacencyList.get(current) || [];
          for (const dep of deps) {
            edges.push({
              from: relCurrent,
              to: path.relative(workspaceRoot, dep),
            });
            if (!visited.has(dep)) {
              queue.push(dep);
            }
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  workspaceRoot,
                  targetPath: path.relative(workspaceRoot, targetPath) || ".",
                  nodes,
                  edges,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "repomind_generate_diagram": {
        const scopePathsArg = args?.scopePaths as string[] | undefined;
        let workspaceRootArg = args?.workspaceRoot as string | undefined;

        let scopePaths: string[] = [];
        if (scopePathsArg && scopePathsArg.length > 0) {
          scopePaths = scopePathsArg.map((p) => path.resolve(p));
        }

        let refPath = process.cwd();
        if (scopePaths.length > 0) {
          refPath = scopePaths[0];
        } else if (workspaceRootArg) {
          refPath = path.resolve(workspaceRootArg);
        }

        const workspaceRoot = workspaceRootArg
          ? path.resolve(workspaceRootArg)
          : await findWorkspaceRoot(refPath);
        lastWorkspaceRoot = workspaceRoot;

        const existingFiles = new Set<string>();
        const workspaceFiles: FileStat[] = [];
        await walkDirectory(workspaceRoot, workspaceRoot, existingFiles, workspaceFiles);

        const seedFiles: string[] = [];
        if (scopePaths.length > 0) {
          for (const sp of scopePaths) {
            try {
              const stat = await fs.stat(sp);
              if (stat.isDirectory()) {
                for (const file of existingFiles) {
                  if (file.startsWith(sp)) {
                    seedFiles.push(file);
                  }
                }
              } else {
                seedFiles.push(sp);
              }
            } catch {}
          }
        } else {
          seedFiles.push(...existingFiles);
        }

        const graph = await buildWorkspaceGraph(workspaceRoot, existingFiles, cache);

        const nodes: { [path: string]: { relativePath: string; extension: string } } = {};
        const edges: Array<{ from: string; to: string }> = [];
        const visited = new Set<string>();
        const queue = [...seedFiles];

        while (queue.length > 0 && visited.size < 1000) {
          const current = queue.shift()!;
          if (visited.has(current)) continue;
          visited.add(current);

          const relCurrent = path.relative(workspaceRoot, current);
          nodes[current] = {
            relativePath: relCurrent,
            extension: path.extname(current).slice(1).toLowerCase(),
          };

          const deps = graph.adjacencyList.get(current) || [];
          for (const dep of deps) {
            edges.push({ from: current, to: dep });
            if (!visited.has(dep)) {
              queue.push(dep);
            }
          }
        }

        const diagramStr = formatMermaid(nodes, edges);

        return {
          content: [
            {
              type: "text",
              text: diagramStr,
            },
          ],
        };
      }

      case "repomind_impact_analysis": {
        const targetPathArg = args?.targetPath as string;
        const depthArg = (args?.depth as number) ?? 3;

        if (!targetPathArg) {
          throw new Error("Missing parameter: targetPath");
        }

        const targetPath = path.resolve(targetPathArg);
        const workspaceRoot = await findWorkspaceRoot(targetPath);
        lastWorkspaceRoot = workspaceRoot;

        const impacted = await getDownstreamDependents(targetPath, workspaceRoot, cache, depthArg);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  targetPath: path.relative(workspaceRoot, targetPath) || ".",
                  workspaceRoot,
                  maxDepth: depthArg,
                  impactedFilesCount: impacted.length,
                  impactedFiles: impacted,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error executing tool: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// --- RESOURCES HANDLERS ---

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "repomind://workspace/graph",
        name: "RepoMind Workspace Dependency Graph",
        description: "Full serialized JSON representation of the current workspace dependency mapping.",
        mimeType: "application/json",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri !== "repomind://workspace/graph") {
    throw new Error(`Resource not found: ${uri}`);
  }

  try {
    const wsRoot = lastWorkspaceRoot || (await findWorkspaceRoot(process.cwd()));
    const existingFiles = new Set<string>();
    const workspaceFiles: FileStat[] = [];
    await walkDirectory(wsRoot, wsRoot, existingFiles, workspaceFiles);

    const graph = await buildWorkspaceGraph(wsRoot, existingFiles, cache);

    const serializedGraph = {
      workspaceRoot: wsRoot,
      graph: {
        adjacencyList: Object.fromEntries(
          Array.from(graph.adjacencyList.entries()).map(([k, v]) => [
            path.relative(wsRoot, k),
            v.map((p) => path.relative(wsRoot, p)),
          ])
        ),
        reverseAdjacencyList: Object.fromEntries(
          Array.from(graph.reverseAdjacencyList.entries()).map(([k, v]) => [
            path.relative(wsRoot, k),
            v.map((p) => path.relative(wsRoot, p)),
          ])
        ),
      },
    };

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(serializedGraph, null, 2),
        },
      ],
    };
  } catch (error: any) {
    throw new Error(`Failed to read dependency graph resource: ${error.message}`);
  }
});

// --- PROMPTS HANDLERS ---

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "architecture-review",
        description:
          "Performs a structured review of the codebase architecture based on workspace structure and dependency connections.",
        arguments: [
          {
            name: "directory",
            description: "The absolute path of the directory to review (defaults to active workspace).",
            required: false,
          },
        ],
      },
      {
        name: "blast-radius-check",
        description:
          "Evaluates the potential downstream blast radius of modifying a target file by executing impact analysis and planning refactoring steps.",
        arguments: [
          {
            name: "file",
            description: "The absolute path of the target file to evaluate.",
            required: true,
          },
          {
            name: "depth",
            description: "The maximum analysis depth (defaults to 3).",
            required: false,
          },
        ],
      },
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: promptArgs } = request.params;

  if (name === "architecture-review") {
    let dir = promptArgs?.directory as string | undefined;
    if (!dir) {
      dir = lastWorkspaceRoot || (await findWorkspaceRoot(process.cwd()));
    }
    const targetDir = path.resolve(dir);

    // Perform scan internally to provide summary details
    const existingFiles = new Set<string>();
    const results: FileStat[] = [];
    await walkDirectory(targetDir, targetDir, existingFiles, results);

    const relativePaths = results
      .filter((f) => !f.error)
      .map((f) => f.relativePath);
    const asciiTree = renderTree(buildTree(relativePaths), "", 0, 3);

    return {
      description: `Perform an architectural review for ${targetDir}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are a Principal Software Architect. Please perform a rigorous architectural review of the codebase at path: \`${targetDir}\`.
Here is the scanned directory tree and files summary:

\`\`\`
${asciiTree}
\`\`\`

Total files analyzed: ${results.length}

Please:
1. Examine the module organization and dependency separations.
2. Identify design patterns, separation of concerns, or architectural violations.
3. Recommend structural improvements, module decapping, and circular dependency prevention strategies.`,
          },
        },
      ],
    };
  }

  if (name === "blast-radius-check") {
    const file = promptArgs?.file as string;
    const depthStr = promptArgs?.depth as string | undefined;
    const depth = depthStr ? parseInt(depthStr, 10) : 3;

    if (!file) {
      throw new Error("Missing required prompt argument: file");
    }

    const targetFile = path.resolve(file);
    const wsRoot = await findWorkspaceRoot(targetFile);
    const impacted = await getDownstreamDependents(targetFile, wsRoot, cache, depth);

    const dependentsList = impacted
      .map(
        (f) =>
          `- \`${f.relativePath}\` (Impact Depth: ${f.depth}) | Import path chain: ${f.importChain.join(" -> ")}`
      )
      .join("\n");

    return {
      description: `Perform blast radius analysis for ${path.basename(targetFile)}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are an expert engineer planning a refactoring task. We are planning to modify the file: \`${path.relative(
              wsRoot,
              targetFile
            )}\`.
Our downstream impact analysis indicates the following files import this component directly or indirectly:

${dependentsList || "No downstream local dependents detected."}

Please:
1. Identify potential regression points or cascading compilation/runtime failures.
2. Formulate a step-by-step refactoring plan to isolate this change.
3. Suggest appropriate unit testing and integration testing strategies to secure this blast radius.`,
          },
        },
      ],
    };
  }

  throw new Error(`Prompt not found: ${name}`);
});

// Main server run block
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("RepoMind-MCP v2.0 server running on stdio transport");
}

main().catch((error) => {
  console.error("Critical server startup error:", error);
  process.exit(1);
});
