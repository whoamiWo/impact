import type { AnalysisResult } from "../types.js";

export type GithubTarget = "test" | "deploy";

export function renderGithub(
  result: AnalysisResult,
  target: GithubTarget,
): string {
  if (target === "deploy") {
    const include = [...result.deployables]
      .filter((d) => d.affected)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((d) => ({
        deployable: d.name,
        ...(d.buildCommand ? { buildCommand: d.buildCommand } : {}),
        ...(d.deployCommand ? { deployCommand: d.deployCommand } : {}),
      }));
    return JSON.stringify({ include }, null, 2) + "\n";
  }

  const include: {
    package: string;
    dir: string;
    script: string;
    command: string;
  }[] = [];
  for (const pkg of [...result.packages].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (pkg.removed) continue;
    // commands are the source of truth; scripts[i] is the (possibly
    // fallback) label for commands[i] and never shorter than commands.
    pkg.test.commands.forEach((command, index) => {
      include.push({
        package: pkg.name,
        dir: pkg.dir,
        script: pkg.test.scripts[index] ?? command,
        command,
      });
    });
  }
  return JSON.stringify({ include }, null, 2) + "\n";
}
