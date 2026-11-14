import path from "node:path";
import type { Config, Package } from "../types.js";

export interface WorkspaceProvider {
  id: string;
  detect(root: string): Promise<boolean>;
  discover(root: string, cfg: Config, deps: WorkspaceDeps): Promise<Package[]>;
}

export interface WorkspaceDeps {
  readFile(relPath: string): Promise<string | null>;
  listFiles(): Promise<string[]>;
}

export interface WorkspaceDiscoveryResult {
  packages: Package[];
  globs: string[];
  source: "config" | "pnpm-workspace.yaml" | "package.json";
  warnings: { code: "NO_WORKSPACE_CONFIG"; message: string; file?: string }[];
}

export function normalizeDir(dir: string): string {
  const p = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return p === "." ? "" : p;
}

export function packageDirOf(manifestPath: string): string {
  return normalizeDir(path.posix.dirname(manifestPath));
}
