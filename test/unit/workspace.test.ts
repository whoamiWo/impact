import { describe, expect, it } from "vitest";
import { defaultConfig } from "../helpers/config.js";
import { discoverWorkspaces, parsePnpmWorkspace } from "../../src/workspace/npm.js";
import { makeMatcher } from "../../src/pipeline.js";

function makeDeps(files: Record<string, string>) {
  return {
    readFile: async (relPath: string) => files[relPath] ?? null,
    listFiles: async () => Object.keys(files).sort(),
  };
}

const matchAll = makeMatcher();

describe("discoverWorkspaces duplicate package names", () => {
  it("throws a config error listing both directories", async () => {
    const deps = makeDeps({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "packages/one/package.json": JSON.stringify({ name: "@repo/core" }),
      "packages/two/package.json": JSON.stringify({ name: "@repo/core" }),
    });
    await expect(discoverWorkspaces("/", defaultConfig(), deps, matchAll)).rejects.toThrow(
      /Duplicate workspace package names: "@repo\/core" in packages\/one, packages\/two/,
    );
  });

  it("does not error for distinct package names", async () => {
    const deps = makeDeps({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "packages/one/package.json": JSON.stringify({ name: "@repo/one" }),
      "packages/two/package.json": JSON.stringify({ name: "@repo/two" }),
    });
    const result = await discoverWorkspaces("/", defaultConfig(), deps, matchAll);
    expect(result.packages).toHaveLength(2);
  });
});

describe("discoverWorkspaces glob semantics", () => {
  it("applies pnpm negation entries as exclusions", async () => {
    const cfg = defaultConfig({ workspaces: { include: [], exclude: [] } });
    const deps = makeDeps({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "!packages/legacy"\n  - "!**/test/**"\n',
      "packages/one/package.json": JSON.stringify({ name: "@repo/one" }),
      "packages/legacy/package.json": JSON.stringify({ name: "@repo/legacy" }),
      "packages/one/test/package.json": JSON.stringify({ name: "@repo/one-test" }),
    });
    const result = await discoverWorkspaces("/", cfg, deps, matchAll);
    expect(result.packages.map((p) => p.name)).toEqual(["@repo/one"]);
    expect(result.source).toBe("pnpm-workspace.yaml");
  });
});

describe("parsePnpmWorkspace", () => {
  it("parses quoted and commented entries", () => {
    const text = `packages:
  - "packages/*"
  - 'apps/*'
  # a comment
  - "!**/test/**"
`;
    expect(parsePnpmWorkspace(text)).toEqual(["packages/*", "apps/*", "!**/test/**"]);
  });

  it("parses multiline flow-style entries", () => {
    expect(parsePnpmWorkspace("packages: ['packages/*', 'apps/*']\n")).toEqual([
      "packages/*",
      "apps/*",
    ]);
  });

  it("returns an empty list for malformed or missing packages", () => {
    expect(parsePnpmWorkspace("packages: packages/*\n")).toEqual([]);
    expect(parsePnpmWorkspace("not: yaml at all : [\n")).toEqual([]);
    expect(parsePnpmWorkspace("")).toEqual([]);
  });
});
