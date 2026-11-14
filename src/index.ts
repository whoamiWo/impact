/**
 * Public API surface for `impact`.
 *
 * Stable until 1.0 (additive changes only):
 *   - analyze() and AnalyzeContext
 *   - loadConfig()
 *   - output renderers: renderText, renderJson, renderGithub, renderDoctor
 *   - error classes and shared types (types.ts, schemaVersion 1)
 *
 * Everything under the "Experimental" marker below is an internal building block
 * exposed for tests and early adopters; names and signatures may change without
 * notice before 1.0.
 */

export { analyze, type AnalyzeContext } from "./pipeline.js";
export { loadConfig } from "./config.js";
export { ImpactError, UsageError, ConfigError } from "./errors.js";
export { renderText } from "./output/text.js";
export { renderJson } from "./output/json.js";
export { renderGithub } from "./output/github.js";
export { renderDoctor } from "./doctor.js";
export { TOOL_VERSION } from "./version.js";
export type * from "./types.js";

// Experimental (internal building blocks; not covered by the stability note above).

export { makeMatcher } from "./pipeline.js";
export { renderTestCommand, shellQuote } from "./tests/suggest.js";
export { computeImpacts } from "./impact/analyze.js";
export { buildPackageGraph } from "./graph/package-graph.js";
export { buildSourceGraph, extractImports } from "./graph/source-graph.js";
export {
  buildResolver,
  parseTsconfig,
  stripJsonComments,
  owningPackage,
} from "./graph/resolve.js";
export { computeDeployables } from "./deploy/units.js";
export {
  parseNameStatus,
  collectDiff,
  repoRoot,
  resolveBase,
} from "./git/diff.js";
export { assertSafeRef, splitNul, toPosix } from "./git/exec.js";
export {
  discoverWorkspaces,
  parsePackageJson,
  parsePnpmWorkspace,
} from "./workspace/npm.js";
export { detectPackageManager } from "./workspace/package-manager.js";
export { SourceGraphCache, PARSER_VERSION, hashKey, sha256 } from "./cache.js";
