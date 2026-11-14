import { describe, expect, it } from "vitest";
import { BASE_FILES, makeRepo, pkgJson, runCli, type JsonResult } from "../helpers/repo.js";

const pkgNames = (r: JsonResult) => r.packages.map((p) => p.name);
const pkg = (r: JsonResult, name: string) => r.packages.find((p) => p.name === name);

describe("e2e: test suggestions", () => {
  it("warns for missing test scripts and keeps them out of the matrix", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/core/package.json": pkgJson({ name: "@repo/core", scripts: { build: "tsc" } }),
    });
    await repo.write("packages/core/src/index.ts", "export const core = 9;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkg(r, "@repo/core")?.test.commands).toEqual([]);
    expect(r.warnings.some((w) => w.code === "NO_TEST_SCRIPT")).toBe(true);

    const res = await runCli(repo.dir, ["--format", "github"]);
    const matrix = JSON.parse(res.stdout);
    expect(matrix.include.map((i: { package: string }) => i.package)).not.toContain(
      "@repo/core",
    );
  });

  it("keeps override-only packages in the github matrix", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/core/package.json": pkgJson({ name: "@repo/core", scripts: { build: "tsc" } }),
      "impact.config.json": JSON.stringify({
        version: 1,
        tests: { commands: { "@repo/core": ["make unit", "make e2e"] } },
      }),
    });
    await repo.write("packages/core/src/index.ts", "export const core = 11;\n");
    const res = await runCli(repo.dir, ["--format", "github"]);
    const matrix = JSON.parse(res.stdout);
    expect(
      matrix.include.filter((i: { package: string }) => i.package === "@repo/core"),
    ).toEqual([
      { package: "@repo/core", dir: "packages/core", script: "make unit", command: "make unit" },
      { package: "@repo/core", dir: "packages/core", script: "make e2e", command: "make e2e" },
    ]);
  });

  it("renders pnpm commands when pnpm is detected", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.write("packages/core/src/index.ts", "export const core = 10;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkg(r, "@repo/core")?.test.commands).toEqual([
      "pnpm --filter @repo/core run test",
    ]);
  });

  it("finds same-name and reverse-import test files with --files", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/core/src/index.test.ts": 'import { core } from "./index";\n',
      "apps/web/src/index.test.ts": 'import { app } from "./index";\n',
    });
    await repo.write("packages/core/src/index.ts", "export const core = 11;\n");
    const r = (await repo.json(["--files"])) as unknown as JsonResult;
    expect(pkg(r, "@repo/core")?.testFiles).toEqual(["packages/core/src/index.test.ts"]);
    expect(pkg(r, "@repo/web")?.testFiles).toEqual(["apps/web/src/index.test.ts"]);
  });

  it("returns empty testFiles when --files is off", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/core/src/index.test.ts": 'import { core } from "./index";\n',
    });
    await repo.write("packages/core/src/index.ts", "export const core = 12;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkg(r, "@repo/core")?.testFiles).toEqual([]);
  });
});

describe("e2e: deployables", () => {
  it("uses apps/* fallback", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.write("apps/web/src/index.ts", "export const app = 2;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(r.deployables.map((d) => d.name)).toEqual(["@repo/web"]);
    expect(r.deployables[0].affected).toBe(true);
  });

  it("supports configured deployables with paths and commands", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "impact.config.json": JSON.stringify({
        version: 1,
        impact: { unowned: "ignore" },
        deployables: [
          {
            name: "web",
            packages: ["@repo/web"],
            paths: ["deploy/web/**"],
            buildCommand: "pnpm --filter @repo/web build",
            deployCommand: "kubectl apply -k deploy/web",
          },
          { name: "api", packages: ["@repo/core"] },
        ],
      }),
    });
    await repo.write("deploy/web/k8s.yaml", "kind: Deployment\n");
    const r = (await repo.json()) as unknown as JsonResult;
    const web = r.deployables.find((d) => d.name === "web")!;
    expect(web.affected).toBe(true);
    expect(web.reasons).toContainEqual({ type: "path", path: "deploy/web/k8s.yaml" });
    const api = r.deployables.find((d) => d.name === "api")!;
    expect(api.affected).toBe(false);
  });

  it("marks a deployable affected when its only package is deleted", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "impact.config.json": JSON.stringify({
        version: 1,
        deployables: [
          { name: "platform", packages: ["@repo/core"] },
          { name: "web", packages: ["@repo/web"] },
        ],
      }),
    });
    await repo.remove("packages/core");
    const r = (await repo.json()) as unknown as JsonResult;
    const platform = r.deployables.find((d) => d.name === "platform")!;
    expect(platform.affected).toBe(true);
    expect(platform.packages).toEqual([]);
    expect(platform.reasons).toContainEqual({
      type: "removedPackage",
      package: "@repo/core",
    });
    const web = r.deployables.find((d) => d.name === "web")!;
    // @repo/web is a transitive dependent of the deleted @repo/core, so the
    // removal propagates to it as a normal package reason.
    expect(web.affected).toBe(true);
    expect(web.packages).toEqual(["@repo/web"]);
    expect(web.reasons).toContainEqual({ type: "package", package: "@repo/web" });
  });

  it("marks deployables affected when config file changes", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "impact.config.json": JSON.stringify({
        version: 1,
        deployables: [{ name: "web", packages: ["@repo/web"] }],
      }),
    });
    await repo.write(
      "impact.config.json",
      JSON.stringify({
        version: 1,
        deployables: [{ name: "web", packages: ["@repo/web"] }],
        tests: { scripts: ["test"] },
      }),
    );
    const r = (await repo.json()) as unknown as JsonResult;
    expect(r.deployables[0].affected).toBe(true);
  });

  it("emits deploy github matrix", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "impact.config.json": JSON.stringify({
        version: 1,
        deployables: [
          {
            name: "web",
            packages: ["@repo/web"],
            buildCommand: "build-web",
            deployCommand: "deploy-web",
          },
        ],
      }),
    });
    await repo.write("apps/web/src/index.ts", "export const app = 3;\n");
    const res = await runCli(repo.dir, ["--format", "github", "--github-target", "deploy"]);
    const matrix = JSON.parse(res.stdout);
    expect(matrix.include).toEqual([
      { deployable: "web", buildCommand: "build-web", deployCommand: "deploy-web" },
    ]);
  });
});

describe("e2e: warnings and safety", () => {
  it("warns on dynamic imports with non-literal specifiers", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/core/src/index.ts":
        "const name = './x';\nexport const load = () => import(name);\n",
    });
    await repo.write("packages/core/src/index.ts", "const name = './x';\nexport const load = () => import(name);\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(r.warnings.some((w) => w.code === "DYNAMIC_IMPORT")).toBe(true);
  });

  it("skips files larger than maxFileBytes with a warning", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "impact.config.json": JSON.stringify({
        version: 1,
        source: { maxFileBytes: 10 },
      }),
    });
    await repo.write("packages/core/src/index.ts", "export const core = 13;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(r.warnings.some((w) => w.code === "FILE_TOO_LARGE")).toBe(true);
  });

  it("returns deterministic JSON across runs with and without cache", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/core/src/index.test.ts": 'import { core } from "./index";\n',
    });
    await repo.write("packages/core/src/index.ts", "export const core = 14;\n");
    const a = JSON.stringify(await repo.json(["--files"]));
    const b = JSON.stringify(await repo.json(["--files"]));
    const cold = JSON.stringify(await repo.json(["--files", "--no-cache"]));
    expect(b).toBe(a);
    expect(cold).toBe(a);
  });

  it("reports usage errors with exit code 2", async () => {
    const repo = await makeRepo(BASE_FILES);
    const badDepth = await runCli(repo.dir, ["--depth", "deep"]);
    expect(badDepth.code).toBe(2);
    expect(badDepth.stderr).toContain("--depth");

    const badFormat = await runCli(repo.dir, ["--format", "xml"]);
    expect(badFormat.code).toBe(2);

    const unknown = await runCli(repo.dir, ["--nope"]);
    expect(unknown.code).toBe(2);
  });

  it("fails with exit code 2 when two packages share a name", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/clone/package.json": JSON.stringify({ name: "@repo/core" }),
      "packages/clone/src/index.ts": "export const clone = 1;\n",
    });
    const res = await runCli(repo.dir, ["--format", "json"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("Duplicate workspace package names");
    expect(res.stderr).toContain("@repo/core");
    expect(res.stderr).toContain("packages/core");
    expect(res.stderr).toContain("packages/clone");
  });

  it("fails with exit code 2 outside git", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "impact-nogit-"));
    try {
      const res = await runCli(dir, []);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("Not inside a git repository");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("fails with exit code 2 when no workspace config exists", async () => {
    const repo = await makeRepo({
      "package.json": pkgJson({ name: "root", private: true }),
      "src/index.ts": "export const a = 1;\n",
    });
    const res = await runCli(repo.dir, []);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("workspace");
  });

  it("works from a subdirectory", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.write("packages/core/src/index.ts", "export const core = 15;\n");
    const res = await runCli(`${repo.dir}/packages/core`, ["--format", "json"]);
    expect(res.code).toBe(0);
    const r = JSON.parse(res.stdout) as JsonResult;
    expect(pkgNames(r)).toContain("@repo/core");
  });

  it("errors on multiple config files", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "impact.config.json": JSON.stringify({ version: 1 }),
      "impact.config.yaml": "version: 1\n",
    });
    const res = await runCli(repo.dir, []);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("Multiple config files");
  });
});

describe("e2e: doctor", () => {
  it("prints diagnostics", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.write("packages/core/src/index.ts", "export const core = 16;\n");
    const res = await runCli(repo.dir, ["doctor"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("impact doctor");
    expect(res.stdout).toContain("packages: 3 total");
    expect(res.stdout).toContain("test script coverage");
  });

  it("accepts the subcommand after options", async () => {
    const repo = await makeRepo(BASE_FILES);
    const res = await runCli(repo.dir, ["--no-cache", "doctor"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("impact doctor");
  });

  it("reports diagnostics instead of failing outside git", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "impact-doctor-nogit-"));
    try {
      await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "root" }));
      const res = await runCli(dir, ["doctor"]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("impact doctor");
      expect(res.stdout).toContain("status: analysis did not complete");
      expect(res.stdout).toContain("git: unavailable");
      expect(res.stdout).toContain("failed stage:");
      expect(res.stdout).toContain("hint: run \"git init\"");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports diagnostics when no workspace configuration exists", async () => {
    const repo = await makeRepo({
      "package.json": pkgJson({ name: "root", private: true }),
      "src/index.ts": "export const a = 1;\n",
    });
    const res = await runCli(repo.dir, ["doctor"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("status: analysis did not complete");
    expect(res.stdout).toContain("workspace packages: 0");
    expect(res.stdout).toContain("hint:");
  });

  it("reports diagnostics when the config file is invalid", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "impact.config.json": JSON.stringify({ version: "not-a-number" }),
    });
    const res = await runCli(repo.dir, ["doctor"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("config: error");
    expect(res.stdout).toContain("failed stage:");
  });
});
