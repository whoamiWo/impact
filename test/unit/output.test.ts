import { describe, expect, it } from "vitest";
import { renderGithub } from "../../src/output/github.js";
import { renderJson } from "../../src/output/json.js";
import { renderText } from "../../src/output/text.js";
import type { AnalysisResult } from "../../src/types.js";

const result: AnalysisResult = {
  schemaVersion: 1,
  tool: { name: "impact", version: "0.1.0" },
  diff: {
    base: "origin/main",
    baseSha: "aaaaaaaaaaaaaaaa",
    head: "HEAD",
    headSha: "bbbbbbbbbbbbbbbb",
    mergeBase: "aaaaaaaaaaaaaaaa",
    includesWorkingTree: true,
  },
  changedFiles: [
    { path: "packages/ui/src/button.tsx", status: "modified" },
    {
      path: "packages/ui/src/new.ts",
      status: "renamed",
      oldPath: "packages/ui/src/old.ts",
    },
  ],
  packages: [
    {
      name: "@repo/web",
      dir: "apps/web",
      impact: "dependent",
      confidence: "high",
      reasons: [
        { type: "dependency", via: "@repo/ui", chain: ["@repo/ui", "@repo/web"] },
      ],
      test: { scripts: ["test"], commands: ["pnpm --filter @repo/web run test"] },
      testFiles: [],
    },
    {
      name: "@repo/ui",
      dir: "packages/ui",
      impact: "direct",
      confidence: "high",
      reasons: [{ type: "direct", files: ["packages/ui/src/button.tsx"] }],
      test: { scripts: ["test"], commands: ["pnpm --filter @repo/ui run test"] },
      testFiles: ["packages/ui/src/button.test.ts"],
    },
    {
      name: "@repo/old",
      dir: "packages/old",
      impact: "direct",
      confidence: "high",
      reasons: [{ type: "direct", files: ["packages/old/package.json"] }],
      removed: true,
      test: { scripts: [], commands: [] },
      testFiles: [],
    },
  ],
  deployables: [
    {
      name: "web",
      packages: ["@repo/web"],
      affected: true,
      reasons: [{ type: "package", package: "@repo/web" }],
      buildCommand: "pnpm --filter @repo/web build",
      deployCommand: "kubectl apply -k deploy/web",
    },
  ],
  warnings: [
    { code: "NO_TEST_SCRIPT", message: "no test", pkg: "@repo/old" },
  ],
  stats: {
    changedFiles: 2,
    packagesTotal: 3,
    packagesAffected: 3,
    deployablesAffected: 1,
    sourceFilesParsed: 5,
  },
};

describe("renderJson", () => {
  it("is deterministic and sorts arrays by name/path", () => {
    const a = renderJson(result);
    const b = renderJson({ ...result, packages: [...result.packages].reverse() });
    expect(a).toBe(b);
    const parsed = JSON.parse(a);
    expect(parsed.packages.map((p: { name: string }) => p.name)).toEqual([
      "@repo/old",
      "@repo/ui",
      "@repo/web",
    ]);
    expect(parsed.changedFiles[0].path < parsed.changedFiles[1].path).toBe(true);
    expect(parsed.schemaVersion).toBe(1);
  });
});

describe("renderGithub", () => {
  it("emits executable test matrix entries and skips packages without scripts", () => {
    const matrix = JSON.parse(renderGithub(result, "test"));
    expect(matrix.include).toHaveLength(2);
    expect(matrix.include[0]).toEqual({
      package: "@repo/ui",
      dir: "packages/ui",
      script: "test",
      command: "pnpm --filter @repo/ui run test",
    });
  });

  it("emits deploy matrix", () => {
    const matrix = JSON.parse(renderGithub(result, "deploy"));
    expect(matrix.include).toEqual([
      {
        deployable: "web",
        buildCommand: "pnpm --filter @repo/web build",
        deployCommand: "kubectl apply -k deploy/web",
      },
    ]);
  });

  it("emits empty include for no results", () => {
    const empty = { ...result, packages: [], deployables: [] };
    expect(JSON.parse(renderGithub(empty, "test"))).toEqual({ include: [] });
    expect(JSON.parse(renderGithub(empty, "deploy"))).toEqual({ include: [] });
  });
});

describe("renderText", () => {
  it("prints reasons, test commands and warnings", () => {
    const text = renderText(result, { files: true });
    expect(text).toContain("@repo/web");
    expect(text).toContain("depends on @repo/ui");
    expect(text).toContain("pnpm --filter @repo/ui run test");
    expect(text).toContain("NO_TEST_SCRIPT");
    expect(text).toContain("Deployables:");
  });

  it("trims output with only", () => {
    const text = renderText(result, { files: false, only: "deployables" });
    expect(text).not.toContain("Affected packages:");
    expect(text).toContain("Deployables:");
  });
});
