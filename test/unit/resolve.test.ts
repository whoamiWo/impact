import { describe, expect, it } from "vitest";
import {
  buildResolver,
  normalizePath,
  owningPackage,
  parseTsconfig,
  stripJsonComments,
} from "../../src/graph/resolve.js";
import type { Package } from "../../src/types.js";

const pkg = (name: string, dir: string): Package => ({
  name,
  dir,
  manifestPath: `${dir}/package.json`,
  scripts: {},
  private: true,
});

describe("stripJsonComments", () => {
  it("removes line and block comments and trailing commas", () => {
    const input = `{
      // line comment
      "a": 1, /* block */
      "b": [1, 2,],
    }`;
    expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1, b: [1, 2] });
  });

  it("keeps // inside strings", () => {
    const input = `{ "url": "https://example.com", "n": 1 }`;
    expect(JSON.parse(stripJsonComments(input))).toEqual({
      url: "https://example.com",
      n: 1,
    });
  });
});

describe("parseTsconfig", () => {
  it("reads baseUrl and paths", () => {
    const tc = parseTsconfig(
      `{"compilerOptions":{"baseUrl":".","paths":{"@repo/core":["packages/core/src"],"@utils/*":["packages/utils/src/*"]}}}`,
    );
    expect(tc.baseUrl).toBe(".");
    expect(tc.paths?.["@repo/core"]).toEqual(["packages/core/src"]);
  });

  it("records the tsconfig directory", () => {
    const tc = parseTsconfig(`{"compilerOptions":{"baseUrl":"."}}`, "packages/ui/tsconfig.json");
    expect(tc.file).toBe("packages/ui/tsconfig.json");
    expect(tc.dir).toBe("packages/ui");
  });
});

describe("buildResolver with package-level tsconfig", () => {
  const packages = [pkg("@repo/ui", "packages/ui"), pkg("@repo/web", "apps/web")];
  const files = new Set([
    "packages/ui/src/index.ts",
    "packages/ui/src/helper.ts",
    "apps/web/src/index.ts",
  ]);

  it("rebases baseUrl and path targets on the tsconfig directory", () => {
    const r = buildResolver("/repo", files, [".ts"], packages, [
      {
        file: "packages/ui/tsconfig.json",
        dir: "packages/ui",
        baseUrl: ".",
        paths: { "@ui/*": ["src/*"] },
      },
    ]);
    expect(r.resolveFile("apps/web/src/index.ts", "@ui/helper").path).toBe(
      "packages/ui/src/helper.ts",
    );
  });

  it("lets the later-loaded config win for the same pattern", () => {
    const r = buildResolver("/repo", files, [".ts"], packages, [
      {
        file: "tsconfig.base.json",
        dir: "",
        baseUrl: ".",
        paths: { "@alias/x": ["packages/ui/src/index.ts"] },
      },
      {
        file: "apps/web/tsconfig.json",
        dir: "apps/web",
        baseUrl: ".",
        paths: { "@alias/x": ["../../packages/ui/src/helper.ts"] },
      },
    ]);
    expect(r.resolveFile("apps/web/src/index.ts", "@alias/x").path).toBe(
      "packages/ui/src/helper.ts",
    );
  });
});

describe("owningPackage", () => {
  it("picks the longest directory prefix", () => {
    const packages = [pkg("@repo/ui", "packages/ui"), pkg("@repo/ui-kit", "packages/ui/kit")];
    expect(owningPackage("packages/ui/kit/src/a.ts", packages)?.name).toBe("@repo/ui-kit");
    expect(owningPackage("packages/ui/src/a.ts", packages)?.name).toBe("@repo/ui");
    expect(owningPackage("README.md", packages)).toBeUndefined();
  });

  it("prefers the active package when a removed package shares its directory", () => {
    const removed = { ...pkg("@repo/core", "packages/core"), removed: true };
    const active = pkg("@repo/kernel", "packages/core");
    expect(owningPackage("packages/core/src/a.ts", [removed, active])?.name).toBe(
      "@repo/kernel",
    );
    expect(owningPackage("packages/core/src/a.ts", [active, removed])?.name).toBe(
      "@repo/kernel",
    );
    // A removed package still owns its files when no active package shares the dir.
    expect(owningPackage("packages/core/src/a.ts", [removed])?.name).toBe("@repo/core");
  });
});

describe("buildResolver", () => {
  const packages = [pkg("@repo/core", "packages/core"), pkg("@repo/utils", "packages/utils")];
  const files = new Set([
    "packages/core/src/index.ts",
    "packages/core/src/lib/helper.ts",
    "packages/core/src/lib/index.ts",
    "packages/utils/src/index.ts",
    "packages/utils/src/math.ts",
  ]);

  const resolver = buildResolver(
    "/repo",
    files,
    [".ts", ".tsx", ".js"],
    packages,
    [
      {
        baseUrl: ".",
        paths: {
          "@repo/utils/*": ["packages/utils/src/*"],
        },
      },
    ],
    new Map([["@repo/utils", ["src/math.ts"]]]),
  );

  it("resolves relative imports with extension and index fallback", () => {
    expect(
      resolver.resolveFile("packages/core/src/index.ts", "./lib/helper").path,
    ).toBe("packages/core/src/lib/helper.ts");
    expect(resolver.resolveFile("packages/core/src/index.ts", "./lib").path).toBe(
      "packages/core/src/lib/index.ts",
    );
  });

  it("resolves tsconfig path aliases with wildcard", () => {
    expect(
      resolver.resolveFile("packages/core/src/index.ts", "@repo/utils/math").path,
    ).toBe("packages/utils/src/math.ts");
  });

  it("resolves workspace packages to their entry file", () => {
    expect(
      resolver.resolveFile("packages/core/src/index.ts", "@repo/utils").path,
    ).toBe("packages/utils/src/math.ts");
  });

  it("reports external packages", () => {
    expect(
      resolver.resolveFile("packages/core/src/index.ts", "lodash/fp"),
    ).toEqual({ external: "lodash/fp" });
  });

  it("resolves the workspace package name for bare specifiers", () => {
    expect(resolver.resolvePackage("@repo/core/sub")).toBe("@repo/core");
    expect(resolver.resolvePackage("lodash")).toBeUndefined();
  });

  it("resolves ./x.js to ./x.ts", () => {
    const r = buildResolver("/repo", new Set(["a/x.ts"]), [".ts"], [], []);
    expect(r.resolveFile("a/y.ts", "./x.js").path).toBe("a/x.ts");
  });
});

describe("normalizePath", () => {
  it("normalizes separators and leading ./", () => {
    expect(normalizePath("./a//b/../c.ts")).toBe("a/c.ts");
    expect(normalizePath("a\\b\\c.ts")).toBe("a/b/c.ts");
  });
});
