# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, minor
versions may include behavior changes; JSON schema additions stay additive.

## [Unreleased]

## [0.1.2] - 2026-11-19

Dependency and CI maintenance patch. CLI output, JSON shape and `schemaVersion: 1` are unchanged.

### Security

- Upgrade `zod` from 3.x to 4.6.7, fixing the runtime advisory GHSA-mrhx-c7xc-m3w5
  (CVE-2023-54404: oversized arrays could exhaust memory). Config parsing now uses `prefault`
  and two-argument `z.record`; accepted config structure, section defaults, `.strict()`
  rejection and `version: 1` semantics are unchanged.
- Upgrade `vitest` from 2.x to 5.1.1, clearing the dev-only test-server advisories
  GHSA-5xrq-8626-4rwp and GHSA-9crc-q9x8-hgqq. CI runs `vitest run` only, so these servers
  were never part of the published CLI.
- After this release, both `npm audit --omit=dev` (runtime) and full `npm audit` report no
  known vulnerabilities.

### Changed

- Upgrade CI actions to `actions/checkout` v7.0.1 and `actions/setup-node` v7.1.0, pinned by
  commit SHA. `permissions: contents: read` and the check names `test (20)` / `test (22)` are
  unchanged.
- Upgrade `@types/picomatch` to 4.x (development types only).
- Group Dependabot npm and GitHub Actions minor/patch updates and ignore major updates for
  `typescript` (runtime compiler API) and `@types/node` (Node 20/22 support range).
- Keep TypeScript on 5.9.x; TypeScript 7 does not expose the compiler API used by the source
  graph.

## [0.1.1] - 2026-11-16

Docs/metadata only; no runtime behavior change.

### Docs

- Move published-package installation and a diff-to-impact example to the README quick start.
- Add neutral comparisons with task runners, build systems and GitHub path filters.
- Link the public real-workspace validation and its limitations; add release badges and CI context.
- Remove the hard-coded version from the bug report template.

## [0.1.0] - 2026-11-14

Initial public baseline.

### Added

- `impact` CLI: `analyze` (default) and `doctor` subcommands, `--format text|json|github`,
  `--base`, `--head`, `--depth`, `--root`, `--config`, `--no-cache`, `--only`, `--verbose`,
  `--allow-shallow-fallback`.
- Workspace discovery from `workspaces` config, `pnpm-workspace.yaml` (parsed as YAML), and
  `package.json` `workspaces`; pnpm/npm/yarn/bun package manager detection.
- Manifest graph across `dependencies`, `devDependencies`, `optionalDependencies` and
  (opt-in) `peerDependencies`; TypeScript/JavaScript source graph with tsconfig `paths`,
  relative imports, and `.js` -> `.ts` resolution.
- Impact analysis with `direct` / `dependent` / `global` classification, reasons for every
  entry, and conservative reverse-dependency propagation.
- Test suggestions per package manager, file-level test lookup, and GitHub Actions matrix
  output with index-aligned commands.
- Deployable mapping from config or the `apps/*` fallback; deleted packages are reported with
  a `removedPackage` reason.
- Content-addressed source graph cache under `.git/impact-cache/v1/` with atomic writes, plus a
  `files.json` hash sidecar that reuses content hashes when size and nanosecond mtime/ctime are
  unchanged (warm runs only `stat` source files).
- Doctor diagnostics that complete instead of failing when git, config, or workspace discovery
  is broken.
- Local-first guarantees: read-only analysis, no network access, no telemetry.
- Repository hygiene: CI (Node 20/22), no-network static check, governance and security docs.

### Changed

- Warm cache runs no longer re-read unchanged source files. `.git/impact-cache/v1/files.json`
  stores each hashed file's size and nanosecond mtime/ctime next to its hash; the hash is reused
  when all three match (a missing or malformed sidecar falls back to full hashing and never
  changes results). `--no-cache` now also skips computing the cache key entirely.
- The warm cache path reuses the already-listed worktree files instead of running `git ls-files`
  twice, and stats candidate files with bounded concurrency while preserving deterministic
  ordering.
- `--verbose` adds `stats.cache` (`hit`, `filesHashed`, `filesReused`) to JSON output and prints
  a cache line to stderr; default JSON output is unchanged and stays byte-identical between
  `--no-cache` and cache-hit runs.

### Docs

- `docs/benchmark.md` clarifies that the old "source files parsed" column measures graph size,
  not work done per run, adds a "files hashed" column, and records updated samples including
  honest warm-cache timing.
- `README.md` documents the verbose-only `stats.cache` field.

### Fixed

- An in-place package rename (same directory, new manifest name) is attributed to the new
  package instead of the synthesized removed package sharing its directory.
- Cache validation checks every payload element instead of trusting the top-level shape.
- Package-level `tsconfig.json` `baseUrl`/`paths` are rebased on the package directory and
  loaded in a deterministic later-wins order.
- Merge-base failures are reported with a non-zero exit and an actionable message instead of
  silently analyzing the wrong range; `--allow-shallow-fallback` opts in explicitly.
- Deployables are marked affected when their only package is deleted.
- Override test commands stay index-aligned with script names in text and GitHub output.
- Dependency chains keep the shortest path instead of accumulating longer ones.
- Duplicate workspace package names are rejected with exit code 2 and the conflicting
  directories instead of silently dropping a package.
- pnpm `!` negation entries in `pnpm-workspace.yaml` are applied as exclusions.
