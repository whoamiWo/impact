import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

function build(): void {
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "ignore" });
}

function newestSrcMtime(dir: string): number {
  let newest = 0;
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSrcMtime(full));
    } else if (entry.name.endsWith(".ts")) {
      newest = Math.max(newest, fsSync.statSync(full).mtimeMs);
    }
  }
  return newest;
}

function ensureBuilt(): void {
  let distMtime = 0;
  try {
    distMtime = fsSync.statSync(cliPath).mtimeMs;
  } catch {
    build();
    return;
  }
  if (newestSrcMtime(path.join(repoRoot, "src")) > distMtime) build();
}

function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: dir }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

export interface RepoHandle {
  dir: string;
  write(rel: string, content: string | Buffer): Promise<void>;
  remove(rel: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  commit(message?: string): Promise<void>;
  git(args: string[]): Promise<string>;
  cli(args: string[], opts?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
  json(args?: string[]): Promise<Record<string, unknown>>;
}

export async function makeRepo(files: Record<string, string | Buffer>): Promise<RepoHandle> {
  ensureBuilt();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "impact-e2e-"));
  onTestFinished(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "init"]);

  const handle: RepoHandle = {
    dir,
    async write(rel, content) {
      const abs = path.join(dir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    },
    async remove(rel) {
      await fs.rm(path.join(dir, rel), { recursive: true, force: true });
    },
    async rename(from, to) {
      await git(dir, ["mv", from, to]);
    },
    async commit(message = "change") {
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-qm", message]);
    },
    git: (args) => git(dir, args),
    cli: (args, opts = {}) => runCli(opts.cwd ?? dir, args),
    async json(args = []) {
      const res = await runCli(dir, ["--format", "json", ...args]);
      if (res.code !== 0) {
        throw new Error(`CLI failed (${res.code}): ${res.stderr}`);
      }
      return JSON.parse(res.stdout);
    },
  };
  return handle;
}

export async function runCli(
  root: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args, "--root", root],
      { cwd: root, maxBuffer: 1024 * 1024 * 20 },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

export interface JsonResult {
  schemaVersion: number;
  diff: Record<string, unknown>;
  changedFiles: { path: string; status: string; oldPath?: string }[];
  packages: {
    name: string;
    dir: string;
    impact: string;
    confidence: string;
    removed?: boolean;
    reasons: { type: string }[];
    test: { scripts: string[]; commands: string[] };
    testFiles: string[];
  }[];
  deployables: {
    name: string;
    packages: string[];
    affected: boolean;
    reasons: { type: string; path?: string; package?: string }[];
    buildCommand?: string;
    deployCommand?: string;
  }[];
  warnings: { code: string; message: string; file?: string; pkg?: string }[];
  stats: Record<string, number>;
}

type PackageJson = Record<string, unknown>;

export const BASE_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "root",
      private: true,
      workspaces: ["packages/*", "apps/*"],
    },
    null,
    2,
  ),
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "packages/core/package.json": JSON.stringify({
    name: "@repo/core",
    scripts: { test: "vitest run" },
  }),
  "packages/core/src/index.ts": "export const core = 1;\n",
  "packages/ui/package.json": JSON.stringify({
    name: "@repo/ui",
    dependencies: { "@repo/core": "workspace:*" },
    scripts: { test: "vitest run" },
  }),
  "packages/ui/src/index.ts": 'export { core } from "@repo/core";\n',
  "apps/web/package.json": JSON.stringify({
    name: "@repo/web",
    dependencies: { "@repo/ui": "workspace:*" },
    scripts: { test: "vitest run", build: "tsc" },
  }),
  "apps/web/src/index.ts": 'import { core } from "@repo/ui";\nexport const app = core;\n',
};

export function pkgJson(value: PackageJson): string {
  return JSON.stringify(value, null, 2);
}
