import path from "node:path";
import type {
  Config,
  FileEdge,
  Package,
  PackageManager,
  Warning,
} from "../types.js";

export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderTestCommand(
  manager: PackageManager,
  pkgName: string,
  script: string,
): string {
  const p = shellQuote(pkgName);
  const s = shellQuote(script);
  switch (manager) {
    case "pnpm":
      return `pnpm --filter ${p} run ${s}`;
    case "yarn":
      return `yarn workspace ${p} run ${s}`;
    case "bun":
      return `bun run --filter ${p} ${s}`;
    case "npm":
    default:
      return `npm run ${s} --workspace ${p}`;
  }
}

export interface TestPlan {
  scripts: string[];
  commands: string[];
}

export interface CommandOverrides {
  find(name: string): string | string[] | undefined;
}

export function planTests(
  pkg: Package,
  cfg: Config,
  manager: PackageManager,
  overrides: CommandOverrides,
  warnings: Warning[],
): TestPlan {
  if (pkg.removed) {
    return { scripts: [], commands: [] };
  }
  const overridden = overrides.find(pkg.name);
  if (overridden !== undefined) {
    const commands = Array.isArray(overridden) ? overridden : [overridden];
    const scripts = cfg.tests.scripts.filter((s) => s in pkg.scripts);
    // scripts and commands must stay index-aligned (renderers pair by index):
    // use the matched script name when available, else the command itself.
    return {
      scripts: commands.map((cmd, i) => scripts[i] ?? cmd),
      commands,
    };
  }

  const scripts = cfg.tests.scripts.filter((s) => s in pkg.scripts);
  if (scripts.length === 0) {
    warnings.push({
      code: "NO_TEST_SCRIPT",
      message: `No test script (${cfg.tests.scripts.join(", ")}) in ${pkg.manifestPath}; omitted from CI matrix.`,
      pkg: pkg.name,
    });
    return { scripts: [], commands: [] };
  }
  return {
    scripts,
    commands: scripts.map((s) => renderTestCommand(manager, pkg.name, s)),
  };
}

export interface TestFileInput {
  changedFiles: { path: string; oldPath?: string }[];
  fileEdges: FileEdge[];
  packages: Package[];
  affectedPackages: Set<string>;
  cfg: Config;
  matchGlob: (globs: string[], value: string) => boolean;
  knownFiles: Set<string>;
  warnings: Warning[];
}

export function findTestFiles(input: TestFileInput): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const { cfg } = input;
  const isTestFile = (p: string) => input.matchGlob(cfg.tests.include, p);

  const packageOf = (file: string): Package | undefined => {
    let best: Package | undefined;
    for (const pkg of input.packages) {
      if (pkg.dir && file.startsWith(pkg.dir + "/")) {
        if (!best || pkg.dir.length > best.dir.length) best = pkg;
      }
    }
    return best;
  };

  // Reverse file edges: file -> files that import it.
  const reverse = new Map<string, Set<string>>();
  for (const edge of input.fileEdges) {
    let set = reverse.get(edge.to);
    if (!set) {
      set = new Set();
      reverse.set(edge.to, set);
    }
    set.add(edge.from);
  }

  const collected = new Map<string, Set<string>>();
  const addForPackage = (file: string, pkg: Package) => {
    if (!input.affectedPackages.has(pkg.name)) return;
    let set = collected.get(pkg.name);
    if (!set) {
      set = new Set();
      collected.set(pkg.name, set);
    }
    set.add(file);
  };

  const queue: string[] = [];
  for (const file of input.changedFiles) {
    queue.push(file.path);
    if (file.oldPath) queue.push(file.oldPath);
  }

  const visited = new Set<string>();
  const addIfExisting = (file: string, pkg: Package) => {
    if (!input.knownFiles.has(file)) return;
    if (!isTestFile(file)) return;
    addForPackage(file, pkg);
  };

  for (const candidate of queue) {
    const pkg = packageOf(candidate);
    if (!pkg) continue;
    // Same-name sibling tests: foo.ts -> foo.test.ts / foo.spec.ts -> __tests__/foo.ts
    for (const sibling of siblingTests(candidate, cfg)) {
      addIfExisting(sibling, pkg);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const currentPkg = packageOf(current);
    if (currentPkg) {
      for (const sibling of siblingTests(current, cfg)) {
        addIfExisting(sibling, currentPkg);
      }
    }
    if (isTestFile(current)) {
      if (currentPkg) addForPackage(current, currentPkg);
    }
    const importers = reverse.get(current);
    if (importers) {
      for (const importer of importers) {
        if (!visited.has(importer)) queue.push(importer);
      }
    }
  }

  let total = 0;
  const allFiles: { pkg: string; file: string }[] = [];
  for (const [pkgName, files] of collected) {
    for (const f of files) allFiles.push({ pkg: pkgName, file: f });
  }
  allFiles.sort((a, b) =>
    a.pkg === b.pkg ? (a.file < b.file ? -1 : 1) : a.pkg < b.pkg ? -1 : 1,
  );
  if (allFiles.length > cfg.tests.maxFiles) {
    input.warnings.push({
      code: "TEST_FILE_LIMIT",
      message: `Test file suggestions truncated to ${cfg.tests.maxFiles} (found ${allFiles.length}).`,
    });
  }
  for (const entry of allFiles.slice(0, cfg.tests.maxFiles)) {
    total++;
    const list = result.get(entry.pkg) ?? [];
    list.push(entry.file);
    result.set(entry.pkg, list);
  }
  void total;
  return result;
}

function siblingTests(file: string, cfg: Config): string[] {
  const ext = path.posix.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  const exts = cfg.source.extensions.length > 0 ? cfg.source.extensions : [ext];
  const out: string[] = [];
  for (const e of exts) {
    out.push(`${stem}.test${e}`);
    out.push(`${stem}.spec${e}`);
  }
  const dir = path.posix.dirname(file);
  const base = path.posix.basename(stem);
  for (const e of exts) {
    out.push(`${dir}/__tests__/${base}.test${e}`);
    out.push(`${dir}/__tests__/${base}.spec${e}`);
  }
  return out;
}
