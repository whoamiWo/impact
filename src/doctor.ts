import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, type LoadedConfig } from "./config.js";
import { listWorkTreeFiles, repoRoot } from "./git/diff.js";
import { analyze, makeMatcher, type AnalyzeContext } from "./pipeline.js";
import type { AnalyzeOptions } from "./types.js";
import { discoverWorkspaces } from "./workspace/npm.js";
import { detectPackageManager } from "./workspace/package-manager.js";

export function renderDoctor(ctx: AnalyzeContext): string {
  const { result, config, graph, diff, packageManager, filesParsed } = ctx;
  const lines: string[] = [];
  lines.push("impact doctor");
  lines.push("");
  lines.push(`config: ${config.path ?? "(defaults, no config file)"}`);
  lines.push(`package manager: ${packageManager}`);
  lines.push(
    `diff: base=${diff.info.base} (${diff.info.baseSha.slice(0, 8)}) head=${diff.info.head} (${diff.info.headSha.slice(0, 8)}) mergeBase=${diff.info.mergeBase.slice(0, 8)} working=${diff.info.includesWorkingTree}`,
  );
  lines.push(`changed files: ${diff.files.length}`);
  lines.push(
    `packages: ${result.stats.packagesTotal} total, ${result.stats.packagesAffected} affected`,
  );

  const manifestEdges = graph.edges.filter((e) => e.kind === "manifest").length;
  const sourceEdges = graph.edges.filter((e) => e.kind === "source").length;
  lines.push(`edges: manifest=${manifestEdges} source=${sourceEdges}`);
  lines.push(`source files parsed: ${filesParsed}`);
  if (result.stats.cache) {
    const c = result.stats.cache;
    lines.push(
      `cache: ${c.hit ? "hit" : "miss"}, files hashed=${c.filesHashed} reused=${c.filesReused}`,
    );
  }

  const withTests = [...graph.packages.values()].filter(
    (p) => !p.removed && Object.keys(p.scripts).some((s) => config.config.tests.scripts.includes(s)),
  ).length;
  const active = [...graph.packages.values()].filter((p) => !p.removed).length;
  lines.push(
    `test script coverage: ${withTests}/${active} packages have one of [${config.config.tests.scripts.join(", ")}]`,
  );

  lines.push(`deployables: ${result.deployables.length}`);
  for (const d of result.deployables) {
    lines.push(`  - ${d.name}: ${d.packages.join(", ") || "(no packages)"}`);
  }

  const unresolved = result.warnings.filter((w) => w.code === "UNRESOLVED_IMPORT");
  lines.push(`unresolved imports: ${unresolved.length}`);
  for (const w of unresolved.slice(0, 20)) {
    lines.push(`  - ${w.file}: ${w.message}`);
  }

  const other = result.warnings.filter((w) => w.code !== "UNRESOLVED_IMPORT");
  lines.push(`warnings: ${other.length}`);
  for (const w of other.slice(0, 30)) {
    lines.push(`  - ${w.code}${w.file ? ` [${w.file}]` : ""}: ${w.message}`);
  }
  return lines.join("\n") + "\n";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) out.push(next);
    }
  };
  await walk("");
  return out.sort();
}

/**
 * Doctor is diagnostic-first: it tries the full analysis and, when that
 * fails, still reports root/git/config/workspace state for the failed stage.
 */
export async function runDoctor(opts: AnalyzeOptions): Promise<string> {
  try {
    return renderDoctor(await analyze(opts));
  } catch (err) {
    return renderFallback(opts, err);
  }
}

async function renderFallback(opts: AnalyzeOptions, error: unknown): Promise<string> {
  const lines: string[] = ["impact doctor", "", "status: analysis did not complete"];
  const rootPath = path.resolve(opts.root);
  lines.push(`requested root: ${rootPath}`);
  try {
    const stat = await fs.stat(rootPath);
    lines.push(`root: ${stat.isDirectory() ? "directory" : "not a directory"}`);
  } catch {
    lines.push("root: does not exist");
  }

  let root = rootPath;
  let gitAvailable = false;
  try {
    root = await repoRoot(rootPath);
    lines.push(`git: repository root ${root}`);
    gitAvailable = true;
  } catch (err) {
    lines.push(`git: unavailable (${message(err)})`);
  }

  const readFile = async (relPath: string): Promise<string | null> => {
    const abs = path.join(root, relPath);
    const rel = path.relative(root, abs);
    try {
      if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
      return await fs.readFile(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };

  let config: LoadedConfig | null = null;
  try {
    config = await loadConfig(root, opts.configPath);
    lines.push(`config: ${config.path ?? "(defaults, no config file)"}`);
  } catch (err) {
    lines.push(`config: error (${message(err)})`);
  }

  let files: string[] | null = null;
  if (gitAvailable) {
    try {
      files = await listWorkTreeFiles(root);
    } catch {
      files = null;
    }
  }
  if (files === null) {
    files = await walkFiles(root);
    lines.push(`workspace files: ${files.length} (filesystem walk; git ls-files unavailable)`);
  } else {
    lines.push(`workspace files: ${files.length}`);
  }

  try {
    const pm = await detectPackageManager(readFile);
    lines.push(`package manager: ${pm.manager} (${pm.evidence})`);
  } catch (err) {
    lines.push(`package manager: error (${message(err)})`);
  }

  if (config) {
    try {
      const discovery = await discoverWorkspaces(
        root,
        config.config,
        { readFile, listFiles: async () => files! },
        makeMatcher(),
      );
      lines.push(
        `workspace packages: ${discovery.packages.length}${
          discovery.packages.length === 0 ? " (no workspace configuration found)" : ""
        }`,
      );
      for (const w of discovery.warnings.slice(0, 10)) {
        lines.push(`  - ${w.code}: ${w.message}`);
      }
    } catch (err) {
      lines.push(`workspace: error (${message(err)})`);
    }
  } else {
    lines.push("workspace packages: skipped (config could not be loaded)");
  }

  lines.push("");
  lines.push(`failed stage: ${message(error)}`);

  const text = message(error).toLowerCase();
  if (text.includes("git repository")) {
    lines.push(
      'hint: run "git init" and commit your workspace, or pass --root <path> to the repository root.',
    );
  } else if (text.includes("workspace")) {
    lines.push(
      'hint: declare workspaces (package.json "workspaces", pnpm-workspace.yaml, or config.workspaces.include).',
    );
  } else if (text.includes("config")) {
    lines.push("hint: fix the config file or pass --config <path>; see README for the schema.");
  } else if (text.includes("merge-base") || text.includes("shallow")) {
    lines.push(
      'hint: run "git fetch --unshallow", pass --base <ref>, or add --allow-shallow-fallback.',
    );
  }
  return lines.join("\n") + "\n";
}
