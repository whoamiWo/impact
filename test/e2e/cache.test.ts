import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_FILES, makeRepo, pkgJson, type JsonResult } from "../helpers/repo.js";

const warningMessages = (r: JsonResult) =>
  r.warnings.filter((w) => w.code === "PHANTOM_DEPENDENCY").map((w) => w.message);

const EXTRA_PACKAGES = {
  "packages/one/package.json": pkgJson({ name: "@repo/one" }),
  "packages/one/src/index.ts": "export const one = 1;\n",
  "packages/two/package.json": pkgJson({ name: "@repo/two" }),
  "packages/two/src/index.ts": "export const two = 2;\n",
};

describe("e2e: source graph cache correctness", () => {
  it("reflects a same-length edit made within the same mtime second", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      ...EXTRA_PACKAGES,
      "packages/core/src/index.ts":
        'import { one } from "@repo/one";\nexport const core = one;\n',
    });
    const file = path.join(repo.dir, "packages/core/src/index.ts");
    const before = await fs.stat(file);

    const first = (await repo.json()) as unknown as JsonResult;
    expect(warningMessages(first).some((m) => m.includes("@repo/one"))).toBe(true);
    expect(warningMessages(first).some((m) => m.includes("@repo/two"))).toBe(false);

    const next = 'import { two } from "@repo/two";\nexport const core = two;\n';
    expect(Buffer.byteLength(next)).toBe(Buffer.byteLength(
      'import { one } from "@repo/one";\nexport const core = one;\n',
    ));
    await repo.write("packages/core/src/index.ts", next);
    await fs.utimes(file, before.atime, before.mtime);

    const second = (await repo.json()) as unknown as JsonResult;
    expect(warningMessages(second).some((m) => m.includes("@repo/two"))).toBe(true);
    expect(warningMessages(second).some((m) => m.includes("@repo/one"))).toBe(false);
  });

  it("invalidates the cache when tsconfig paths change", async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@alias/*": ["packages/core/src/*"] } },
      }),
      "packages/ui/package.json": pkgJson({ name: "@repo/ui" }),
      "packages/ui/src/index.ts": 'export { core } from "@alias/index";\n',
    });
    await repo.write("packages/core/src/index.ts", "export const core = 5;\n");

    const first = (await repo.json()) as unknown as JsonResult;
    expect(first.warnings.some((w) => w.code === "UNRESOLVED_IMPORT")).toBe(false);

    await repo.write(
      "tsconfig.base.json",
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@alias/*": ["packages/missing/src/*"] } },
      }),
    );

    const second = (await repo.json()) as unknown as JsonResult;
    expect(second.warnings.some((w) => w.code === "UNRESOLVED_IMPORT")).toBe(true);
  });

  it("rebuilds safely when the cached payload is malformed", async () => {
    const repo = await makeRepo(BASE_FILES);
    await repo.write("packages/core/src/index.ts", "export const core = 6;\n");

    const baseline = JSON.stringify(await repo.json());
    const cacheDir = path.join(repo.dir, ".git", "impact-cache", "v1");
    const entries = await fs.readdir(cacheDir);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      await fs.writeFile(
        path.join(cacheDir, entry),
        JSON.stringify({
          graph: {
            fileEdges: [{ from: 1, to: 2 }],
            packageEdges: [{ from: "a", to: "b", kind: "bogus" }],
            filesParsed: 1,
          },
          warnings: [{ code: 5 }],
        }),
        "utf8",
      );
    }

    const res = await repo.cli(["--format", "json"]);
    expect(res.code).toBe(0);
    expect(JSON.stringify(JSON.parse(res.stdout))).toBe(baseline);
  });

  it("reuses stored hashes on a warm run and reports cache counters under --verbose", async () => {
    const repo = await makeRepo({ ...BASE_FILES, ...EXTRA_PACKAGES });
    await repo.write("packages/core/src/index.ts", "export const core = 7;\n");

    const first = (await repo.json(["--verbose"])) as unknown as JsonResult;
    const firstCache = first.stats as unknown as {
      cache: { hit: boolean; filesHashed: number; filesReused: number };
    };
    expect(firstCache.cache.hit).toBe(false);
    expect(firstCache.cache.filesHashed).toBeGreaterThan(0);
    expect(firstCache.cache.filesReused).toBe(0);

    const second = (await repo.json(["--verbose"])) as unknown as JsonResult;
    const secondCache = second.stats as unknown as {
      cache: { hit: boolean; filesHashed: number; filesReused: number };
    };
    expect(secondCache.cache.hit).toBe(true);
    expect(secondCache.cache.filesHashed).toBe(0);
    expect(secondCache.cache.filesReused).toBeGreaterThan(0);

    // Default JSON (no --verbose) stays byte-identical across warm runs.
    expect(JSON.stringify(await repo.json())).toBe(JSON.stringify(await repo.json()));
  });

  it("neither reads nor writes the hash sidecar with --no-cache", async () => {
    const repo = await makeRepo({ ...BASE_FILES, ...EXTRA_PACKAGES });
    await repo.write("packages/core/src/index.ts", "export const core = 9;\n");
    const cacheDir = path.join(repo.dir, ".git", "impact-cache", "v1");
    const sidecar = path.join(cacheDir, "files.json");

    // A first cached run creates the sidecar.
    await repo.json();
    const sidecarBefore = await fs.readFile(sidecar, "utf8");
    const mtimeBefore = (await fs.stat(sidecar)).mtimeMs;

    const res = await repo.cli(["--format", "json", "--verbose", "--no-cache"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as JsonResult & {
      stats: { cache?: { filesHashed: number; filesReused: number } };
    };
    expect(parsed.stats.cache?.filesHashed).toBe(0);
    expect(parsed.stats.cache?.filesReused).toBe(0);
    expect(await fs.readFile(sidecar, "utf8")).toBe(sidecarBefore);
    expect((await fs.stat(sidecar)).mtimeMs).toBe(mtimeBefore);

    // Without any prior cached run, --no-cache creates no sidecar at all.
    const fresh = await makeRepo({ ...BASE_FILES, ...EXTRA_PACKAGES });
    await fresh.write("packages/core/src/index.ts", "export const core = 10;\n");
    await fresh.json(["--no-cache"]);
    await expect(
      fs.stat(path.join(fresh.dir, ".git", "impact-cache", "v1", "files.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes sidecar entries in sorted file order regardless of stat completion order", async () => {
    const repo = await makeRepo({ ...BASE_FILES, ...EXTRA_PACKAGES });
    await repo.write("packages/core/src/index.ts", "export const core = 12;\n");
    await repo.json();
    const sidecar = path.join(repo.dir, ".git", "impact-cache", "v1", "files.json");
    const meta = JSON.parse(await fs.readFile(sidecar, "utf8")) as {
      files: Record<string, unknown>;
    };
    const keys = Object.keys(meta.files);
    expect(keys).toEqual([...keys].sort());
  });

  it("prunes hash sidecar entries for files that no longer exist", async () => {
    const repo = await makeRepo({ ...BASE_FILES, ...EXTRA_PACKAGES });
    await repo.write("packages/core/src/index.ts", "export const core = 11;\n");
    const sidecar = path.join(repo.dir, ".git", "impact-cache", "v1", "files.json");

    await repo.json();
    const before = JSON.parse(await fs.readFile(sidecar, "utf8")) as {
      files: Record<string, unknown>;
    };
    expect(Object.keys(before.files)).toContain("packages/one/src/index.ts");

    await repo.remove("packages/one/src/index.ts");
    await repo.json();

    const after = JSON.parse(await fs.readFile(sidecar, "utf8")) as {
      files: Record<string, unknown>;
    };
    expect(Object.keys(after.files)).not.toContain("packages/one/src/index.ts");
  });

  it("rehashes everything when the hash sidecar is malformed", async () => {
    const repo = await makeRepo({ ...BASE_FILES, ...EXTRA_PACKAGES });
    await repo.write("packages/core/src/index.ts", "export const core = 8;\n");

    const baseline = JSON.stringify(await repo.json());
    const cacheDir = path.join(repo.dir, ".git", "impact-cache", "v1");
    const sidecar = path.join(cacheDir, "files.json");
    expect((await fs.readdir(cacheDir)).includes("files.json")).toBe(true);

    // Top-level garbage and a structurally valid file with an invalid entry
    // both degrade to "rehash everything" rather than failing analysis.
    for (const corrupt of [
      "{not json",
      JSON.stringify({ version: "files-v1", files: { "a.ts": { size: "bad" } } }),
    ]) {
      await fs.writeFile(sidecar, corrupt, "utf8");
      const res = await repo.cli(["--format", "json", "--verbose"]);
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout) as JsonResult & {
        stats: { cache?: { hit: boolean; filesHashed: number; filesReused: number } };
      };
      // Nothing was reused, so every file was re-read and re-hashed. The
      // content-addressed key is unchanged, so the payload cache still hits.
      expect(parsed.stats.cache?.hit).toBe(true);
      expect(parsed.stats.cache?.filesHashed).toBeGreaterThan(0);
      expect(parsed.stats.cache?.filesReused).toBe(0);
      delete parsed.stats.cache;
      expect(JSON.stringify(parsed)).toBe(baseline);
    }
  });
});
