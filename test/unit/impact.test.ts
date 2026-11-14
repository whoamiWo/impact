import { describe, expect, it } from "vitest";
import { computeImpacts } from "../../src/impact/analyze.js";
import { buildPackageGraph, mergeSourceEdges } from "../../src/graph/package-graph.js";
import { makeMatcher } from "../../src/pipeline.js";
import { defaultConfig } from "../helpers/config.js";
import type { ChangedFile, Package } from "../../src/types.js";

const pkg = (name: string, dir: string): Package => ({
  name,
  dir,
  manifestPath: `${dir}/package.json`,
  scripts: { test: "vitest" },
  private: true,
});

const packages = [
  pkg("@repo/core", "packages/core"),
  pkg("@repo/ui", "packages/ui"),
  pkg("@repo/web", "apps/web"),
];

const manifests = new Map<string, Record<string, unknown>>([
  ["@repo/core", {}],
  ["@repo/ui", { dependencies: { "@repo/core": "1" } }],
  ["@repo/web", { dependencies: { "@repo/ui": "1" } }],
]);

function run(
  changedFiles: ChangedFile[],
  overrides: Parameters<typeof defaultConfig>[0] = {},
  depth: "direct" | "transitive" = "transitive",
) {
  const cfg = defaultConfig(overrides);
  const graph = buildPackageGraph(packages, manifests, cfg);
  return computeImpacts({
    changedFiles,
    packages,
    graph,
    cfg,
    depth,
    matchGlob: makeMatcher(),
    hasUnresolvedImports: false,
  });
}

describe("computeImpacts", () => {
  it("seeds direct package and propagates to dependents with chains", () => {
    const out = run([{ path: "packages/core/src/index.ts", status: "modified" }]);
    expect(out.impacts.get("@repo/core")?.impact).toBe("direct");
    expect(out.impacts.get("@repo/ui")?.impact).toBe("dependent");
    expect(out.impacts.get("@repo/web")?.impact).toBe("dependent");
    const webReason = out.impacts.get("@repo/web")?.reasons.find((r) => r.type === "dependency");
    expect(webReason).toBeTruthy();
    if (webReason && webReason.type === "dependency") {
      expect(webReason.chain[0]).toBe("@repo/core");
      expect(webReason.chain[webReason.chain.length - 1]).toBe("@repo/web");
    }
  });

  it("--depth direct stops at immediate dependents", () => {
    const out = run(
      [{ path: "packages/core/src/index.ts", status: "modified" }],
      {},
      "direct",
    );
    expect(out.impacts.has("@repo/ui")).toBe(true);
    expect(out.impacts.has("@repo/web")).toBe(false);
  });

  it("ignores docs by default", () => {
    const out = run([{ path: "docs/guide.md", status: "modified" }]);
    expect(out.impacts.size).toBe(0);
    expect(out.ignoredFiles).toContain("docs/guide.md");
  });

  it("treats lockfile changes as global by default", () => {
    const out = run([{ path: "pnpm-lock.yaml", status: "modified" }]);
    expect(out.impacts.size).toBe(3);
    for (const info of out.impacts.values()) {
      expect(info.impact).toBe("global");
      expect(info.confidence).toBe("medium");
    }
  });

  it("allows lockfiles to be ignored", () => {
    const out = run(
      [{ path: "pnpm-lock.yaml", status: "modified" }],
      { impact: { ...defaultConfig().impact, lockfiles: "ignore" } },
    );
    expect(out.impacts.size).toBe(0);
  });

  it("treats root global globs as global and warns on unowned files", () => {
    const out = run([{ path: "tsconfig.base.json", status: "modified" }]);
    expect(out.impacts.get("@repo/core")?.impact).toBe("global");

    const shared = run([{ path: "scripts/release.sh", status: "modified" }]);
    expect(shared.impacts.size).toBe(3);
    expect(shared.warnings.some((w) => w.code === "UNOWNED_CHANGE")).toBe(true);
  });

  it("unowned=warn keeps impacts local and still warns", () => {
    const out = run([{ path: "scripts/release.sh", status: "modified" }], {
      impact: { ...defaultConfig().impact, unowned: "warn" },
    });
    expect(out.impacts.size).toBe(0);
    expect(out.warnings.some((w) => w.code === "UNOWNED_CHANGE")).toBe(true);
  });

  it("adds alwaysAffected packages", () => {
    const out = run([{ path: "packages/core/src/index.ts", status: "modified" }], {
      impact: {
        ...defaultConfig().impact,
        alwaysAffected: ["@repo/web"],
      },
    });
    const web = out.impacts.get("@repo/web");
    expect(web?.reasons.some((r) => r.type === "alwaysAffected")).toBe(true);
  });

  it("keeps only the shortest dependency chain for a package", () => {
    const pkgs = [
      pkg("@repo/core", "packages/core"),
      pkg("@repo/ui", "packages/ui"),
      pkg("@repo/web", "apps/web"),
    ];
    const mans = new Map<string, Record<string, unknown>>([
      ["@repo/core", {}],
      ["@repo/ui", { dependencies: { "@repo/core": "1" } }],
      ["@repo/web", { dependencies: { "@repo/ui": "1", "@repo/core": "1" } }],
    ]);
    const cfg = defaultConfig();
    const graph = buildPackageGraph(pkgs, mans, cfg);
    const out = computeImpacts({
      changedFiles: [{ path: "packages/core/src/index.ts", status: "modified" }],
      packages: pkgs,
      graph,
      cfg,
      depth: "transitive",
      matchGlob: makeMatcher(),
      hasUnresolvedImports: false,
    });
    const web = out.impacts.get("@repo/web")!;
    const chains = web.reasons
      .filter((r) => r.type === "dependency")
      .map((r) => (r.type === "dependency" ? r.chain : []));
    expect(chains).toEqual([["@repo/core", "@repo/web"]]);
  });

  it("uses oldPath for renamed and deleted files", () => {
    const out = run([
      { path: "packages/core/src/index.ts", oldPath: "packages/core/src/old.ts", status: "renamed" },
    ]);
    expect(out.impacts.get("@repo/core")?.reasons).toContainEqual({
      type: "direct",
      files: ["packages/core/src/index.ts", "packages/core/src/old.ts"],
    });
  });

  it("propagates through source-only edges", () => {
    const cfg = defaultConfig();
    const graph = buildPackageGraph(packages, manifests, cfg);
    mergeSourceEdges(graph, [{ from: "@repo/web", to: "@repo/core", kind: "source" }]);
    const out = computeImpacts({
      changedFiles: [{ path: "packages/core/src/index.ts", status: "modified" }],
      packages,
      graph,
      cfg,
      depth: "direct",
      matchGlob: makeMatcher(),
      hasUnresolvedImports: false,
    });
    expect(out.impacts.has("@repo/web")).toBe(true);
  });

  it("is cycle-safe and deterministic", () => {
    const cfg = defaultConfig();
    const cyclicManifests = new Map(manifests);
    cyclicManifests.set("@repo/core", { dependencies: { "@repo/web": "1" } });
    const graph = buildPackageGraph(packages, cyclicManifests, cfg);
    const out = computeImpacts({
      changedFiles: [{ path: "packages/core/src/index.ts", status: "modified" }],
      packages,
      graph,
      cfg,
      depth: "transitive",
      matchGlob: makeMatcher(),
      hasUnresolvedImports: false,
    });
    expect(out.impacts.size).toBe(3);
  });
});
