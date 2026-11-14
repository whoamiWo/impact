import type { AnalysisResult } from "../types.js";

export function renderJson(result: AnalysisResult): string {
  return JSON.stringify(normalize(result), null, 2) + "\n";
}

function normalize(result: AnalysisResult): AnalysisResult {
  return {
    schemaVersion: 1,
    tool: result.tool,
    diff: result.diff,
    changedFiles: [...result.changedFiles].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    packages: [...result.packages].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    deployables: [...result.deployables].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    warnings: [...result.warnings].sort((a, b) => {
      const ak = `${a.code}|${a.file ?? ""}|${a.pkg ?? ""}|${a.message}`;
      const bk = `${b.code}|${b.file ?? ""}|${b.pkg ?? ""}|${b.message}`;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    }),
    stats: result.stats,
  };
}
