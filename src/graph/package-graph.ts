import type { Config, Package, PackageEdge, Warning } from "../types.js";

export interface PackageGraph {
  packages: Map<string, Package>;
  byDir: Map<string, Package>;
  edges: PackageEdge[];
  reverse: Map<string, Set<string>>;
  warnings: Warning[];
}

const DEP_FIELDS: { field: string; enabled: (cfg: Config) => boolean }[] = [
  { field: "dependencies", enabled: () => true },
  { field: "devDependencies", enabled: (cfg) => cfg.graph.devDependencies },
  { field: "optionalDependencies", enabled: (cfg) => cfg.graph.optionalDependencies },
  { field: "peerDependencies", enabled: (cfg) => cfg.graph.peerDependencies },
];

export function buildPackageGraph(
  packages: Package[],
  manifests: Map<string, Record<string, unknown>>,
  cfg: Config,
): PackageGraph {
  const map = new Map<string, Package>();
  const byDir = new Map<string, Package>();
  for (const pkg of packages) {
    map.set(pkg.name, pkg);
    byDir.set(pkg.dir, pkg);
  }
  const edges: PackageEdge[] = [];
  const warnings: Warning[] = [];

  for (const pkg of packages) {
    const manifest = manifests.get(pkg.name);
    if (!manifest) continue;
    for (const dep of DEP_FIELDS) {
      if (!dep.enabled(cfg)) continue;
      const deps = manifest[dep.field];
      if (!deps || typeof deps !== "object") continue;
      for (const name of Object.keys(deps as Record<string, unknown>)) {
        if (!map.has(name)) continue;
        edges.push({ from: pkg.name, to: name, kind: "manifest" });
      }
    }
  }

  const reverse = new Map<string, Set<string>>();
  for (const edge of edges) {
    let set = reverse.get(edge.to);
    if (!set) {
      set = new Set();
      reverse.set(edge.to, set);
    }
    set.add(edge.from);
  }

  return { packages: map, byDir, edges, reverse, warnings };
}

export function mergeSourceEdges(
  graph: PackageGraph,
  sourceEdges: PackageEdge[],
): void {
  const existing = new Set(
    graph.edges.map((e) => `${e.from} ->${e.to}`),
  );
  for (const edge of sourceEdges) {
    if (!graph.packages.has(edge.from) || !graph.packages.has(edge.to)) continue;
    const key = `${edge.from} ->${edge.to}`;
    if (!existing.has(key)) {
      graph.edges.push(edge);
      existing.add(key);
      let set = graph.reverse.get(edge.to);
      if (!set) {
        set = new Set();
        graph.reverse.set(edge.to, set);
      }
      set.add(edge.from);
    }
  }
}
