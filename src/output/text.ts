import type { AnalysisResult, PackageImpact } from "../types.js";

export interface TextOptions {
  files: boolean;
  only?: "packages" | "tests" | "deployables";
}

export function renderText(result: AnalysisResult, opts: TextOptions): string {
  const lines: string[] = [];
  const { diff } = result;
  lines.push(
    `impact: ${diff.base} (${short(diff.baseSha)}) .. ${diff.head} (${short(diff.headSha)})` +
      (diff.includesWorkingTree ? " + working tree" : ""),
  );
  lines.push(
    `changed files: ${result.stats.changedFiles}  affected packages: ${result.stats.packagesAffected}/${result.stats.packagesTotal}  deployables: ${result.stats.deployablesAffected}`,
  );
  lines.push("");

  const showPackages = !opts.only || opts.only === "packages" || opts.only === "tests";

  if (showPackages) {
    if (result.packages.length === 0) {
      lines.push("Affected packages: none");
    } else {
      lines.push("Affected packages:");
      for (const pkg of result.packages) {
        lines.push(
          `  ${pkg.name} [${pkg.impact}, ${pkg.confidence}]${pkg.removed ? " (removed)" : ""}`,
        );
        for (const reason of pkg.reasons) {
          lines.push(`    - ${describeReason(reason)}`);
        }
        if (!opts.only || opts.only === "tests") {
          for (const cmd of pkg.test.commands) lines.push(`    test: ${cmd}`);
          if (opts.files && pkg.testFiles.length > 0) {
            lines.push(`    test files (${pkg.testFiles.length}):`);
            for (const file of pkg.testFiles) lines.push(`      ${file}`);
          }
        }
      }
    }
  }

  if (!opts.only || opts.only === "deployables") {
    if (result.deployables.length > 0) {
      lines.push("");
      lines.push("Deployables:");
      for (const d of result.deployables) {
        const status = d.affected ? "affected" : "not affected";
        lines.push(`  ${d.name} (${status})`);
        for (const r of d.reasons) {
          if (r.type === "package") lines.push(`    - package ${r.package}`);
          else if (r.type === "removedPackage") lines.push(`    - removed package ${r.package}`);
          else lines.push(`    - path ${r.path}`);
        }
        if (d.buildCommand) lines.push(`    build: ${d.buildCommand}`);
        if (d.deployCommand) lines.push(`    deploy: ${d.deployCommand}`);
      }
    }
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(`Warnings (${result.warnings.length}):`);
    for (const w of result.warnings) {
      const where = w.file ? ` [${w.file}]` : w.pkg ? ` [${w.pkg}]` : "";
      lines.push(`  ${w.code}${where}: ${w.message}`);
    }
  }
  return lines.join("\n") + "\n";
}

function describeReason(pkg: PackageImpact["reasons"][number]): string {
  switch (pkg.type) {
    case "direct":
      return `changed: ${pkg.files.join(", ")}`;
    case "dependency":
      return `depends on ${pkg.via} via ${pkg.chain.join(" -> ")}`;
    case "global":
      return `global change: ${pkg.files.join(", ")}`;
    case "alwaysAffected":
      return "alwaysAffected (configured)";
  }
}

function short(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha;
}
