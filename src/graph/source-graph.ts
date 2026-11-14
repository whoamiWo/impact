import path from "node:path";
import type {
  Config,
  Package,
  PackageEdge,
  SourceGraph,
  Warning,
} from "../types.js";
import {
  buildResolver,
  owningPackage,
  parseTsconfig,
  type SourceResolver,
  type TsConfigEntry,
} from "./resolve.js";
import type { WarningCode } from "../types.js";

export interface SourceAnalyzerDeps {
  readFile(absPath: string): Promise<Buffer>;
  listFiles(): Promise<string[]>;
  readText(relPath: string): Promise<string | null>;
  entryHints?: Map<string, string[]>;
}

interface ImportRef {
  specifier: string;
  kind: "import" | "require" | "dynamic" | "reexport";
  dynamicNonLiteral?: boolean;
}

export async function buildSourceGraph(
  root: string,
  cfg: Config,
  packages: Package[],
  deps: SourceAnalyzerDeps,
  matchGlob: (globs: string[], value: string) => boolean,
): Promise<{ graph: SourceGraph; warnings: Warning[] }> {
  const warnings: Warning[] = [];
  const fileEdgesMap = new Map<string, Set<string>>();
  const packageEdges = new Map<string, PackageEdge>();
  let filesParsed = 0;

  if (!cfg.source.enabled) {
    return { graph: emptyGraph(), warnings };
  }

  const allFiles = await deps.listFiles();
  const extensions = new Set(cfg.source.extensions.map((e) => e.toLowerCase()));
  const candidates: { path: string; pkg: Package }[] = [];
  for (const f of allFiles) {
    const ext = path.posix.extname(f).toLowerCase();
    if (!extensions.has(ext)) continue;
    const pkg = owningPackage(f, packages);
    if (!pkg) continue;
    candidates.push({ path: f, pkg });
  }

  const knownFiles = new Set(allFiles);

  const tsconfigs: TsConfigEntry[] = [];
  for (const glob of cfg.source.tsconfig) {
    for (const f of allFiles) {
      if (matchGlob([glob], f)) {
        const text = await deps.readText(f);
        if (!text) continue;
        try {
          tsconfigs.push(parseTsconfig(text, f));
        } catch {
          warnings.push({
            code: "GENERIC" as WarningCode,
            message: `Failed to parse tsconfig: ${f}`,
            file: f,
          });
        }
      }
    }
  }

  const resolver = buildResolver(
    root,
    knownFiles,
    cfg.source.extensions,
    packages,
    tsconfigs,
    deps.entryHints,
  );

  let ts: typeof import("typescript");
  try {
    ts = await import("typescript");
  } catch (err) {
    warnings.push({
      code: "GENERIC" as WarningCode,
      message: `TypeScript parser unavailable: ${(err as Error).message}`,
    });
    return { graph: emptyGraph(), warnings };
  }

  const pkgByDir = new Map(packages.map((p) => [p.dir, p]));
  void pkgByDir;

  for (const { path: filePath, pkg } of candidates) {
    const abs = path.join(root, filePath);
    let buf: Buffer;
    try {
      buf = await deps.readFile(abs);
    } catch {
      continue;
    }
    if (buf.length > cfg.source.maxFileBytes) {
      warnings.push({
        code: "FILE_TOO_LARGE",
        message: `Skipped ${filePath}: ${buf.length} bytes > ${cfg.source.maxFileBytes}`,
        file: filePath,
      });
      continue;
    }
    filesParsed++;
    const sourceText = buf.toString("utf8");
    let refs: ImportRef[];
    try {
      refs = extractImports(ts, filePath, sourceText);
    } catch {
      warnings.push({
        code: "GENERIC" as WarningCode,
        message: `Failed to parse source file: ${filePath}`,
        file: filePath,
      });
      continue;
    }

    for (const ref of refs) {
      if (ref.dynamicNonLiteral) {
        warnings.push({
          code: "DYNAMIC_IMPORT",
          message: `Dynamic import with non-literal specifier in ${filePath}: kept existing edges only`,
          file: filePath,
        });
        continue;
      }
      if (ref.kind === "dynamic" || ref.kind === "require" || ref.kind === "import" || ref.kind === "reexport") {
        // Resolve.
      }
      const resolution = resolver.resolveFile(filePath, ref.specifier);
      if (resolution.path) {
        let toSet = fileEdgesMap.get(filePath);
        if (!toSet) {
          toSet = new Set();
          fileEdgesMap.set(filePath, toSet);
        }
        toSet.add(resolution.path);
        const toPkg = owningPackage(resolution.path, packages);
        if (toPkg && toPkg.name !== pkg.name) {
          const key = `${pkg.name} ->${toPkg.name}`;
          if (!packageEdges.has(key)) {
            packageEdges.set(key, {
              from: pkg.name,
              to: toPkg.name,
              kind: "source",
            });
          }
        }
        continue;
      }
      if (resolution.external) {
        const pkgName = resolver.resolvePackage(resolution.external);
        if (pkgName && pkgName !== pkg.name) {
          const key = `${pkg.name} ->${pkgName}`;
          if (!packageEdges.has(key)) {
            packageEdges.set(key, {
              from: pkg.name,
              to: pkgName,
              kind: "source",
            });
          }
        } else if (pkgName === undefined) {
          // External dependency or unresolved package; manifest edges cover declared ones.
        }
        continue;
      }
      warnings.push({
        code: "UNRESOLVED_IMPORT",
        message: `Cannot resolve import "${ref.specifier}"`,
        file: filePath,
      });
    }
  }

  const fileEdges = [...fileEdgesMap.entries()].flatMap(([from, tos]) =>
    [...tos].map((to) => ({ from, to })),
  );
  fileEdges.sort((a, b) =>
    a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1,
  );
  const pkgEdges = [...packageEdges.values()].sort((a, b) =>
    a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1,
  );

  return {
    graph: {
      fileEdges,
      packageEdges: pkgEdges,
      filesParsed,
    },
    warnings,
  };
}

function emptyGraph(): SourceGraph {
  return { fileEdges: [], packageEdges: [], filesParsed: 0 };
}

export function extractImports(
  ts: typeof import("typescript"),
  fileName: string,
  text: string,
): ImportRef[] {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(ts, fileName),
  );
  const out: ImportRef[] = [];
  const visit = (node: import("typescript").Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = literal(node.moduleSpecifier);
      if (spec) out.push({ specifier: spec, kind: "import" });
    } else if (ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier && literal(node.moduleSpecifier);
      if (spec) out.push({ specifier: spec, kind: "reexport" });
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg) {
          const spec = literal(arg);
          if (spec) out.push({ specifier: spec, kind: "dynamic" });
          else out.push({ specifier: "", kind: "dynamic", dynamicNonLiteral: true });
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        const arg = node.arguments[0];
        if (arg) {
          const spec = literal(arg);
          if (spec) out.push({ specifier: spec, kind: "require" });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;

  function literal(node: import("typescript").Node): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    return null;
  }
}

function scriptKind(
  ts: typeof import("typescript"),
  fileName: string,
): import("typescript").ScriptKind {
  const ext = fileName.toLowerCase().split(".").pop();
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return ts.ScriptKind.TS;
    case "tsx":
      return ts.ScriptKind.TSX;
    case "jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}
