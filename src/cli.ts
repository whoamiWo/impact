#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { ImpactError, UsageError } from "./errors.js";
import { analyze } from "./pipeline.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { renderText } from "./output/text.js";
import { renderJson } from "./output/json.js";
import { renderGithub, type GithubTarget } from "./output/github.js";
import type { AnalyzeOptions } from "./types.js";
import { TOOL_VERSION } from "./version.js";

const USAGE = `impact - local-first monorepo change impact analysis

Usage:
  impact [analyze] [options]
  impact doctor [options]

Options (analyze):
  --base <ref>             Base ref. Default: auto (origin/main, origin/master, main, master)
  --head <ref>             Head ref. Default: HEAD
  --no-working             Analyze only committed range, ignore working tree
  --allow-shallow-fallback When merge-base fails, analyze base..head instead of exiting (2)
  --depth <direct|transitive>  Dependent propagation depth (default: transitive)
  --format <text|json|github>  Output format (default: text)
  --github-target <test|deploy>  Matrix type for --format github (default: test)
  --files                  Include file-level test suggestions
  --only <packages|tests|deployables>  Trim text output
  --config <path>          Config file path
  --root <path>            Repository or subdirectory (default: cwd)
  --no-cache               Disable the source graph cache
  --verbose                Print parsing/graph statistics to stderr
  --help                   Show this help

Exit codes:
  0 success (also when nothing is affected)
  1 analysis or internal error
  2 usage or configuration error
`;

interface CliOptions {
  command: "analyze" | "doctor";
  analyze: AnalyzeOptions;
  format: "text" | "json" | "github";
  githubTarget: GithubTarget;
  only?: "packages" | "tests" | "deployables";
  help: boolean;
  version: boolean;
}

const VALUE_OPTIONS = new Set([
  "--base",
  "--head",
  "--depth",
  "--format",
  "--github-target",
  "--only",
  "--config",
  "--root",
]);

function extractSubcommand(argv: string[]): {
  command: "analyze" | "doctor";
  rest: string[];
} | null {
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (VALUE_OPTIONS.has(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      i++;
      continue;
    }
    // First bare token: must be a subcommand.
    if (token === "analyze" || token === "doctor") {
      return { command: token, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
    }
    if (token === "help") return null;
    return { command: "analyze", rest: argv };
  }
  return { command: "analyze", rest: argv };
}

function parseCli(argv: string[]): CliOptions {
  const extracted = extractSubcommand(argv);
  if (extracted === null) return baseOptions({ help: true });
  const command = extracted.command;
  const rest = extracted.rest;

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        base: { type: "string" },
        head: { type: "string" },
        working: { type: "boolean" },
        "no-working": { type: "boolean" },
        "allow-shallow-fallback": { type: "boolean" },
        depth: { type: "string" },
        format: { type: "string" },
        "github-target": { type: "string" },
        files: { type: "boolean" },
        only: { type: "string" },
        config: { type: "string" },
        root: { type: "string" },
        cache: { type: "boolean" },
        "no-cache": { type: "boolean" },
        verbose: { type: "boolean" },
        help: { type: "boolean" },
        version: { type: "boolean" },
      },
    });
  } catch (err) {
    throw new UsageError(`${(err as Error).message}\n\n${USAGE}`);
  }

  const v = parsed.values;
  if (v.help) return baseOptions({ help: true, command });
  if (v.version) return baseOptions({ version: true });

  const depth = v.depth ?? "transitive";
  if (depth !== "direct" && depth !== "transitive") {
    throw new UsageError(`--depth must be "direct" or "transitive", got ${JSON.stringify(depth)}`);
  }
  const format = v.format ?? "text";
  if (format !== "text" && format !== "json" && format !== "github") {
    throw new UsageError(`--format must be text, json or github, got ${JSON.stringify(format)}`);
  }
  const githubTarget = v["github-target"] ?? "test";
  if (githubTarget !== "test" && githubTarget !== "deploy") {
    throw new UsageError(
      `--github-target must be "test" or "deploy", got ${JSON.stringify(githubTarget)}`,
    );
  }
  const only = v.only;
  if (only !== undefined && only !== "packages" && only !== "tests" && only !== "deployables") {
    throw new UsageError(
      `--only must be packages, tests or deployables, got ${JSON.stringify(only)}`,
    );
  }

  const working = v["no-working"] ? false : v.working === false ? false : true;

  return {
    command,
    analyze: {
      root: v.root ?? process.cwd(),
      base: v.base,
      head: v.head ?? "HEAD",
      working,
      depth,
      files: v.files === true,
      configPath: v.config,
      cache: v["no-cache"] ? false : v.cache === false ? false : true,
      verbose: v.verbose === true,
      allowShallowFallback: v["allow-shallow-fallback"] === true,
    },
    format,
    githubTarget,
    only,
    help: false,
    version: false,
  };
}

function baseOptions(overrides: Partial<CliOptions>): CliOptions {
  return {
    command: "analyze",
    analyze: {
      root: process.cwd(),
      head: "HEAD",
      working: true,
      depth: "transitive",
      files: false,
      cache: true,
      verbose: false,
    },
    format: "text",
    githubTarget: "test",
    help: false,
    version: false,
    ...overrides,
  };
}

async function main(argv: string[]): Promise<number> {
  const opts = parseCli(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return 0;
  }

  if (opts.command === "doctor") {
    process.stdout.write(await runDoctor(opts.analyze));
    return 0;
  }

  const ctx = await analyze(opts.analyze);

  if (opts.analyze.verbose) {
    const lines = renderDoctor(ctx).split("\n").slice(0, 8);
    const cacheStats = ctx.result.stats.cache;
    if (cacheStats) {
      lines.push(
        `cache: ${cacheStats.hit ? "hit" : "miss"}, files hashed=${cacheStats.filesHashed} reused=${cacheStats.filesReused}`,
      );
    }
    process.stderr.write(lines.join("\n") + "\n");
  }

  switch (opts.format) {
    case "json":
      process.stdout.write(renderJson(ctx.result));
      break;
    case "github":
      process.stdout.write(renderGithub(ctx.result, opts.githubTarget));
      break;
    case "text":
    default:
      process.stdout.write(renderText(ctx.result, { files: opts.analyze.files, only: opts.only }));
      break;
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof ImpactError) {
      process.stderr.write(`impact: ${err.message}\n`);
      process.exitCode = err.exitCode;
      return;
    }
    const e = err as Error;
    process.stderr.write(`impact: unexpected error: ${e.message}\n`);
    if (process.env.IMPACT_DEBUG) process.stderr.write(`${e.stack ?? ""}\n`);
    process.exitCode = 1;
  });
