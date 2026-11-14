# AGENTS.md

## Project

`impact`: local-first, read-only change impact analysis CLI for JS/TS workspace monorepos.
Computes affected packages, test suggestions and deployables from a git diff.

## Commands

- `npm install` — install dependencies.
- `npm run build` — compile TypeScript to `dist/`.
- `npm test` — build then run vitest (unit + e2e). e2e spawns `dist/cli.js` against temp git repos.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run check:no-network` — static guard that src/ contains no network clients.
- `npm run bench` — synthetic benchmark harness (`scripts/bench.mjs`); samples in `docs/benchmark.md`.
- `npm run smoke:pack` — packs, tarball-installs into a temp project, runs `--version` + fixture analysis.

## Structure

```
src/
  cli.ts            parseArgs, subcommands, exit codes
  pipeline.ts       orchestration (root -> config -> workspace -> graph -> impact -> output data)
  version.ts        TOOL_VERSION read from package.json
  config.ts         config lookup, YAML/JSON parse, zod validation (version literal 1)
  git/exec.ts       spawn wrapper, NUL parsing, ref safety
  git/diff.ts       merge-base (fails without --allow-shallow-fallback), name-status, untracked files
  workspace/        workspace discovery + package manager detection
  graph/            manifest graph, TS source graph, import resolution
  impact/analyze.ts file attribution, global rules, shortest-chain reverse BFS propagation
  tests/suggest.ts  script probing, command rendering, file-level test lookup
  deploy/units.ts   deployable mapping (removed packages keep a `removedPackage` reason)
  output/           text, json, github renderers
  cache.ts          `.git/impact-cache/v1/` content-hashed source graph cache
                    (+ `files.json` stat/hash sidecar; malformed/absent means rehash all)
  doctor.ts         diagnostics (tolerant fallback via runDoctor)
scripts/
  bench.mjs         synthetic 1k-package benchmark
  smoke-pack.mjs    npm pack + tarball install smoke test
test/
  unit/             pure-function tests
  e2e/              CLI tests against throwaway git repos
  helpers/          shared fixtures (BASE_FILES, makeRepo; rebuilds stale dist/)
```

## Conventions

- ESM, `"type": "module"`, strict TypeScript, Node >= 20, imports use `.js` extensions.
- No network, no telemetry, no writes outside `.git/impact-cache/`.
- All git calls use `spawn` argument arrays; refs starting with `-` are rejected.
- JSON output: deterministic ordering, no timestamps, schemaVersion 1, additive changes only.
- Conservative impact defaults; every impact must carry a reason.

## Scope guard

Core scope is frozen (see `OPEN_CORE.md`, `GOVERNANCE.md`). New capabilities must serve
diff -> affected packages/tests/deployables directly; otherwise they belong in the backlog.

## Docs

User-facing docs follow the neutral wording rules in `CONTRIBUTING.md` and
`.github/pull_request_template.md`: no absolute claims, no unverified numbers, state limitations.
