import * as fs from "node:fs";

export interface CacheEntry {
  mtimeMs: number;
  dependencies: string[]; // Absolute paths of resolved local dependencies
}

export class DependencyCache {
  private cache: Map<string, CacheEntry> = new Map();

  /**
   * Retrieves cache entry if it is valid (i.e. file exists and modification time matches).
   * Otherwise returns null.
   */
  get(filePath: string): CacheEntry | null {
    try {
      const stats = fs.statSync(filePath);
      const entry = this.cache.get(filePath);
      if (entry && entry.mtimeMs === stats.mtimeMs) {
        return entry;
      }
    } catch {
      // If the file doesn't exist or is inaccessible, remove it from the cache
      this.cache.delete(filePath);
    }
    return null;
  }

  /**
   * Saves a dependency resolution list to the cache for a given file.
   */
  set(filePath: string, dependencies: string[]): void {
    try {
      const stats = fs.statSync(filePath);
      this.cache.set(filePath, {
        mtimeMs: stats.mtimeMs,
        dependencies,
      });
    } catch {
      // File could not be stat'ed, do not cache
    }
  }

  /**
   * Returns a snapshot of the current cache for debug or serialization.
   */
  getSnapshot(): Record<string, string[]> {
    const snapshot: Record<string, string[]> = {};
    for (const [key, value] of this.cache.entries()) {
      snapshot[key] = value.dependencies;
    }
    return snapshot;
  }

  /**
   * Prunes cache entries that are no longer active in the workspace to prevent memory leaks.
   */
  prune(activeFiles: Set<string>): void {
    for (const key of this.cache.keys()) {
      if (!activeFiles.has(key)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clears the cache.
   */
  clear(): void {
    this.cache.clear();
  }
}
