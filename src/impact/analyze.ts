import path from "node:path";
import type {
  ChangedFile,
  Confidence,
  Config,
  ImpactKind,
  Package,
  Reason,
  Warning,
} from "../types.js";
import type { PackageGraph } from "../graph/package-graph.js";
import { owningPackage } from "../graph/resolve.js";
import { LOCKFILE_NAMES } from "../workspace/package-manager.js";

export interface ImpactComputationInput {
  changedFiles: ChangedFile[];
  packages: Package[];
  graph: PackageGraph;
  cfg: Config;
  depth: "direct" | "transitive";
  matchGlob: (globs: string[], value: string) => boolean;
  hasUnresolvedImports: boolean;
}

export interface PackageImpactInfo {
  name: string;
  impact: ImpactKind;
  confidence: Confidence;
  reasons: Reason[];
}

export interface ImpactComputation {
  impacts: Map<string, PackageImpactInfo>;
  globalFiles: string[];
  unownedFiles: string[];
  ignoredFiles: string[];
  warnings: Warning[];
}

const LOCKFILE_SET = new Set(LOCKFILE_NAMES);

export function computeImpacts(input: ImpactComputationInput): ImpactComputation {
  const { changedFiles, packages, graph, cfg, depth, matchGlob } = input;
  const warnings: Warning[] = [];
  const globalFiles: string[] = [];
  const unownedFiles: string[] = [];
  const ignoredFiles: string[] = [];
  const seedFiles = new Map<string, string[]>();

  const isLockfile = (p: string) =>
    LOCKFILE_SET.has(p) || LOCKFILE_SET.has(path.posix.basename(p));

  for (const file of changedFiles) {
    const candidates = [file.path, ...(file.oldPath ? [file.oldPath] : [])];
    const relevant = candidates.filter((p) => !matchGlob(cfg.impact.ignoreGlobs, p));
    if (relevant.length === 0) {
      ignoredFiles.push(file.path);
      continue;
    }

    let hitGlobal = false;
    let lockfileIgnored = false;
    for (const p of relevant) {
      if (isLockfile(p)) {
        if (cfg.impact.lockfiles === "ignore") lockfileIgnored = true;
        else hitGlobal = true;
        continue;
      }
      if (matchGlob(cfg.impact.globalGlobs, p)) {
        hitGlobal = true;
        continue;
      }
    }
    if (hitGlobal) {
      globalFiles.push(file.path);
      continue;
    }
    if (lockfileIgnored) {
      ignoredFiles.push(file.path);
      continue;
    }

    const owners = new Set<Package>();
    for (const p of relevant) {
      const owner = owningPackage(p, packages);
      if (owner) owners.add(owner);
    }
    if (owners.size === 0) {
      unownedFiles.push(file.path);
      if (cfg.impact.unowned === "global") {
        globalFiles.push(file.path);
        warnings.push({
          code: "UNOWNED_CHANGE",
          message: `Changed file does not belong to any workspace package: ${file.path}`,
          file: file.path,
        });
      } else if (cfg.impact.unowned === "warn") {
        warnings.push({
          code: "UNOWNED_CHANGE",
          message: `Changed file does not belong to any workspace package: ${file.path}`,
          file: file.path,
        });
      }
      continue;
    }
    for (const owner of owners) {
      const list = seedFiles.get(owner.name) ?? [];
      for (const p of relevant) list.push(p);
      seedFiles.set(owner.name, list);
    }
  }

  const impacts = new Map<string, PackageImpactInfo>();
  const chains = new Map<string, string[]>();

  const setImpact = (
    name: string,
    kind: ImpactKind,
    confidence: Confidence,
    reason: Reason,
  ) => {
    const existing = impacts.get(name);
    if (!existing) {
      impacts.set(name, { name, impact: kind, confidence, reasons: [reason] });
      return;
    }
    const rank: Record<ImpactKind, number> = { direct: 3, global: 2, dependent: 1 };
    if (rank[kind] > rank[existing.impact]) existing.impact = kind;
    if (existing.confidence === "medium" && confidence === "high") {
      existing.confidence = "high";
    }
    if (!reasonExists(existing.reasons, reason)) existing.reasons.push(reason);
  };

  for (const name of cfg.impact.alwaysAffected) {
    if (!graph.packages.has(name)) {
      warnings.push({
        code: "GENERIC",
        message: `alwaysAffected package not found in workspace: ${name}`,
        pkg: name,
      });
      continue;
    }
    setImpact(name, "dependent", "high", { type: "alwaysAffected" });
    if (!chains.has(name)) chains.set(name, [name]);
  }

  const hasGlobal = globalFiles.length > 0;
  if (hasGlobal) {
    for (const pkg of graph.packages.values()) {
      setImpact(pkg.name, "global", "medium", {
        type: "global",
        files: [...globalFiles].sort(),
      });
    }
  }

  const queue: { name: string }[] = [];
  for (const [name, files] of seedFiles) {
    setImpact(name, "direct", "high", {
      type: "direct",
      files: [...new Set(files)].sort(),
    });
    chains.set(name, [name]);
    queue.push({ name });
  }

  const maxDepth = depth === "direct" ? 1 : Number.POSITIVE_INFINITY;
  const expanded = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    expanded.add(current.name);
    const chain = chains.get(current.name) ?? [current.name];
    if (chain.length - 1 >= maxDepth) continue;
    const dependents = graph.reverse.get(current.name);
    if (!dependents) continue;
    for (const depName of dependents) {
      const nextChain = [...chain, depName];
      const existingChain = chains.get(depName);
      // Only the shortest chain is kept, so `reasons[].chain` is always a
      // shortest path. A node reached later by a shorter path is re-queued
      // so its own dependents also see the improved chain.
      if (existingChain && nextChain.length >= existingChain.length) continue;
      chains.set(depName, nextChain);
      setImpact(depName, "dependent", "high", {
        type: "dependency",
        via: current.name,
        chain: nextChain,
      });
      if (!existingChain || expanded.has(depName)) {
        queue.push({ name: depName });
      }
    }
  }

  if (input.hasUnresolvedImports) {
    for (const info of impacts.values()) {
      if (info.impact === "dependent") info.confidence = "medium";
    }
  }

  return { impacts, globalFiles, unownedFiles, ignoredFiles, warnings };
}

function reasonExists(list: Reason[], next: Reason): boolean {
  return list.some((r) => {
    if (r.type !== next.type) return false;
    switch (next.type) {
      case "dependency":
        return (
          r.type === "dependency" &&
          r.via === next.via &&
          r.chain.join(" ->") === next.chain.join(" ->")
        );
      case "direct":
      case "global":
        return false;
      case "alwaysAffected":
        return true;
    }
  });
}
