import type {
  ChangedFile,
  Config,
  DeployableImpact,
  Package,
} from "../types.js";

export interface DeployableInput {
  cfg: Config;
  packages: Package[];
  changedFiles: ChangedFile[];
  affectedPackages: Set<string>;
  configPath: string | null;
  root: string;
  matchGlob: (globs: string[], value: string) => boolean;
}

export function computeDeployables(input: DeployableInput): DeployableImpact[] {
  const { cfg, packages, changedFiles, affectedPackages, configPath } = input;
  const units: DeployableImpact[] = [];

  const changedPaths = new Set<string>();
  for (const f of changedFiles) {
    changedPaths.add(f.path);
    if (f.oldPath) changedPaths.add(f.oldPath);
  }

  const removedNames = new Set(
    packages.filter((p) => p.removed).map((p) => p.name),
  );

  const configChanged =
    configPath !== null &&
    [...changedPaths].some((p) => p === configPath);

  const build = (name: string, pkgs: string[], paths: string[]) => {
    const reasons: DeployableImpact["reasons"] = [];
    for (const pkg of pkgs) {
      if (!affectedPackages.has(pkg)) continue;
      if (removedNames.has(pkg)) reasons.push({ type: "removedPackage", package: pkg });
      else reasons.push({ type: "package", package: pkg });
    }
    for (const file of [...changedPaths].sort()) {
      if (paths.length > 0 && input.matchGlob(paths, file)) {
        reasons.push({ type: "path", path: file });
      }
    }
    if (configChanged) {
      for (const file of [...changedPaths].sort()) {
        if (file === configPath && !reasons.some((r) => r.type === "path" && r.path === file)) {
          reasons.push({ type: "path", path: file });
        }
      }
    }
    return { reasons, affected: reasons.length > 0 };
  };

  if (cfg.deployables.length > 0) {
    for (const unit of cfg.deployables) {
      const mapped = packages.filter((pkg) => {
        if (!unit.packages || unit.packages.length === 0) return false;
        return unit.packages.some(
          (pattern) => pattern === pkg.name || input.matchGlob([pattern], pkg.name),
        );
      });
      const pkgs = mapped.map((p) => p.name).sort();
      // Removed packages are not part of the current mapping, but their
      // deletion can still affect a deployable that depended on them.
      const outputPackages = mapped.filter((p) => !p.removed).map((p) => p.name).sort();
      const paths = unit.paths ?? [];
      const { reasons, affected } = build(unit.name, pkgs, paths);
      units.push({
        name: unit.name,
        packages: outputPackages,
        affected,
        reasons,
        buildCommand: unit.buildCommand,
        deployCommand: unit.deployCommand,
      });
    }
    return units.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // Fallback: first-level packages under apps/*.
  const appPkgs = packages.filter((p) => {
    const parts = p.dir.split("/");
    return parts.length >= 2 && parts[0] === "apps";
  });
  const topLevel = new Map<string, Package>();
  for (const pkg of appPkgs) {
    const parts = pkg.dir.split("/");
    const key = parts.slice(0, 2).join("/");
    if (parts.length === 2 && !topLevel.has(key)) topLevel.set(key, pkg);
  }
  for (const pkg of [...topLevel.values()].sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const { reasons, affected } = build(pkg.name, [pkg.name], [`${pkg.dir}/**`]);
    units.push({
      name: pkg.name,
      packages: pkg.removed ? [] : [pkg.name],
      affected,
      reasons,
    });
  }
  return units;
}
