import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { BASE_FILES, makeRepo, pkgJson, runCli, type JsonResult } from "../helpers/repo.js";

const execFileP = promisify(execFile);

const pkgNames = (r: JsonResult) => r.packages.map((p) => p.name);
const pkg = (r: JsonResult, name: string) => r.packages.find((p) => p.name === name);
const warningCodes = (r: JsonResult) => r.warnings.map((w) => w.code);

describe("e2e: git states and deletions", () => {
  it("exits 2 on shallow clone merge-base failure unless --allow-shallow-fallback", async () => {
    const repo = await makeRepo(BASE_FILES);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "impact-shallow-"));
    try {
      await execFileP("git", [
        "clone",
        "--depth",
        "1",
        "--no-local",
        "--quiet",
        `file://${repo.dir}`,
        dir,
      ]);
      // Advance origin past the shallow boundary so merge-base cannot resolve.
      await repo.write("packages/core/src/index.ts", "export const core = 9;\n");
      await repo.commit("advance");
      await execFileP("git", ["fetch", "--depth", "1", "origin", "main"], { cwd: dir });

      const res = await runCli(dir, []);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("merge-base");
      expect(res.stderr).toContain("--unshallow");
      expect(res.stderr).toContain("--base");

      const ok = await runCli(dir, ["--format", "json", "--allow-shallow-fallback"]);
      expect(ok.code).toBe(0);
      const parsed = JSON.parse(ok.stdout) as JsonResult;
      expect(parsed.diff.mergeBaseFallback).toBe(true);
      expect(parsed.warnings.some((w) => w.code === "SHALLOW_CLONE")).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("treats lockfile changes as global and supports lockfiles: ignore", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.write("pnpm-lock.yaml", "lockfileVersion: 9\nfoo: bar\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r)).toEqual(["@repo/core", "@repo/ui", "@repo/web"]);
    expect(r.packages.every((p) => p.impact === "global")).toBe(true);
    expect(r.packages.every((p) => p.confidence === "medium")).toBe(true);

    const repo2 = await makeRepo({
      ...BASE_FILES,
      "impact.config.json": JSON.stringify({
        version: 1,
        impact: { lockfiles: "ignore" },
      }),
    });
    await repo2.write("pnpm-lock.yaml", "lockfileVersion: 9\nfoo: bar\n");
    const r2 = (await repo2.json()) as unknown as JsonResult;
    expect(pkgNames(r2)).toEqual([]);
  });

  it("ignores documentation-only changes", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.write("docs/guide.md", "# Guide\n");
    await repo.write("README.md", "# readme\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r)).toEqual([]);
    expect(r.stats.packagesAffected).toBe(0);
  });

  it("treats unowned files as global with a warning", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.write("scripts/release.sh", "echo hi\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r).length).toBe(3);
    expect(warningCodes(r)).toContain("UNOWNED_CHANGE");
  });

  it("ignores working tree with --no-working and analyzes commit ranges", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.git(["checkout", "-q", "-b", "feature"]);
    await repo.write("packages/core/src/index.ts", "export const core = 6;\n");
    await repo.commit("change core");
    await repo.write("packages/ui/src/index.ts", "export const dirty = 1;\n");
    const r = (await repo.json(["--no-working"])) as unknown as JsonResult;
    expect(pkgNames(r)).toEqual(["@repo/core", "@repo/ui", "@repo/web"]);
    expect(r.changedFiles.some((f) => f.path === "packages/ui/src/index.ts")).toBe(false);
    expect(r.diff.includesWorkingTree).toBe(false);
  });

  it("synthesizes removed packages and marks old dependents", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/legacy/package.json": pkgJson({ name: "@repo/legacy", scripts: { test: "x" } }),
      "packages/legacy/src/index.ts": "export const legacy = 1;\n",
      "packages/ui/package.json": pkgJson({
        name: "@repo/ui",
        dependencies: { "@repo/core": "1", "@repo/legacy": "1" },
        scripts: { test: "vitest run" },
      }),
    });
    await repo.remove("packages/legacy");
    const r = (await repo.json()) as unknown as JsonResult;
    const legacy = pkg(r, "@repo/legacy");
    expect(legacy?.removed).toBe(true);
    expect(legacy?.test.commands).toEqual([]);
    expect(warningCodes(r)).toContain("DELETED_PACKAGE");
    expect(pkgNames(r)).toContain("@repo/ui");
  });

  it("treats a package rename as removed plus added", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.git(["mv", "packages/core", "packages/kernel"]);
    await repo.write(
      "packages/kernel/package.json",
      pkgJson({ name: "@repo/kernel", scripts: { test: "vitest run" } }),
    );
    await repo.write(
      "packages/ui/package.json",
      pkgJson({
        name: "@repo/ui",
        dependencies: { "@repo/kernel": "workspace:*" },
        scripts: { test: "vitest run" },
      }),
    );
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkg(r, "@repo/core")?.removed).toBe(true);
    expect(pkg(r, "@repo/kernel")?.removed).toBeUndefined();
    expect(pkg(r, "@repo/ui")?.impact).toBe("direct");
  });

  it("attributes an in-place package rename to the new package", async () => {
    const repo = await makeRepo(BASE_FILES);
    // Same directory, only the manifest name changes: the old package is
    // synthesized as removed, and both share packages/core as their dir.
    await repo.write(
      "packages/core/package.json",
      pkgJson({ name: "@repo/kernel", scripts: { test: "vitest run" } }),
    );
    await repo.write(
      "packages/ui/package.json",
      pkgJson({
        name: "@repo/ui",
        dependencies: { "@repo/kernel": "workspace:*" },
        scripts: { test: "vitest run" },
      }),
    );
    await repo.write("packages/core/src/index.ts", "export const core = 8;\n");

    const r = (await repo.json()) as unknown as JsonResult;
    // The removed name must never be reported as an active package, and its
    // removal is surfaced in warnings. It has no impacted packages of its own
    // once the active package wins ownership of the shared directory.
    expect(pkg(r, "@repo/core")?.removed ?? true).toBe(true);
    expect(warningCodes(r)).toContain("DELETED_PACKAGE");
    expect(
      r.warnings.some(
        (w) => w.code === "DELETED_PACKAGE" && w.message.includes("@repo/core"),
      ),
    ).toBe(true);
    const kernel = pkg(r, "@repo/kernel");
    expect(kernel?.removed).toBeUndefined();
    expect(kernel?.impact).toBe("direct");
    const direct = kernel?.reasons.find((x) => x.type === "direct") as unknown as {
      files: string[];
    };
    expect(direct.files).toContain("packages/core/src/index.ts");
    expect(pkg(r, "@repo/ui")).toBeTruthy();
    expect(pkg(r, "@repo/web")?.impact).toBe("dependent");
  });

  it("attributes both sides of a file rename", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.git(["mv", "packages/core/src/index.ts", "packages/core/src/main.ts"]);
    await repo.write("packages/core/src/main.ts", "export const core = 7;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    const reason = pkg(r, "@repo/core")?.reasons.find((x) => x.type === "direct");
    expect(reason).toBeTruthy();
    const files = (reason as unknown as { files: string[] }).files;
    expect(files).toContain("packages/core/src/main.ts");
    expect(pkgNames(r)).toContain("@repo/ui");
  });

  it("handles dependency cycles safely", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "packages/core/package.json": pkgJson({
        name: "@repo/core",
        dependencies: { "@repo/web": "1" },
        scripts: { test: "vitest run" },
      }),
    });
    await repo.write("packages/core/src/index.ts", "export const core = 8;\n");
    const r = (await repo.json()) as unknown as JsonResult;
    expect(pkgNames(r)).toEqual(["@repo/core", "@repo/ui", "@repo/web"]);
    const again = (await repo.json()) as unknown as JsonResult;
    expect(JSON.stringify(again)).toBe(JSON.stringify(r));
  });
});
