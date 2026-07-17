# RepoMind-MCP (v2.0)

An open-source Model Context Protocol (MCP) server that provides advanced repository mapping, local dependency graphing, and architectural diagram generation capabilities. Designed to run locally over stdio transport, it helps AI clients easily understand the codebase structures of JavaScript, TypeScript, and Python projects.

## v2.0 Features & Upgrades

### 1. File Modification-Based Caching Layer
* **Location:** `src/cache.ts`
* **Features:** Caches parsed module dependencies in memory. Validates the cache using fast file modification timestamps (`mtimeMs` via `fs.statSync`) to prevent redundant file reads. If a file's modification time changes, its cached dependencies are automatically invalidated.

### 2. Downstream Impact Analysis
* **Location:** `src/parser.ts`
* **Features:** Calculates the reverse dependencies (downstream blast radius) of modifying any target source file using breadth-first search (BFS). Useful for planning refactors and discovering cascading compilation or regression risks.

### 3. MCP Resources API
* **URI:** `repomind://workspace/graph`
* **Features:** Exposes the complete serialized workspace dependency graph in JSON format (contains both the direct `adjacencyList` and `reverseAdjacencyList` using relative paths).

### 4. Dynamic MCP Prompts
* **`architecture-review`:** Exposes a structured system architect review template pre-populated with the target directory's real-time ASCII file structure tree.
* **`blast-radius-check`:** Exposes a refactoring checklist prompt template pre-populated with the real-time downstream dependents list and import chains of the target file.

---

## Exposed Tools

### `repomind_scan_workspace`
Recursively walks and maps a workspace directory.
* **Arguments:**
  * `basePath` (string, required): Absolute path of the workspace root to scan.
* **Outputs:** JSON summary containing statistics, ignored lists, and a visual ASCII directory tree.

### `repomind_get_dependencies`
Analyzes local imports in source files to construct an in-memory directed dependency graph.
* **Arguments:**
  * `targetPath` (string, required): Absolute path to the file or directory to analyze.

### `repomind_generate_diagram`
Generates a structured, visually organized Mermaid.js architecture diagram.
* **Arguments:**
  * `scopePaths` (array of strings, optional): Specific files or directories to restrict diagram seed files to.
  * `workspaceRoot` (string, optional): Root directory to resolve imports.
  * `diagramType` (string, optional): `"mermaid"` (default).

### `repomind_impact_analysis` (New in v2.0)
Calculates the downstream blast radius (reverse dependents) of modifying a target file.
* **Arguments:**
  * `targetPath` (string, required): Absolute path of the target file.
  * `depth` (number, optional): Maximum traversal depth (defaults to 3).

---

## Setup & Building

### 1. Install Dependencies
```bash
npm install
```

### 2. Build the Project
```bash
npm run build
```

This compiles TypeScript source from `src/` to ESM JavaScript files in the `dist/` folder, including executable permissions on entry points.

### 3. Run the Server
To run the server locally over stdio:
```bash
npm start
```

---

## Configuration & Client Integration

### Option A: Standard Release (via NPX or Global Install)
For users who install your published package from the public npm registry.

#### Using NPX (Recommended)
Add the server directly to your Claude Desktop config without installing it beforehand:
```json
{
  "mcpServers": {
    "repomind-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "repomind-mcp"
      ]
    }
  }
}
```

#### Global Installation
Install the package globally:
```bash
npm install -g repomind-mcp
```
Then reference it by command name:
```json
{
  "mcpServers": {
    "repomind-mcp": {
      "command": "repomind-mcp",
      "args": []
    }
  }
}
```

### Option B: Local Development Integration
For developing or running the server locally from this repository.

Add this configuration (replace path in `args` with the absolute path of your compiled `dist/index.js` file):
```json
{
  "mcpServers": {
    "repomind-mcp": {
      "command": "node",
      "args": ["C:/Users/dipan/Desktop/RepoMind-MCP/dist/index.js"]
    }
  }
}
```

---

## Testing

A local integration script is provided under `scratch/test-server.js` which spins up the built server and runs test calls using JSON-RPC. To run the tests:

```bash
node scratch/test-server.js
```

---

## License
MIT
