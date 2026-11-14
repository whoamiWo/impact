#!/usr/bin/env node
/**
 * Synthetic benchmark: generates a throwaway monorepo, commits it, then measures
 * `impact` cold (no cache), cache-miss, and cache-hit runs.
 *
 * Usage: node scripts/bench.mjs [--packages 1000] [--files 20] [--keep]
 *
 * Output is a Markdown fragment so results can be pasted into docs/benchmark.md.
 * Numbers are machine-specific samples, not guarantees.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const raw = process.argv[i + 1];
  return raw === undefined ? fallback : Number(raw);
}

const packages = Math.max(1, arg("packages", 1000));
const filesPerPackage = Math.max(1, arg("files", 20));
const keep = process.argv.includes("--keep");

if (!fs.existsSync(cliPath)) {
  console.error(`missing ${cliPath}; run "npm run build" first`);
  process.exit(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-bench-"));
const pad = String(packages).length;

function write(rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function pkgName(i) {
  return `@bench/pkg-${String(i).padStart(pad, "0")}`;
}

function generate() {
  write(
    "package.json",
    JSON.stringify(
      { name: "bench-root", private: true, workspaces: ["packages/*"] },
      null,
      2,
    ),
  );
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  write(
    "tsconfig.base.json",
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: {} } }, null, 2),
  );

  for (let i = 0; i < packages; i++) {
    const name = pkgName(i);
    const dir = `packages/${name.replace("@bench/", "")}`;
    const deps = {};
    if (i > 0) deps[pkgName(i - 1)] = "workspace:*";
    write(
      `${dir}/package.json`,
      JSON.stringify({ name, scripts: { test: "vitest run" }, dependencies: deps }, null, 2),
    );
    for (let f = 0; f < filesPerPackage; f++) {
      const importLine =
        f === 0 && i > 0 ? `import { v as prev } from "${pkgName(i - 1)}";\n` : "";
      write(
        `${dir}/src/file-${f}.ts`,
        `${importLine}export const v = ${i * 1000 + f};\n`,
      );
    }
    write(`${dir}/src/file-0.test.ts`, "// placeholder\n");
  }
}

function git(args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

let jsonCold = null;
let jsonWarm = null;

function run(label, extraArgs) {
  const started = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [cliPath, "--root", root, "--format", "json", ...extraArgs], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (res.status !== 0) {
    console.error(`${label} failed (${res.status}):\n${res.stderr}`);
    process.exit(1);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    console.error(`${label} produced non-JSON output`);
    process.exit(1);
  }
  return { label, ms, parsed };
}

try {
  const genStart = Date.now();
  generate();
  git(["init", "-q", "-b", "main"]);
  git(["add", "."]);
  git(["-c", "user.email=bench@example.invalid", "-c", "user.name=bench", "commit", "-qm", "fixture"]);

  // Touch one file so the diff is non-empty.
  write(`packages/pkg-${String(packages - 1).padStart(pad, "0")}/src/file-0.ts`, "export const v = -1;\n");

  const genMs = Date.now() - genStart;
  const cold = run("no-cache", ["--no-cache"]);
  // --verbose adds stats.cache (hit/filesHashed/filesReused) to the JSON.
  const cacheMiss = run("cache-miss", ["--verbose"]);
  const cacheHit = run("cache-hit", ["--verbose"]);
  jsonCold = cold.parsed;
  jsonWarm = cacheHit.parsed;

  const rows = [cold, cacheMiss, cacheHit].map((r) => {
    const s = r.parsed.stats ?? {};
    return {
      run: r.label,
      ms: Math.round(r.ms),
      hashed: s.cache ? s.cache.filesHashed : "-",
      reused: s.cache ? s.cache.filesReused : "-",
      inGraph: s.sourceFilesParsed ?? "-",
      packages: s.packagesTotal ?? "-",
      affected: s.packagesAffected ?? "-",
    };
  });

  // stats.cache is verbose-only and intentionally differs between runs.
  const withoutCacheStats = (value) => {
    const copy = structuredClone(value);
    if (copy.stats) delete copy.stats.cache;
    return JSON.stringify(copy);
  };
  const consistent =
    withoutCacheStats(jsonCold) === withoutCacheStats(jsonWarm) ? "yes" : "NO (unexpected)";

  const cpu = os.cpus()[0]?.model?.trim() ?? "unknown CPU";
  const lines = [];
  lines.push(`# Synthetic benchmark sample`);
  lines.push("");
  lines.push(`Generated ${packages} packages x ${filesPerPackage} source files (${packages * filesPerPackage} TS files), fixture creation ${genMs} ms.`);
  lines.push("");
  lines.push("| run | wall time (ms) | files hashed | files reused | source files in graph | packages | affected |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    lines.push(
      `| ${row.run} | ${row.ms} | ${row.hashed} | ${row.reused} | ${row.inGraph} | ${row.packages} | ${row.affected} |`,
    );
  }
  lines.push("");
  lines.push(
    "`files hashed` is the number of source/tsconfig files read and hashed for the cache key this run; `files reused` is the number whose hash came from the metadata sidecar.",
  );
  lines.push(
    "`source files in graph` is the graph payload's `filesParsed` counter; it is reported on cache hits too, where no parsing happened.",
  );
  lines.push("");
  lines.push(`JSON identical between --no-cache and cache-hit (ignoring verbose stats.cache): ${consistent}`);
  lines.push("");
  lines.push(`Machine: ${os.platform()} ${os.release()} ${os.arch()}, ${cpu}, Node ${process.version}.`);
  lines.push("");
  lines.push("These are single-run samples from this machine. Re-run `node scripts/bench.mjs` to reproduce; results are not guarantees.");
  process.stdout.write(lines.join("\n") + "\n");
} finally {
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  else console.error(`fixture kept at ${root}`);
}
