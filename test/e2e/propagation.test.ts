import { describe, expect, it } from "vitest";
import { BASE_FILES, makeRepo, pkgJson, type JsonResult } from "../helpers/repo.js";

const pkgNames = (r: JsonResult) => r.packages.map((p) => p.name);
const pkg = (r: JsonResult, name: string) => r.packages.find((p) => p.name === name);
const warningCodes = (r: JsonResult) => r.warnings.map((w) => w.code);

describe("e2e: propagation", () => {
  it("marks a leaf change direct and dependents transitive", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.write("packages/core/src/index.ts", "export const core = 2;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r)).toEqual(["@repo/core", "@repo/ui", "@repo/web"]);
    expect(pkg(r, "@repo/core")?.impact).toBe("direct");
    expect(pkg(r, "@repo/ui")?.impact).toBe("dependent");
    expect(pkg(r, "@repo/web")?.impact).toBe("dependent");
    expect(pkg(r, "@repo/web")?.confidence).toBe("high");
    expect(r.diff.includesWorkingTree).toBe(true);
  });

  it("--depth direct excludes second-level dependents", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.write("packages/core/src/index.ts", "export const core = 2;\n");
    const r = (await repo.json(["--depth", "direct"])) as unknown as JsonResult;
    expect(pkgNames(r)).toEqual(["@repo/core", "@repo/ui"]);
  });

  it("finds untracked packages and uses them as seeds", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.write(
      "packages/new/package.json",
      pkgJson({ name: "@repo/new", scripts: { test: "vitest run" } }),
    );
    await repo.write("packages/new/src/index.ts", "export const x = 1;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r)).toContain("@repo/new");
    expect(pkg(r, "@repo/new")?.impact).toBe("direct");
  });

  it("detects source-only phantom dependencies", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/ui/package.json": pkgJson({
        name: "@repo/ui",
        scripts: { test: "vitest run" },
      }),
      "packages/ui/src/index.ts": 'export { core } from "@repo/core";\n',
    });
    await repo.write("packages/core/src/index.ts", "export const core = 2;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r)).toContain("@repo/ui");
    expect(pkg(r, "@repo/ui")?.impact).toBe("dependent");
    expect(warningCodes(r)).toContain("PHANTOM_DEPENDENCY");
  });

  it("keeps manifest edges even when source does not import the dependency", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/ui/src/index.ts": "export const ui = 1;\n",
    });
    await repo.write("packages/core/src/index.ts", "export const core = 3;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r)).toContain("@repo/ui");
  });

  it("resolves tsconfig path aliases across packages", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@core/*": ["packages/core/src/*"] },
        },
      }),
      "packages/ui/package.json": pkgJson({ name: "@repo/ui" }),
      "packages/ui/src/index.ts": 'export { core } from "@core/index";\n',
    });
    await repo.write("packages/core/src/index.ts", "export const core = 4;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r)).toContain("@repo/ui");
  });

  it("rebases package-level tsconfig paths on the package directory", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/ui/tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@ui/*": ["src/*"] } },
      }),
      "apps/web/package.json": pkgJson({ name: "@repo/web" }),
      "apps/web/src/index.ts": 'import { ui } from "@ui/index";\nexport const app = ui;\n',
    });
    await repo.write("packages/ui/src/index.ts", "export const ui = 2;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r)).toContain("@repo/web");
    expect(pkg(r, "@repo/web")?.impact).toBe("dependent");
  });

  it("discovers packages from pnpm-workspace.yaml alone", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "pnpm-workspace.yaml": `# workspaces
packages:
  - "packages/*"
  - 'apps/*'
`,
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "packages/core/package.json": JSON.stringify({
        name: "@repo/core",
        scripts: { test: "vitest run" },
      }),
      "packages/core/src/index.ts": "export const core = 1;\n",
      "packages/ui/package.json": JSON.stringify({
        name: "@repo/ui",
        dependencies: { "@repo/core": "workspace:*" },
      }),
      "packages/ui/src/index.ts": 'export { core } from "@repo/core";\n',
      "apps/web/package.json": JSON.stringify({
        name: "@repo/web",
        dependencies: { "@repo/ui": "workspace:*" },
      }),
      "apps/web/src/index.ts": 'export { ui } from "@repo/ui";\n',
    });
    await repo.write("packages/core/src/index.ts", "export const core = 2;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r)).toEqual(["@repo/core", "@repo/ui", "@repo/web"]);
    expect(r.warnings.map((w) => w.code)).not.toContain("NO_WORKSPACE_CONFIG");
  });

  it("does not read Nx or Turborepo configuration", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "nx.json": JSON.stringify({ extends: "nx/presets/core.json" }),
      "turbo.json": JSON.stringify({ tasks: { test: { dependsOn: ["^test"] } } }),
    });
    await repo.write("packages/core/src/index.ts", "export const core = 20;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r)).toEqual(["@repo/core", "@repo/ui", "@repo/web"]);
  });

  it("penetrates barrel re-exports", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/ui/src/index.ts": 'export * from "@repo/core";\n',
      "apps/web/src/index.ts": 'import { core } from "@repo/ui";\nexport const app = core;\n',
    });
    await repo.write("packages/core/src/index.ts", "export const core = 5;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r)).toContain("@repo/web");
  });
});
