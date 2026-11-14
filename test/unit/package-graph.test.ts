import { describe, expect, it } from "vitest";
import { buildPackageGraph, mergeSourceEdges } from "../../src/graph/package-graph.js";
import { defaultConfig } from "../helpers/config.js";
import type { Package } from "../../src/types.js";

const pkg = (name: string, dir: string): Package => ({
  name,
  dir,
  manifestPath: `${dir}/package.json`,
  scripts: {},
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
  [
    "@repo/web",
    {
      dependencies: { "@repo/ui": "1" },
      devDependencies: { "@repo/core": "1" },
      peerDependencies: { "@repo/ui": "1" },
      optionalDependencies: {},
    },
  ],
]);

describe("buildPackageGraph", () => {
  it("builds manifest edges and reverse index", () => {
    const g = buildPackageGraph(packages, manifests, defaultConfig());
    expect(g.edges).toContainEqual({ from: "@repo/ui", to: "@repo/core", kind: "manifest" });
    expect(g.edges).toContainEqual({ from: "@repo/web", to: "@repo/ui", kind: "manifest" });
    expect(g.reverse.get("@repo/core")).toEqual(new Set(["@repo/ui", "@repo/web"]));
  });

  it("respects devDependencies switch", () => {
    const g = buildPackageGraph(
      packages,
      manifests,
      defaultConfig({ graph: { ...defaultConfig().graph, devDependencies: false } }),
    );
    expect(g.edges).not.toContainEqual({ from: "@repo/web", to: "@repo/core", kind: "manifest" });
  });

  it("respects peerDependencies switch", () => {
    const cfg = defaultConfig();
    const on = buildPackageGraph(packages, manifests, {
      ...cfg,
      graph: { ...cfg.graph, peerDependencies: true },
    });
    expect(on.edges).toContainEqual({ from: "@repo/web", to: "@repo/ui", kind: "manifest" });
  });

  it("merges source edges without duplicates", () => {
    const g = buildPackageGraph(packages, manifests, defaultConfig());
    const before = g.edges.length;
    mergeSourceEdges(g, [
      { from: "@repo/ui", to: "@repo/core", kind: "source" },
      { from: "@repo/web", to: "@repo/core", kind: "source" },
      { from: "@repo/core", to: "@repo/web", kind: "source" },
    ]);
    expect(g.edges.length).toBe(before + 1);
    expect(g.reverse.get("@repo/web")).toEqual(new Set(["@repo/core"]));
  });
});
