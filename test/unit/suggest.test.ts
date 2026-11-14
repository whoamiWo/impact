import { describe, expect, it } from "vitest";
import {
  findTestFiles,
  planTests,
  renderTestCommand,
  shellQuote,
} from "../../src/tests/suggest.js";
import { makeMatcher } from "../../src/pipeline.js";
import { defaultConfig } from "../helpers/config.js";
import type { Package, PackageManager, Warning } from "../../src/types.js";

const pkg = (overrides: Partial<Package> = {}): Package => ({
  name: "@repo/ui",
  dir: "packages/ui",
  manifestPath: "packages/ui/package.json",
  scripts: { test: "vitest run" },
  private: true,
  ...overrides,
});

describe("shellQuote", () => {
  it("leaves safe tokens untouched", () => {
    expect(shellQuote("@repo/ui")).toBe("@repo/ui");
    expect(shellQuote("test")).toBe("test");
  });

  it("quotes unsafe tokens", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("renderTestCommand", () => {
  const cases: [PackageManager, string][] = [
    ["pnpm", "pnpm --filter @repo/ui run test"],
    ["npm", "npm run test --workspace @repo/ui"],
    ["yarn", "yarn workspace @repo/ui run test"],
    ["bun", "bun run --filter @repo/ui test"],
  ];
  for (const [manager, expected] of cases) {
    it(`renders ${manager} command`, () => {
      expect(renderTestCommand(manager, "@repo/ui", "test")).toBe(expected);
    });
  }
});

describe("planTests", () => {
  it("uses package scripts and configured test scripts", () => {
    const warnings: Warning[] = [];
    const plan = planTests(
      pkg({ scripts: { test: "x", lint: "y" } }),
      defaultConfig(),
      "pnpm",
      { find: () => undefined },
      warnings,
    );
    expect(plan).toEqual({
      scripts: ["test"],
      commands: ["pnpm --filter @repo/ui run test"],
    });
    expect(warnings).toHaveLength(0);
  });

  it("warns and omits packages without a test script", () => {
    const warnings: Warning[] = [];
    const plan = planTests(
      pkg({ scripts: { build: "x" } }),
      defaultConfig(),
      "npm",
      { find: () => undefined },
      warnings,
    );
    expect(plan.commands).toEqual([]);
    expect(warnings[0].code).toBe("NO_TEST_SCRIPT");
  });

  it("supports command overrides by glob", () => {
    const plan = planTests(
      pkg({ scripts: {} }),
      defaultConfig({ tests: { ...defaultConfig().tests, commands: { "@repo/*": "make test" } } }),
      "npm",
      { find: (name) => (name.startsWith("@repo/") ? "make test" : undefined) },
      [],
    );
    expect(plan.commands).toEqual(["make test"]);
  });

  it("keeps overridden scripts and commands index-aligned", () => {
    const withScript = planTests(
      pkg({ scripts: { test: "vitest run", "test:e2e": "playwright" } }),
      defaultConfig({
        tests: {
          ...defaultConfig().tests,
          commands: { "@repo/ui": "make test" },
        },
      }),
      "pnpm",
      { find: () => "make test" },
      [],
    );
    expect(withScript.scripts).toHaveLength(withScript.commands.length);
    expect(withScript.scripts).toEqual(["test"]);
    expect(withScript.commands).toEqual(["make test"]);

    const noScript = planTests(
      pkg({ scripts: {} }),
      defaultConfig({
        tests: {
          ...defaultConfig().tests,
          commands: { "@repo/ui": ["make unit", "make e2e"] },
        },
      }),
      "pnpm",
      { find: () => ["make unit", "make e2e"] },
      [],
    );
    expect(noScript.scripts).toHaveLength(noScript.commands.length);
    expect(noScript.scripts).toEqual(["make unit", "make e2e"]);
    expect(noScript.commands).toEqual(["make unit", "make e2e"]);
  });
});

describe("findTestFiles", () => {
  const packages: Package[] = [
    pkg(),
    pkg({ name: "@repo/web", dir: "apps/web" }),
  ];
  const knownFiles = new Set([
    "packages/ui/src/button.ts",
    "packages/ui/src/button.test.ts",
    "packages/ui/src/index.ts",
    "packages/ui/src/index.test.ts",
    "packages/ui/src/__tests__/helper.spec.ts",
    "apps/web/src/index.ts",
    "apps/web/src/index.test.ts",
  ]);

  it("finds same-name tests and reverse-import tests", () => {
    const warnings: Warning[] = [];
    const result = findTestFiles({
      changedFiles: [{ path: "packages/ui/src/button.ts" }],
      fileEdges: [
        { from: "packages/ui/src/index.test.ts", to: "packages/ui/src/index.ts" },
      ],
      packages,
      affectedPackages: new Set(["@repo/ui"]),
      cfg: defaultConfig(),
      matchGlob: makeMatcher(),
      knownFiles,
      warnings,
    });
    expect(result.get("@repo/ui")).toEqual(["packages/ui/src/button.test.ts"]);
    expect(warnings).toHaveLength(0);
  });

  it("ignores candidate files that do not exist", () => {
    const result = findTestFiles({
      changedFiles: [{ path: "apps/web/src/index.ts" }],
      fileEdges: [],
      packages,
      affectedPackages: new Set(["@repo/web"]),
      cfg: defaultConfig(),
      matchGlob: makeMatcher(),
      knownFiles,
      warnings: [],
    });
    expect(result.get("@repo/web")).toEqual(["apps/web/src/index.test.ts"]);
  });

  it("only reports tests inside affected packages", () => {
    const result = findTestFiles({
      changedFiles: [{ path: "packages/ui/src/button.ts" }],
      fileEdges: [],
      packages,
      affectedPackages: new Set(["@repo/web"]),
      cfg: defaultConfig(),
      matchGlob: makeMatcher(),
      knownFiles,
      warnings: [],
    });
    expect(result.has("@repo/ui")).toBe(false);
  });

  it("caps suggestions and warns when over the limit", () => {
    const warnings: Warning[] = [];
    const result = findTestFiles({
      changedFiles: [{ path: "packages/ui/src/button.ts" }],
      fileEdges: [],
      packages,
      affectedPackages: new Set(["@repo/ui"]),
      cfg: defaultConfig({ tests: { ...defaultConfig().tests, maxFiles: 1 } }),
      matchGlob: makeMatcher(),
      knownFiles,
      warnings,
    });
    expect(result.get("@repo/ui")).toHaveLength(1);
    expect(warnings.some((w) => w.code === "TEST_FILE_LIMIT")).toBe(false);
  });
});
