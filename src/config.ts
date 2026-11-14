import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import type { Config } from "./types.js";

const CONFIG_FILES = ["impact.config.json", "impact.config.yaml", "impact.config.yml"];

const deployableSchema = z.object({
  name: z.string().min(1),
  packages: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
  buildCommand: z.string().optional(),
  deployCommand: z.string().optional(),
});

const configSchema = z
  .object({
    version: z.literal(1).optional().default(1),
    workspaces: z
      .object({
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional().default([]),
      })
      .optional()
      .default({ exclude: [] }),
    source: z
      .object({
        enabled: z.boolean().optional().default(true),
        extensions: z
          .array(z.string())
          .optional()
          .default([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]),
        tsconfig: z
          .array(z.string())
          .optional()
          .default([
            "tsconfig.base.json",
            "tsconfig.json",
            "packages/*/tsconfig.json",
            "apps/*/tsconfig.json",
          ]),
        maxFileBytes: z.number().int().positive().optional().default(1_048_576),
      })
      .optional()
      .default({}),
    graph: z
      .object({
        devDependencies: z.boolean().optional().default(true),
        optionalDependencies: z.boolean().optional().default(true),
        peerDependencies: z.boolean().optional().default(false),
      })
      .optional()
      .default({}),
    impact: z
      .object({
        unowned: z.enum(["global", "warn", "ignore"]).optional().default("global"),
        lockfiles: z.enum(["global", "ignore"]).optional().default("global"),
        alwaysAffected: z.array(z.string()).optional().default([]),
        globalGlobs: z
          .array(z.string())
          .optional()
          .default([
            "package.json",
            "tsconfig.base.json",
            "pnpm-workspace.yaml",
            "impact.config.*",
          ]),
        ignoreGlobs: z
          .array(z.string())
          .optional()
          .default(["**/*.md", "**/*.mdx", "docs/**", ".github/**"]),
      })
      .optional()
      .default({}),
    tests: z
      .object({
        scripts: z.array(z.string()).optional().default(["test"]),
        commands: z
          .record(z.union([z.string(), z.array(z.string())]))
          .optional()
          .default({}),
        include: z
          .array(z.string())
          .optional()
          .default(["**/*.test.*", "**/*.spec.*", "**/__tests__/**"]),
        maxFiles: z.number().int().positive().optional().default(500),
      })
      .optional()
      .default({}),
    deployables: z.array(deployableSchema).optional().default([]),
  })
  .strict();

export interface LoadedConfig {
  config: Config;
  path: string | null;
  raw: string;
}

export async function findConfigFile(root: string): Promise<string | null> {
  const found: string[] = [];
  for (const name of CONFIG_FILES) {
    const p = path.join(root, name);
    try {
      const stat = await fs.stat(p);
      if (stat.isFile()) found.push(p);
    } catch {
      // not present
    }
  }
  if (found.length > 1) {
    throw new ConfigError(
      `Multiple config files found: ${found.map((p) => path.basename(p)).join(", ")}. Keep only one or pass --config.`,
    );
  }
  return found[0] ?? null;
}

export async function loadConfig(
  root: string,
  explicitPath?: string,
): Promise<LoadedConfig> {
  let configPath: string | null;
  if (explicitPath) {
    const abs = path.isAbsolute(explicitPath)
      ? explicitPath
      : path.resolve(process.cwd(), explicitPath);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ConfigError(`Config path must be inside repository root: ${explicitPath}`);
    }
    configPath = abs;
  } else {
    configPath = await findConfigFile(root);
  }

  let raw = "";
  let parsed: unknown = {};
  if (configPath) {
    raw = await fs.readFile(configPath, "utf8");
    try {
      if (configPath.endsWith(".json")) {
        parsed = JSON.parse(raw);
      } else {
        parsed = YAML.parse(raw);
      }
    } catch (err) {
      throw new ConfigError(
        `Failed to parse config file ${configPath}: ${(err as Error).message}`,
      );
    }
    if (parsed === null || parsed === undefined) parsed = {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`Config file ${configPath} must contain an object at top level.`);
    }
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(
      `Invalid config${configPath ? ` in ${configPath}` : ""}:\n${issues}`,
    );
  }

  const config = result.data as Config;
  return { config, path: configPath, raw };
}
