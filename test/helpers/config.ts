import type { Config } from "../../src/types.js";

export function defaultConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    version: 1,
    workspaces: { include: ["packages/*", "apps/*"], exclude: [] },
    source: {
      enabled: true,
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
      tsconfig: ["tsconfig.base.json"],
      maxFileBytes: 1_048_576,
    },
    graph: {
      devDependencies: true,
      optionalDependencies: true,
      peerDependencies: false,
    },
    impact: {
      unowned: "global",
      lockfiles: "global",
      alwaysAffected: [],
      globalGlobs: [
        "package.json",
        "tsconfig.base.json",
        "pnpm-workspace.yaml",
        "impact.config.*",
      ],
      ignoreGlobs: ["**/*.md", "**/*.mdx", "docs/**", ".github/**"],
    },
    tests: {
      scripts: ["test"],
      commands: {},
      include: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"],
      maxFiles: 500,
    },
    deployables: [],
  };
  return {
    ...base,
    ...overrides,
    workspaces: { ...base.workspaces, ...(overrides.workspaces ?? {}) },
    source: { ...base.source, ...(overrides.source ?? {}) },
    graph: { ...base.graph, ...(overrides.graph ?? {}) },
    impact: { ...base.impact, ...(overrides.impact ?? {}) },
    tests: { ...base.tests, ...(overrides.tests ?? {}) },
    deployables: overrides.deployables ?? base.deployables,
  };
}
