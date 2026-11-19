import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { ConfigError } from "../../src/errors.js";

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

const EXPECTED_DEFAULTS = {
  version: 1,
  workspaces: { exclude: [] },
  source: {
    enabled: true,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    tsconfig: [
      "tsconfig.base.json",
      "tsconfig.json",
      "packages/*/tsconfig.json",
      "apps/*/tsconfig.json",
    ],
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
    globalGlobs: ["package.json", "tsconfig.base.json", "pnpm-workspace.yaml", "impact.config.*"],
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

describe("config schema", () => {
  it("defaults version to 1", async () => {
    await withRoot({ "impact.config.json": "{}" }, async (root) => {
      const loaded = await loadConfig(root);
      expect(loaded.config.version).toBe(1);
    });
  });

  it("produces the full default config when no file exists", async () => {
    await withRoot({}, async (root) => {
      const loaded = await loadConfig(root);
      expect(loaded.path).toBeNull();
      expect(loaded.config).toEqual(EXPECTED_DEFAULTS);
    });
  });

  it("produces the same defaults for an empty JSON config", async () => {
    await withRoot({ "impact.config.json": "{}" }, async (root) => {
      const loaded = await loadConfig(root);
      expect(loaded.config).toEqual(EXPECTED_DEFAULTS);
    });
  });

  it("produces the same defaults for an empty YAML config", async () => {
    await withRoot({ "impact.config.yaml": "---\n" }, async (root) => {
      const loaded = await loadConfig(root);
      expect(loaded.config).toEqual(EXPECTED_DEFAULTS);
    });
  });

  it("keeps defaults inside a partially specified section", async () => {
    await withRoot(
      { "impact.config.json": JSON.stringify({ source: { enabled: false } }) },
      async (root) => {
        const loaded = await loadConfig(root);
        expect(loaded.config.source).toEqual({
          ...EXPECTED_DEFAULTS.source,
          enabled: false,
        });
        expect(loaded.config.graph).toEqual(EXPECTED_DEFAULTS.graph);
        expect(loaded.config.impact).toEqual(EXPECTED_DEFAULTS.impact);
        expect(loaded.config.tests).toEqual(EXPECTED_DEFAULTS.tests);
        expect(loaded.config.deployables).toEqual([]);
      },
    );
  });

  it("accepts and preserves a partial workspaces section", async () => {
    await withRoot(
      {
        "impact.config.json": JSON.stringify({
          workspaces: { include: ["packages/*"] },
        }),
      },
      async (root) => {
        const loaded = await loadConfig(root);
        expect(loaded.config.workspaces).toEqual({
          include: ["packages/*"],
          exclude: [],
        });
      },
    );
  });

  it("keeps the tests.commands map for string and array commands", async () => {
    await withRoot(
      {
        "impact.config.json": JSON.stringify({
          tests: {
            scripts: ["unit"],
            commands: {
              lint: "eslint .",
              build: ["npm", "run", "build"],
            },
          },
        }),
      },
      async (root) => {
        const loaded = await loadConfig(root);
        expect(loaded.config.tests.commands).toEqual({
          lint: "eslint .",
          build: ["npm", "run", "build"],
        });
        expect(loaded.config.tests.scripts).toEqual(["unit"]);
        expect(loaded.config.tests.maxFiles).toBe(500);
      },
    );
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

  it("rejects unknown top-level keys", async () => {
    await withRoot(
      { "impact.config.json": JSON.stringify({ version: 1, unknownSection: {} }) },
      async (root) => {
        await expect(loadConfig(root)).rejects.toThrow(ConfigError);
        await expect(loadConfig(root)).rejects.toThrow(/unknownSection/);
      },
    );
  });

  it("validates a large array without crashing", async () => {
    const extensions = Array.from({ length: 5000 }, (_, i) => `.ext${i}`);
    await withRoot(
      { "impact.config.json": JSON.stringify({ source: { extensions } }) },
      async (root) => {
        const loaded = await loadConfig(root);
        expect(loaded.config.source.extensions).toHaveLength(5000);
        expect(loaded.config.source.extensions[4999]).toBe(".ext4999");
      },
    );
  });

  it("reports a config error for a large array of invalid values", async () => {
    const extensions = Array.from({ length: 2000 }, () => ({ not: "a string" }));
    await withRoot(
      { "impact.config.json": JSON.stringify({ source: { extensions } }) },
      async (root) => {
        await expect(loadConfig(root)).rejects.toThrow(ConfigError);
      },
    );
  });

  it("parses YAML sections and keeps defaults for omitted keys", async () => {
    await withRoot(
      {
        "impact.config.yml": [
          "version: 1",
          "graph:",
          "  peerDependencies: true",
          "deployables:",
          "  - name: web",
          "    packages: [web]",
        ].join("\n"),
      },
      async (root) => {
        const loaded = await loadConfig(root);
        expect(loaded.config.version).toBe(1);
        expect(loaded.config.graph).toEqual({
          ...EXPECTED_DEFAULTS.graph,
          peerDependencies: true,
        });
        expect(loaded.config.source).toEqual(EXPECTED_DEFAULTS.source);
        expect(loaded.config.deployables).toEqual([{ name: "web", packages: ["web"] }]);
      },
    );
  });
});
