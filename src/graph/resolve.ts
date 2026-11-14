import path from "node:path";
import type { Package, Warning } from "../types.js";

export interface TsPaths {
  baseUrl?: string;
  mappings: { pattern: string; targets: string[] }[];
}

/** Strip // and /* *\/ comments plus trailing commas, tolerating JSONC. */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let inLine = false;
  let inBlock = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      i++;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export interface TsConfigEntry {
  /** Repo-relative path of the tsconfig file. */
  file: string;
  /** Repo-relative directory containing the tsconfig file. */
  dir: string;
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

export function parseTsconfig(text: string, file = ""): TsConfigEntry {
  const data = JSON.parse(stripJsonComments(text)) as {
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  };
  return {
    file,
    dir: file ? path.posix.dirname(file) : "",
    baseUrl: data.compilerOptions?.baseUrl,
    paths: data.compilerOptions?.paths,
  };
}

export interface SourceResolver {
  /** Resolve a relative/user specifier to a repo-relative file path, if any. */
  resolveFile(fromFile: string, specifier: string): { path?: string; external?: string };
  /** Return the workspace package name for a bare specifier, if mapped. */
  resolvePackage(specifier: string): string | undefined;
}

export function buildResolver(
  root: string,
  knownFiles: Set<string>,
  extensions: string[],
  packages: Package[],
  tsconfigs: TsConfigEntry[],
  entryHints?: Map<string, string[]>,
): SourceResolver {
  const pkgNames = new Set(packages.map((p) => p.name));
  const pkgByName = new Map(packages.map((p) => [p.name, p]));
  const dirToPkg = packages
    .map((p) => p.dir)
    .filter((d) => d.length > 0)
    .sort((a, b) => b.length - a.length);
  void dirToPkg;

  // baseUrl and path targets are resolved relative to the directory of the
  // tsconfig file that declares them. When multiple tsconfigs declare the
  // same pattern, the later-loaded config wins (configs are loaded in the
  // order of cfg.source.tsconfig, so root-level config first, per-package
  // config last).
  const byPattern = new Map<string, { baseUrl: string; targets: string[] }>();
  for (const tc of tsconfigs) {
    if (!tc.paths) continue;
    const baseUrl = normalizeBase(normalizePath(path.posix.join(tc.dir ?? "", tc.baseUrl ?? ".")));
    for (const [pattern, targets] of Object.entries(tc.paths)) {
      byPattern.set(pattern, { baseUrl, targets });
    }
  }
  const mappings: { pattern: string; baseUrl: string; targets: string[] }[] = [
    ...byPattern.entries(),
  ].map(([pattern, m]) => ({ pattern, ...m }));
  // Longest, most-specific patterns first.
  mappings.sort((a, b) => b.pattern.length - a.pattern.length);

  const extList = extensions.length > 0 ? extensions : [".ts", ".js"];

  function candidatesFor(base: string): string[] {
    const norm = base.replace(/\\/g, "/");
    const out: string[] = [];
    out.push(norm);
    for (const ext of extList) out.push(norm + ext);
    for (const ext of extList) out.push(`${norm}/index${ext}`);
    // TS-style: import "./x.js" points at "./x.ts"
    const jsExt = /\.(m|c)?jsx?$/.exec(norm);
    if (jsExt) {
      const stem = norm.slice(0, jsExt.index);
      for (const ext of [".ts", ".tsx", ".mts", ".cts"]) out.push(stem + ext);
    }
    return out;
  }

  function existingPath(base: string): string | undefined {
    for (const cand of candidatesFor(base)) {
      if (knownFiles.has(cand)) return cand;
    }
    return undefined;
  }

  function rebase(baseUrl: string, target: string): string {
    return normalizePath(path.posix.join(baseUrl, target));
  }

  function matchMapping(
    specifier: string,
  ): { pattern: string; baseUrl: string; targets: string[] } | undefined {
    for (const m of mappings) {
      const star = m.pattern.indexOf("*");
      if (star === -1) {
        if (m.pattern === specifier) return m;
        continue;
      }
      const prefix = m.pattern.slice(0, star);
      const suffix = m.pattern.slice(star + 1);
      if (
        specifier.length >= prefix.length + suffix.length &&
        specifier.startsWith(prefix) &&
        specifier.endsWith(suffix)
      ) {
        return m;
      }
    }
    return undefined;
  }

  function wildcardTarget(
    m: { pattern: string; baseUrl: string; targets: string[] },
    specifier: string,
  ): string | undefined {
    const star = m.pattern.indexOf("*");
    if (star === -1) return m.targets[0];
    const prefix = m.pattern.slice(0, star);
    const suffix = m.pattern.slice(star + 1);
    const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
    const target = m.targets[0];
    if (!target) return undefined;
    return target.includes("*") ? target.replace("*", captured) : target;
  }

  function splitBare(specifier: string): { name: string; subpath: string } {
    const parts = specifier.split("/");
    const isScoped = specifier.startsWith("@");
    const name = isScoped ? parts.slice(0, 2).join("/") : parts[0];
    const rest = parts.slice(isScoped ? 2 : 1).join("/");
    return { name, subpath: rest };
  }

  function packageEntry(specifier: string): string | undefined {
    const { name, subpath } = splitBare(specifier);
    const pkg = pkgByName.get(name);
    if (!pkg) return undefined;
    if (subpath.length > 0) {
      return existingPath(normalizePath(path.posix.join(pkg.dir, subpath)));
    }
    const hints = entryHints?.get(name) ?? [];
    for (const hint of hints) {
      const found = existingPath(normalizePath(path.posix.join(pkg.dir, hint)));
      if (found) return found;
    }
    for (const fallback of ["src/index", "index"]) {
      const found = existingPath(normalizePath(path.posix.join(pkg.dir, fallback)));
      if (found) return found;
    }
    return undefined;
  }

  return {
    resolveFile(fromFile, specifier) {
      const fromDir = path.posix.dirname(fromFile);
      if (specifier.startsWith(".")) {
        const base = normalizePath(path.posix.join(fromDir, specifier));
        const found = existingPath(base);
        return found ? { path: found } : {};
      }
      const mapping = matchMapping(specifier);
      if (mapping) {
        const target = wildcardTarget(mapping, specifier);
        if (target) {
          const base = rebase(mapping.baseUrl, target);
          const found = existingPath(base);
          if (found) return { path: found };
        }
        return {};
      }
      const entry = packageEntry(specifier);
      if (entry) return { path: entry };
      return { external: specifier };
    },

    resolvePackage(specifier) {
      const { name: bare } = splitBare(specifier);
      if (pkgNames.has(bare)) return bare;
      // tsconfig paths mapping entry may directly map to a package.
      const mapping = matchMapping(specifier);
      if (mapping) {
        const target = wildcardTarget(mapping, specifier);
        if (target) {
          const tParts = target.split("/");
          const tBare = target.startsWith("@")
            ? tParts.slice(0, 2).join("/")
            : tParts[0];
          if (pkgNames.has(tBare)) return tBare;
        }
      }
      return undefined;
    },
  };
}

export function normalizeBase(base: string): string {
  const norm = normalizePath(base);
  return norm === "." ? "" : norm;
}

export function normalizePath(p: string): string {
  const norm = path.posix.normalize(p.replace(/\\/g, "/"));
  return norm.replace(/^\.\//, "");
}

const OWNERSHIP_INDEXES = new WeakMap<readonly Package[], Map<string, Package>>();

// Callers pass a stable package snapshot, so indexing once per array turns the
// previous O(files x packages) prefix scan into one lookup per ancestor dir.
function ownershipIndex(packages: readonly Package[]): Map<string, Package> {
  let index = OWNERSHIP_INDEXES.get(packages);
  if (!index) {
    index = new Map();
    for (const pkg of packages) {
      // Skip the workspace root. When a removed package and an active package
      // share a directory (in-place rename), the active package owns its files;
      // otherwise the first package wins for duplicate dirs.
      if (pkg.dir === "") continue;
      const existing = index.get(pkg.dir);
      if (existing && !(existing.removed && !pkg.removed)) continue;
      index.set(pkg.dir, pkg);
    }
    OWNERSHIP_INDEXES.set(packages, index);
  }
  return index;
}

export function owningPackage(
  filePath: string,
  packages: Package[],
): Package | undefined {
  const index = ownershipIndex(packages);
  if (index.size === 0) return undefined;
  let current = filePath;
  for (;;) {
    const pkg = index.get(current);
    if (pkg) return pkg;
    if (current === "" || current === "/" || current === ".") return undefined;
    const parent = path.posix.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function collectWarnings(
  list: { code: Warning["code"]; message: string; file?: string }[],
): Warning[] {
  return list.map((w) => ({ ...w }));
}
