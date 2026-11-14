#!/usr/bin/env node
/**
 * Release smoke test: packs the CLI, installs the tarball into a throwaway
 * project, then checks `--version` and a one-package analysis.
 *
 * Usage: node scripts/smoke-pack.mjs
 * Requires network access to install dependencies from the public registry.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "impact-smoke-pack-"));

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    console.error(`command failed: ${cmd} ${args.join(" ")}\n${res.stdout}\n${res.stderr}`);
    process.exit(1);
  }
  return res.stdout;
}

function expectContains(label, text, needle) {
  if (!text.includes(needle)) {
    console.error(`${label}: expected output to contain ${JSON.stringify(needle)}`);
    console.error(text);
    process.exit(1);
  }
}

try {
  const packDir = path.join(tmp, "pack");
  fs.mkdirSync(packDir);
  const packOutput = run("npm", ["pack", "--pack-destination", packDir], repoRoot);
  const tgz = fs.readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) {
    console.error(`npm pack produced no tarball:\n${packOutput}`);
    process.exit(1);
  }

  const projectDir = path.join(tmp, "project");
  fs.mkdirSync(projectDir);
  run("npm", ["init", "-y"], projectDir);
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", path.join(packDir, tgz)],
    projectDir,
  );

  const bin = path.join(projectDir, "node_modules", ".bin", "impact");
  const version = run(bin, ["--version"], projectDir).trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`unexpected --version output: ${JSON.stringify(version)}`);
    process.exit(1);
  }

  const fixture = path.join(tmp, "fixture");
  fs.mkdirSync(path.join(fixture, "packages", "a", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
  );
  fs.writeFileSync(
    path.join(fixture, "packages", "a", "package.json"),
    JSON.stringify({ name: "@x/a", scripts: { test: "vitest run" } }),
  );
  fs.writeFileSync(path.join(fixture, "packages", "a", "src", "index.ts"), "export const a = 1;\n");
  run("git", ["init", "-q", "-b", "main"], fixture);
  run("git", ["add", "."], fixture);
  run(
    "git",
    ["-c", "user.email=smoke@example.invalid", "-c", "user.name=smoke", "commit", "-qm", "init"],
    fixture,
  );
  fs.writeFileSync(path.join(fixture, "packages", "a", "src", "index.ts"), "export const a = 2;\n");

  const out = run(bin, ["--root", fixture, "--format", "json", "--no-cache"], projectDir);
  const result = JSON.parse(out);
  if (result.schemaVersion !== 1) {
    console.error(`unexpected schemaVersion: ${result.schemaVersion}`);
    process.exit(1);
  }
  expectContains("analysis", JSON.stringify(result.packages), '"@x/a"');

  process.stdout.write(`smoke-pack ok: impact ${version}, ${result.stats.packagesAffected} affected package(s)\n`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
