import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

async function withRoot(files: Record<string, string>, fn: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "impact-config-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(root, name), content);
    }
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("config schema", () => {
  it("defaults version to 1", async () => {
    await withRoot({ "impact.config.json": "{}" }, async (root) => {
      const loaded = await loadConfig(root);
      expect(loaded.config.version).toBe(1);
    });
  });

  it("rejects unsupported config versions", async () => {
    await withRoot({ "impact.config.json": JSON.stringify({ version: 2 }) }, async (root) => {
      await expect(loadConfig(root)).rejects.toThrow(/version/);
    });
  });

  it("rejects a non-numeric version", async () => {
    await withRoot(
      { "impact.config.json": JSON.stringify({ version: "1" }) },
      async (root) => {
        await expect(loadConfig(root)).rejects.toThrow(/version/);
      },
    );
  });
});
