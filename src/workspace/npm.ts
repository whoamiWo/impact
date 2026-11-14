import { z } from "zod";
import YAML from "yaml";
import type { WorkspaceDeps, WorkspaceDiscoveryResult } from "./provider.js";
import { normalizeDir, packageDirOf } from "./provider.js";
import type { Config, Package } from "../types.js";
import { ConfigError } from "../errors.js";

const pkgJsonSchema = z
  .object({
    name: z.string().optional(),
    private: z.boolean().optional(),
    scripts: z.record(z.string()).optional(),
    workspaces: z
      .union([z.array(z.string()), z.object({ packages: z.array(z.string()) })])
      .optional(),
    dependencies: z.record(z.string()).optional(),
    devDependencies: z.record(z.string()).optional(),
    optionalDependencies: z.record(z.string()).optional(),
    peerDependencies: z.record(z.string()).optional(),
  })
  .passthrough();

export type PackageJson = z.infer<typeof pkgJsonSchema>;

export function parsePackageJson(
  text: string,
  file: string,
): PackageJson {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
  const result = pkgJsonSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid package.json ${file}: ${result.error.message}`);
  }
  return result.data;
}

const SKIP_DIR = /(^|\/)(node_modules|dist|build|coverage|\.git)(\/|$)/;

export async function discoverWorkspaces(
  root: string,
  cfg: Config,
  deps: WorkspaceDeps,
  matchGlob: (globs: string[], value: string) => boolean,
): Promise<WorkspaceDiscoveryResult> {
  const warnings: WorkspaceDiscoveryResult["warnings"] = [];
  let globs: string[] = [];
  let source: WorkspaceDiscoveryResult["source"] = "config";

  if (cfg.workspaces.include && cfg.workspaces.include.length > 0) {
    globs = cfg.workspaces.include;
    source = "config";
  } else {
    const pnpm = await deps.readFile("pnpm-workspace.yaml");
    if (pnpm) {
      const parsed = parsePnpmWorkspace(pnpm);
      if (parsed.length > 0) {
        globs = parsed;
        source = "pnpm-workspace.yaml";
      }
    }
    if (globs.length === 0) {
      const rootPkg = await deps.readFile("package.json");
      if (rootPkg) {
        try {
          const parsed = parsePackageJson(rootPkg, "package.json");
          const ws = parsed.workspaces;
          const list = Array.isArray(ws) ? ws : ws?.packages;
          if (list && list.length > 0) {
            globs = list;
            source = "package.json";
          }
        } catch {
          // Ignore root manifest parse errors here; they surface elsewhere.
        }
      }
    }
  }

  if (globs.length === 0) {
    warnings.push({
      code: "NO_WORKSPACE_CONFIG",
      message:
        "No workspace configuration found. Set workspaces.include in impact.config, or add pnpm-workspace.yaml / package.json workspaces.",
    });
    return { packages: [], globs: [], source, warnings };
  }

  const allFiles = await deps.listFiles();
  const manifestFiles = allFiles.filter(
    (f) => f === "package.json" || f.endsWith("/package.json"),
  );

  const includeGlobs = globs.filter((g) => !g.startsWith("!"));
  const excludeGlobs = [
    ...globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1)),
    ...cfg.workspaces.exclude,
  ];
  const packagesByDir = new Map<string, Package>();
  for (const manifestPath of manifestFiles) {
    if (SKIP_DIR.test(manifestPath)) continue;
    const dir = packageDirOf(manifestPath);
    if (dir === "" || dir === ".") continue;
    if (!matchGlob(includeGlobs, dir)) continue;
    if (matchGlob(excludeGlobs, dir)) continue;
    const text = await deps.readFile(manifestPath);
    if (!text) continue;
    let parsed: PackageJson;
    try {
      parsed = parsePackageJson(text, manifestPath);
    } catch (err) {
      warnings.push({
        code: "NO_WORKSPACE_CONFIG",
        message: (err as Error).message,
        file: manifestPath,
      });
      continue;
    }
    const name = parsed.name;
    if (!name) {
      warnings.push({
        code: "NO_WORKSPACE_CONFIG",
        message: `Workspace package manifest has no "name": ${manifestPath}`,
        file: manifestPath,
      });
      continue;
    }
    if (packagesByDir.has(dir)) continue;
    packagesByDir.set(dir, {
      name,
      dir: normalizeDir(dir),
      manifestPath,
      scripts: parsed.scripts ?? {},
      private: parsed.private === true,
    });
  }

  const dirsByName = new Map<string, string[]>();
  for (const pkg of packagesByDir.values()) {
    const dirs = dirsByName.get(pkg.name) ?? [];
    dirs.push(pkg.dir);
    dirsByName.set(pkg.name, dirs);
  }
  const conflicts = [...dirsByName.entries()]
    .filter(([, dirs]) => dirs.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));
  if (conflicts.length > 0) {
    const details = conflicts
      .map(([name, dirs]) => `"${name}" in ${[...dirs].sort().join(", ")}`)
      .join("; ");
    throw new ConfigError(
      `Duplicate workspace package names: ${details}. Give each package a unique "name" in its package.json.`,
    );
  }

  const packages = [...packagesByDir.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  return { packages, globs, source, warnings };
}

export function parsePnpmWorkspace(text: string): string[] {
  let data: unknown;
  try {
    data = YAML.parse(text);
  } catch {
    return [];
  }
  const result = z.object({ packages: z.array(z.string()) }).safeParse(data);
  return result.success ? result.data.packages : [];
}
