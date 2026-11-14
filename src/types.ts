// Core shared types for impact analysis.

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type ImpactKind = "direct" | "dependent" | "global";

export type Confidence = "high" | "medium";

export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "unknown";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
}

export interface RepoFile {
  path: string;
  absPath: string;
  pkg?: string;
}

export interface Package {
  name: string;
  dir: string;
  manifestPath: string;
  scripts: Record<string, string>;
  private: boolean;
  removed?: boolean;
}

export interface PackageEdge {
  from: string;
  to: string;
  kind: "manifest" | "source";
}

export interface FileEdge {
  from: string;
  to: string;
}

export interface SourceGraph {
  fileEdges: FileEdge[];
  packageEdges: PackageEdge[];
  filesParsed: number;
}

export interface DeployableConfig {
  name: string;
  packages?: string[];
  paths?: string[];
  buildCommand?: string;
  deployCommand?: string;
}

export interface Config {
  version: number;
  workspaces: {
    include?: string[];
    exclude: string[];
  };
  source: {
    enabled: boolean;
    extensions: string[];
    tsconfig: string[];
    maxFileBytes: number;
  };
  graph: {
    devDependencies: boolean;
    optionalDependencies: boolean;
    peerDependencies: boolean;
  };
  impact: {
    unowned: "global" | "warn" | "ignore";
    lockfiles: "global" | "ignore";
    alwaysAffected: string[];
    globalGlobs: string[];
    ignoreGlobs: string[];
  };
  tests: {
    scripts: string[];
    commands: Record<string, string | string[]>;
    include: string[];
    maxFiles: number;
  };
  deployables: DeployableConfig[];
}

export type WarningCode =
  | "UNRESOLVED_IMPORT"
  | "PHANTOM_DEPENDENCY"
  | "DYNAMIC_IMPORT"
  | "NO_TEST_SCRIPT"
  | "UNOWNED_CHANGE"
  | "FILE_TOO_LARGE"
  | "SHALLOW_CLONE"
  | "DELETED_PACKAGE"
  | "NO_WORKSPACE_CONFIG"
  | "NO_PACKAGE_MANAGER"
  | "WORKING_TREE_MISMATCH"
  | "TEST_FILE_LIMIT"
  | "GENERIC";

export interface Warning {
  code: WarningCode;
  message: string;
  file?: string;
  pkg?: string;
}

export interface ReasonDependency {
  type: "dependency";
  via: string;
  chain: string[];
}

export interface ReasonDirect {
  type: "direct";
  files: string[];
}

export interface ReasonGlobal {
  type: "global";
  files: string[];
}

export interface ReasonAlwaysAffected {
  type: "alwaysAffected";
}

export type Reason =
  | ReasonDependency
  | ReasonDirect
  | ReasonGlobal
  | ReasonAlwaysAffected;

export interface PackageImpact {
  name: string;
  dir: string;
  impact: ImpactKind;
  confidence: Confidence;
  reasons: Reason[];
  removed?: boolean;
  test: {
    scripts: string[];
    commands: string[];
  };
  testFiles: string[];
}

export interface DeployableReasonPackage {
  type: "package";
  package: string;
}

export interface DeployableReasonPath {
  type: "path";
  path: string;
}

export interface DeployableReasonRemovedPackage {
  type: "removedPackage";
  package: string;
}

export type DeployableReason =
  | DeployableReasonPackage
  | DeployableReasonRemovedPackage
  | DeployableReasonPath;

export interface DeployableImpact {
  name: string;
  packages: string[];
  affected: boolean;
  reasons: DeployableReason[];
  buildCommand?: string;
  deployCommand?: string;
}

export interface DiffInfo {
  base: string;
  baseSha: string;
  head: string;
  headSha: string;
  mergeBase: string;
  includesWorkingTree: boolean;
  /**
   * True only when merge-base resolution failed and the caller explicitly
   * allowed falling back to the base ref (--allow-shallow-fallback).
   */
  mergeBaseFallback?: boolean;
}

export interface CacheStats {
  hit: boolean;
  filesHashed: number;
  filesReused: number;
}

export interface Stats {
  changedFiles: number;
  packagesTotal: number;
  packagesAffected: number;
  deployablesAffected: number;
  sourceFilesParsed: number;
  /**
   * Source graph cache counters. Present only with --verbose so default JSON
   * output stays byte-identical between --no-cache and cache-hit runs.
   */
  cache?: CacheStats;
}

export interface AnalysisResult {
  schemaVersion: 1;
  tool: { name: string; version: string };
  diff: DiffInfo;
  changedFiles: ChangedFile[];
  packages: PackageImpact[];
  deployables: DeployableImpact[];
  warnings: Warning[];
  stats: Stats;
}

export interface AnalyzeOptions {
  root: string;
  base?: string;
  head: string;
  working: boolean;
  depth: "direct" | "transitive";
  files: boolean;
  configPath?: string;
  cache: boolean;
  verbose: boolean;
  allowShallowFallback?: boolean;
}
