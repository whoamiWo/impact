import fs from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { loadConfig, type LoadedConfig } from "./config.js";
import { ImpactError } from "./errors.js";
import { buildPackageGraph, mergeSourceEdges, type PackageGraph } from "./graph/package-graph.js";
import { buildSourceGraph } from "./graph/source-graph.js";
import { owningPackage } from "./graph/resolve.js";
import { computeImpacts } from "./impact/analyze.js";
import { computeDeployables } from "./deploy/units.js";
import { findTestFiles, planTests } from "./tests/suggest.js";
import { PARSER_VERSION, SourceGraphCache, hashKey, sha256, type FileHashEntry } from "./cache.js";
import {
  collectDiff,
  listWorkTreeFiles,
  readFileAtRev,
  repoRoot,
  type DiffResult,
} from "./git/diff.js";
import { gitExec, type GitExec } from "./git/exec.js";
import { TOOL_VERSION } from "./version.js";
import {
  discoverWorkspaces,
  parsePackageJson,
  type PackageJson,
} from "./workspace/npm.js";
import { detectPackageManager } from "./workspace/package-manager.js";
import type {
  AnalysisResult,
  AnalyzeOptions,
  CacheStats,
  Package,
  PackageImpact,
  SourceGraph,
  Warning,
} from "./types.js";

export interface AnalyzeContext {
  result: AnalysisResult;
  config: LoadedConfig;
  graph: PackageGraph;
  diff: DiffResult;
  packageManager: string;
  filesParsed: number;
}

const TOOL_NAME = "impact";

export function makeMatcher(): (globs: string[], value: string) => boolean {
  const cache = new Map<string, (v: string) => boolean>();
  const compile = (glob: string) => {
    let fn = cache.get(glob);
    if (!fn) {
      fn = picomatch(glob, { dot: true });
      cache.set(glob, fn);
    }
    return fn;
  };
  return (globs, value) => {
    for (const glob of globs) {
      if (glob === value) return true;
      if (compile(glob)(value)) return true;
    }
    return false;
  };
}

export async function analyze(opts: AnalyzeOptions): Promise<AnalyzeContext> {
  const exec: GitExec = gitExec;
  const rootPath = path.resolve(opts.root);
  try {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) {
      throw new ImpactError(`--root must be a directory: ${rootPath}`, 2);
    }
  } catch (err) {
    if (err instanceof ImpactError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ImpactError(`--root does not exist: ${rootPath}`, 2);
    }
    throw err;
  }
  const root = await repoRoot(rootPath, exec);
  return analyzeAtRoot(root, opts, exec);
}

export async function analyzeAtRoot(
  root: string,
  opts: AnalyzeOptions,
  exec: GitExec = gitExec,
): Promise<AnalyzeContext> {
  const matchGlob = makeMatcher();
  const config = await loadConfig(root, opts.configPath);

  const readFile = async (relPath: string): Promise<string | null> => {
    try {
      const abs = path.join(root, relPath);
      const rel = path.relative(root, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new ImpactError(`Path escapes repository root: ${relPath}`, 2);
      }
      return await fs.readFile(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };

  const allFiles = await listWorkTreeFiles(root, exec);

  const discovery = await discoverWorkspaces(
    root,
    config.config,
    { readFile, listFiles: async () => allFiles },
    matchGlob,
  );

  const warnings: Warning[] = [...discovery.warnings];

  if (discovery.packages.length === 0) {
    throw new ImpactError(
      "No workspace packages discovered. Configure workspaces.include in impact.config.json or add pnpm-workspace.yaml / package.json workspaces.",
      2,
    );
  }

  const pm = await detectPackageManager(readFile);
  if (pm.warning) {
    warnings.push({ code: "NO_PACKAGE_MANAGER", message: pm.warning });
  }

  const diff = await collectDiff({
    root,
    base: opts.base,
    head: opts.head,
    working: opts.working,
    allowShallowFallback: opts.allowShallowFallback,
    exec,
  });
  for (const w of diff.warnings) warnings.push({ code: w.code, message: w.message });

  // Read manifests for all discovered packages.
  const manifests = new Map<string, Record<string, unknown>>();
  const manifestByPkg = new Map<string, PackageJson>();
  for (const pkg of discovery.packages) {
    const text = await readFile(pkg.manifestPath);
    if (!text) continue;
    try {
      const parsed = parsePackageJson(text, pkg.manifestPath);
      manifests.set(pkg.name, parsed as Record<string, unknown>);
      manifestByPkg.set(pkg.name, parsed);
    } catch (err) {
      warnings.push({
        code: "GENERIC",
        message: `Failed to parse ${pkg.manifestPath}: ${(err as Error).message}`,
        file: pkg.manifestPath,
      });
    }
  }

  // Synthesize removed / renamed packages from the merge-base.
  const removed = await synthesizeRemovedPackages(
    root,
    diff.info.mergeBase,
    diff.files,
    discovery.packages,
    readFile,
    exec,
  );
  for (const pkg of removed.packages) {
    if (discovery.packages.some((p) => p.name === pkg.name)) continue;
    discovery.packages.push(pkg);
    manifests.set(pkg.name, (removed.manifests.get(pkg.name) ?? {}) as Record<string, unknown>);
    warnings.push({
      code: "DELETED_PACKAGE",
      message: `Package ${pkg.name} (${pkg.dir}) was removed or renamed since ${diff.info.mergeBase.slice(0, 8)}; dependents are still marked affected.`,
      pkg: pkg.name,
    });
  }

  const allPackages = [...discovery.packages].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  const entryHints = new Map<string, string[]>();
  for (const [name, manifest] of manifests) {
    const list: string[] = [];
    for (const field of ["main", "module", "types", "typings"]) {
      const value = manifest[field];
      if (typeof value === "string") list.push(value);
    }
    if (list.length > 0) entryHints.set(name, list);
  }

  const graph = buildPackageGraph(allPackages, manifests, config.config);
  const manifestEdgeSet = new Set(graph.edges.map((e) => `${e.from} ->${e.to}`));

  // Source graph (with cache).
  let sourceGraph: SourceGraph = { fileEdges: [], packageEdges: [], filesParsed: 0 };
  const cacheStats: CacheStats = { hit: false, filesHashed: 0, filesReused: 0 };
  const cache = new SourceGraphCache(root, opts.cache);
  if (config.config.source.enabled) {
    const build = async () => {
      const built = await buildSourceGraph(
        root,
        config.config,
        allPackages.filter((p) => !p.removed),
        {
          readFile: async (absPath) => fs.readFile(absPath),
          listFiles: async () => allFiles,
          readText: (relPath) => readFile(relPath),
          entryHints,
        },
        matchGlob,
      );
      sourceGraph = built.graph;
      for (const w of built.warnings) warnings.push(w);
      return built;
    };

    // Without the cache there is nothing to look up or store, so skip the
    // cache key entirely (it would read and hash every source file).
    const cacheKey = opts.cache
      ? await buildCacheKey(root, allFiles, allPackages, manifests, config, matchGlob, cache)
      : null;
    if (cacheKey) {
      cacheStats.filesHashed = cacheKey.filesHashed;
      cacheStats.filesReused = cacheKey.filesReused;
    }
    const cached = cacheKey ? await cache.get(cacheKey.key) : null;
    if (cached) {
      cacheStats.hit = true;
      sourceGraph = cached.graph;
      for (const w of cached.warnings) warnings.push(w);
    } else {
      const built = await build();
      if (cacheKey) {
        await cache.set(cacheKey.key, { graph: built.graph, warnings: built.warnings });
      }
    }
  }

  for (const edge of sourceGraph.packageEdges) {
    if (!manifestEdgeSet.has(`${edge.from} ->${edge.to}`)) {
      warnings.push({
        code: "PHANTOM_DEPENDENCY",
        message: `${edge.from} imports ${edge.to} in source but does not declare it in package.json.`,
        pkg: edge.from,
      });
    }
  }
  mergeSourceEdges(graph, sourceGraph.packageEdges);

  const hasUnresolvedImports = warnings.some((w) => w.code === "UNRESOLVED_IMPORT");

  const impact = computeImpacts({
    changedFiles: diff.files,
    packages: allPackages,
    graph,
    cfg: config.config,
    depth: opts.depth,
    matchGlob,
    hasUnresolvedImports,
  });
  warnings.push(...impact.warnings);

  // Build per-package results.
  const commandsOverride = (name: string) => {
    for (const [pattern, value] of Object.entries(config.config.tests.commands)) {
      if (pattern === name || matchGlob([pattern], name)) return value;
    }
    return undefined;
  };

  const impactedNames = [...impact.impacts.keys()].sort();
  const testWarnings: Warning[] = [];
  const packageResults: PackageImpact[] = [];
  for (const name of impactedNames) {
    const info = impact.impacts.get(name)!;
    const pkg = graph.packages.get(name);
    if (!pkg) continue;
    const plan = planTests(pkg, config.config, pm.manager, { find: commandsOverride }, testWarnings);
    packageResults.push({
      name: pkg.name,
      dir: pkg.dir,
      impact: info.impact,
      confidence: info.confidence,
      reasons: sortReasons(info.reasons),
      removed: pkg.removed ? true : undefined,
      test: plan,
      testFiles: [],
    });
  }

  let filesParsed = sourceGraph.filesParsed;

  if (opts.files) {
    if (!config.config.source.enabled) {
      warnings.push({
        code: "GENERIC",
        message: "--files requested but source.enabled is false; file-level test suggestions unavailable.",
      });
    } else {
      const affectedNames = new Set(packageResults.map((p) => p.name));
      const testFiles = findTestFiles({
        changedFiles: diff.files,
        fileEdges: sourceGraph.fileEdges,
        packages: allPackages.filter((p) => !p.removed),
        affectedPackages: affectedNames,
        cfg: config.config,
        matchGlob,
        knownFiles: new Set(allFiles),
        warnings,
      });
      for (const pkg of packageResults) {
        pkg.testFiles = (testFiles.get(pkg.name) ?? []).sort();
      }
    }
  }

  warnings.push(...testWarnings);

  const deployables = computeDeployables({
    cfg: config.config,
    // Includes removed packages so deleting a package a deployable maps to
    // still marks that deployable affected (with a removedPackage reason).
    packages: allPackages,
    changedFiles: diff.files,
    affectedPackages: new Set(packageResults.map((p) => p.name)),
    configPath: config.path ? path.relative(root, config.path).split(path.sep).join("/") : null,
    root,
    matchGlob,
  });

  const result: AnalysisResult = {
    schemaVersion: 1,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    diff: diff.info,
    changedFiles: diff.files,
    packages: packageResults,
    deployables,
    warnings: sortWarnings(dedupeWarnings(warnings)),
    stats: {
      changedFiles: diff.files.length,
      packagesTotal: allPackages.filter((p) => !p.removed).length,
      packagesAffected: packageResults.length,
      deployablesAffected: deployables.filter((d) => d.affected).length,
      sourceFilesParsed: filesParsed,
      // Verbose-only: cache counters vary between --no-cache and cache-hit
      // runs, so including them by default would break deterministic output.
      ...(opts.verbose ? { cache: cacheStats } : {}),
    },
  };

  return {
    result,
    config,
    graph,
    diff,
    packageManager: pm.manager,
    filesParsed,
  };
}

async function synthesizeRemovedPackages(
  root: string,
  mergeBase: string,
  changedFiles: { path: string; oldPath?: string; status: string }[],
  existing: Package[],
  readFile: (rel: string) => Promise<string | null>,
  exec: GitExec,
): Promise<{ packages: Package[]; manifests: Map<string, PackageJson> }> {
  const packages: Package[] = [];
  const manifests = new Map<string, PackageJson>();
  const seen = new Set<string>();

  const addFromManifest = async (
    manifestPath: string,
    text: string,
  ) => {
    let parsed: PackageJson;
    try {
      parsed = parsePackageJson(text, manifestPath);
    } catch {
      return;
    }
    if (!parsed.name) return;
    if (existing.some((p) => p.name === parsed.name)) return;
    const dir = path.posix.dirname(manifestPath);
    const normalized = dir === "." ? "" : dir;
    if (normalized === "") return;
    if (seen.has(parsed.name)) return;
    seen.add(parsed.name);
    const pkg: Package = {
      name: parsed.name,
      dir: normalized,
      manifestPath,
      scripts: parsed.scripts ?? {},
      private: parsed.private === true,
      removed: true,
    };
    packages.push(pkg);
    manifests.set(parsed.name, parsed);
  };

  for (const file of changedFiles) {
    const paths = [file.path, ...(file.oldPath ? [file.oldPath] : [])];
    for (const p of paths) {
      if (!p.endsWith("package.json")) continue;
      if (path.posix.dirname(p) === ".") continue;
      const oldText = await readFileAtRev(mergeBase, p, root, exec);
      if (!oldText) continue;
      // If the manifest still exists at this path with the same name, it is not removed.
      const currentText = await readFile(p);
      let sameName = false;
      if (currentText) {
        try {
          sameName =
            parsePackageJson(currentText, p).name === parsePackageJson(oldText, p).name;
        } catch {
          sameName = false;
        }
      }
      if (sameName) continue;
      await addFromManifest(p, oldText);
    }
  }

  return { packages, manifests };
}

interface CacheKey {
  key: string;
  filesHashed: number;
  filesReused: number;
}

async function buildCacheKey(
  root: string,
  allFiles: readonly string[],
  packages: Package[],
  manifests: Map<string, Record<string, unknown>>,
  config: LoadedConfig,
  matchGlob: (globs: string[], value: string) => boolean,
  cache: SourceGraphCache,
): Promise<CacheKey> {
  const parts: string[] = [PARSER_VERSION, config.raw];
  for (const pkg of packages) {
    if (pkg.removed) continue;
    parts.push(`pkg:${pkg.name}:${pkg.dir}:${JSON.stringify(manifests.get(pkg.name) ?? {})}`);
  }
  const extensions = new Set(config.config.source.extensions);

  const candidates: string[] = [];
  for (const f of allFiles) {
    const isSource = extensions.has(path.posix.extname(f));
    const isTsconfig = matchGlob(config.config.source.tsconfig, f);
    if (!isSource && !isTsconfig) continue;
    // Only source files owned by a package affect resolution; tsconfig files
    // affect every package, so they are hashed regardless of ownership.
    if (isSource && !isTsconfig && pkgOf(f, packages) === undefined) continue;
    candidates.push(f);
  }

  // Hash reuse: a file whose size and nanosecond mtime/ctime match the
  // sidecar keeps its recorded content hash instead of being re-read. Any
  // content write updates ctime (which user space cannot back-date), so a
  // forged mtime alone cannot resurrect a stale hash. A missing or malformed
  // sidecar simply rehashes everything.
  const previous = await cache.getFileHashes();
  const next = new Map<string, FileHashEntry>();
  let filesHashed = 0;
  let filesReused = 0;

  // Stat and hash with bounded concurrency, but collect results by candidate
  // index and assemble the cache key in the original sorted file order so the
  // completion order cannot affect the key or the sidecar.
  const results = new Array<CandidateResult | undefined>(candidates.length);
  await mapWithConcurrency(candidates, STAT_CONCURRENCY, async (f, i) => {
    let stat;
    try {
      stat = await fs.stat(path.join(root, f), { bigint: true });
    } catch {
      results[i] = { file: f, missing: true, reused: false };
      return;
    }
    const entry: Omit<FileHashEntry, "hash"> = {
      size: Number(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    };
    const prev = previous.get(f);
    if (
      prev &&
      prev.size === entry.size &&
      prev.mtimeNs === entry.mtimeNs &&
      prev.ctimeNs === entry.ctimeNs
    ) {
      results[i] = { file: f, entry: { ...entry, hash: prev.hash }, reused: true };
      return;
    }
    try {
      const buf = await fs.readFile(path.join(root, f));
      results[i] = { file: f, entry: { ...entry, hash: sha256(buf) }, reused: false };
    } catch {
      results[i] = { file: f, missing: true, reused: false };
    }
  });

  for (let i = 0; i < candidates.length; i++) {
    const result = results[i]!;
    if (result.missing) {
      parts.push(`${result.file}:missing`);
      continue;
    }
    parts.push(`${result.file}:${result.entry!.hash}`);
    next.set(result.file, result.entry!);
    if (result.reused) filesReused++;
    else filesHashed++;
  }
  // With zero re-hashes and an unchanged entry count, the sidecar contents
  // would be identical to what is already on disk, so skip the write.
  if (filesHashed > 0 || next.size !== previous.size) {
    await cache.setFileHashes(next);
  }
  return { key: hashKey(parts), filesHashed, filesReused };
}

interface CandidateResult {
  file: string;
  entry?: FileHashEntry;
  missing?: boolean;
  reused: boolean;
}

const STAT_CONCURRENCY = 16;

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = nextIndex++;
        if (index >= items.length) return;
        await fn(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
}

function pkgOf(file: string, packages: Package[]): Package | undefined {
  return owningPackage(file, packages);
}

function sortReasons(reasons: PackageImpact["reasons"]): PackageImpact["reasons"] {
  const order: Record<string, number> = {
    direct: 0,
    alwaysAffected: 1,
    global: 2,
    dependency: 3,
  };
  return [...reasons].sort((a, b) => {
    const diff = order[a.type] - order[b.type];
    if (diff !== 0) return diff;
    if (a.type === "dependency" && b.type === "dependency") {
      return a.chain.join(" ").localeCompare(b.chain.join(" "));
    }
    return 0;
  });
}

function dedupeWarnings(warnings: Warning[]): Warning[] {
  const map = new Map<string, Warning>();
  for (const w of warnings) {
    const key = `${w.code}|${w.file ?? ""}|${w.pkg ?? ""}|${w.message}`;
    if (!map.has(key)) map.set(key, w);
  }
  return [...map.values()];
}

function sortWarnings(warnings: Warning[]): Warning[] {
  return warnings.sort((a, b) => {
    const ak = `${a.code}|${a.file ?? ""}|${a.pkg ?? ""}|${a.message}`;
    const bk = `${b.code}|${b.file ?? ""}|${b.pkg ?? ""}|${b.message}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
}
