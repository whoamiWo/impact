# impact

[![CI](https://github.com/whoamiWo/impact/actions/workflows/ci.yml/badge.svg)](https://github.com/whoamiWo/impact/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40whoamiwo%2Fimpact)](https://www.npmjs.com/package/@whoamiwo/impact)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Local-first change impact analysis for JavaScript/TypeScript workspace monorepos.

## Quick start

Requires Node.js >= 20 and a git repository using pnpm, npm, yarn or bun workspaces.

```bash
npm install --save-dev @whoamiwo/impact
npx impact analyze
```

Or run the published package without installing it:

```bash
npx @whoamiwo/impact@0.1.1 analyze
```

For a reproducible CI range, select the commits explicitly:

```bash
npx impact analyze --base origin/main --head HEAD --no-working
```

`impact` reads the git diff, workspace manifests and source imports. It does not run tests,
builds or deployments, access the network, collect telemetry, or modify your repository apart
from the optional `.git/impact-cache/v1/` cache. See [Privacy](#privacy) and
[Known limitations](#known-limitations).

### Example: one change, a dependent and its checks

For this workspace, `@repo/web` imports `@repo/ui`; only
`packages/ui/src/button.tsx` changed:

```text
impact: origin/main (12345678) .. HEAD (abcdef12)
changed files: 1  affected packages: 2/42  deployables: 1

Affected packages:
  @repo/ui [direct, high]
    - changed: packages/ui/src/button.tsx
    test: pnpm --filter @repo/ui run test
  @repo/web [dependent, high]
    - depends on @repo/ui via @repo/ui -> @repo/web
    test: pnpm --filter @repo/web run test

Deployables:
  web (affected)
    - package @repo/web
```

The configured deployable named `web` maps to `@repo/web`. This is the analysis output, not
commands that `impact` executed. Use `--format json` for the
complete, stable machine-readable result, including each package's reasons and dependency chain.
See [Output](#output) for a JSON example and [GitHub Actions](#github-actions) for matrix output.

`impact` reads a git diff plus your workspace manifests and source files, then reports:

1. affected packages (direct changes and their dependents),
2. suggested test commands (optionally file-level),
3. affected deployables,

with a reason for every conclusion.

Local-first: no network, no telemetry. Read-only: `impact` never runs tests, builds or deploys.
Known limitations are documented in [Known limitations](#known-limitations) below.

## What it does / does not do

Does:

- Computes affected packages from a merged manifest + source import graph.
- Suggests per-package test commands for pnpm, npm, yarn and bun.
- Emits stable JSON, a text summary, or GitHub Actions matrices.
- Explains each impact (`direct`, `dependent`, `global`) with a dependency chain or changed files.

Does not:

- Run tests, builds or deployments.
- Read Nx, Turborepo, moon or Bazel configuration.
- Support non-JS/TS source parsing in v1.
- Contact the network, collect telemetry, or modify your repository.
- Rewrite dependencies or manage releases.

## When to use it

- Pre-commit self-checks in a workspace monorepo.
- A PR CI step that needs an executable test matrix without adopting a task runner.
- Repositories that use pnpm/npm/yarn/bun workspaces and want impact analysis without migrating build tooling.

## How it fits with other tools

`impact` is an analysis CLI, not a replacement for a task runner or build system. You can use its
JSON or GitHub Actions matrix alongside the tools below.

| Approach | What it provides | Relationship to `impact` |
| --- | --- | --- |
| [Nx](https://nx.dev/ci/features/affected) and [Turborepo](https://turborepo.com/docs/crafting-your-repository/using-affected) | Task running, build orchestration and affected-project selection | `impact` does not read their configuration or run tasks; it can provide independent, reasoned analysis in the same workspace. |
| [Pants](https://www.pantsbuild.org/stable/docs/using-pants/advanced-target-selection) and [Bazel](https://bazel.build/query/guide) | Target-level graph and build-system capabilities | `impact` uses workspace manifests and JS/TS imports; adopting Pants or Bazel is not required. |
| [GitHub path filters](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore) | File glob matching for workflow triggers | `impact` additionally propagates changes through workspace dependency and source-import edges. |

These links describe the tools' documented behavior; consult their current documentation for
configuration and version-specific details.

## CLI

```
impact [analyze] [options]
impact doctor
```

| Option | Default | Description |
| --- | --- | --- |
| `--base <ref>` | auto | Base ref. Auto tries `origin/main`, `origin/master`, `main`, `master`, then asks for `--base`. |
| `--head <ref>` | `HEAD` | Head ref. |
| `--no-working` | off | Analyze only the committed range; ignore the working tree. |
| `--allow-shallow-fallback` | off | When merge-base fails (e.g. shallow clone), analyze `base..head` instead of exiting `2`; emits `SHALLOW_CLONE` and sets `diff.mergeBaseFallback`. |
| `--depth <direct\|transitive>` | `transitive` | Dependent propagation depth. |
| `--format <text\|json\|github>` | `text` | Output format. |
| `--github-target <test\|deploy>` | `test` | Matrix type for `--format github`. |
| `--files` | off | Include file-level test suggestions. |
| `--only <packages\|tests\|deployables>` | all | Trim the text output. JSON and GitHub output are always complete. |
| `--config <path>` | auto | Config file path, relative to the repo root. |
| `--root <path>` | cwd | Repository root or any subdirectory. |
| `--no-cache` | off | Disable the source graph cache entirely (no cache key is computed). |
| `--verbose` | off | Print graph statistics to stderr, and add cache counters (`stats.cache`: `hit`, `filesHashed`, `filesReused`) to JSON output. |

Exit codes: `0` success (even when nothing is affected), `1` analysis or internal error, `2` usage or configuration error.

### GitHub Actions

```yaml
- id: impact
  run: |
    npx @whoamiwo/impact analyze \
      --base "${{ github.event.pull_request.base.sha }}" \
      --head "${{ github.sha }}" \
      --no-working \
      --format github --github-target test > test-matrix.json
- run: echo "matrix=$(cat test-matrix.json)" >> "$GITHUB_OUTPUT"
```

Empty results emit `{ "include": [] }` so CI does not need a special case.

## Configuration

Create `impact.config.json`, `impact.config.yaml` or `impact.config.yml` at the repo root.
Only JSON/YAML is supported; configuration is data, never executed.

```yaml
version: 1

workspaces:
  include: ["apps/*", "packages/*", "tools/*"]
  exclude: ["**/fixtures/**"]

source:
  enabled: true
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]
  tsconfig: ["tsconfig.base.json", "packages/*/tsconfig.json"]
  maxFileBytes: 1048576

graph:
  devDependencies: true
  optionalDependencies: true
  peerDependencies: false

impact:
  unowned: global            # global | warn | ignore
  lockfiles: global          # global | ignore
  alwaysAffected: ["@repo/config"]
  globalGlobs:
    - "package.json"
    - "tsconfig.base.json"
    - "pnpm-workspace.yaml"
    - "impact.config.*"
  ignoreGlobs:
    - "**/*.md"
    - "**/*.mdx"
    - "docs/**"
    - ".github/**"

tests:
  scripts: ["test"]
  commands: {}               # package name or glob -> command string/array override
  include:
    - "**/*.test.*"
    - "**/*.spec.*"
    - "**/__tests__/**"
  maxFiles: 500

deployables:
  - name: web
    packages: ["@repo/web"]
    paths: ["apps/web/**", "deploy/web/**"]
    buildCommand: "pnpm --filter @repo/web build"
    deployCommand: "kubectl apply -k deploy/web"
```

Rules:

- All globs are relative to the repo root; `package.json` matches only the root manifest.
- Multiple config files are an error; use `--config` to override.
- Package directories and config paths must stay inside the repo root.
- Without `deployables`, first-level packages under `apps/*` become deployables.
- Deployable reasons are `package`, `path` and `removedPackage`; `packages` lists only packages that still exist, while a deleted package that a deployable maps to appears as a `removedPackage` reason.
- Without `alwaysAffected`, nothing is forced.

## Output

JSON output has `schemaVersion: 1`. Fields are only added, never renamed; breaking changes bump the version.
All arrays are sorted; output contains no timestamps or absolute paths, so the same input produces identical bytes.
With `--verbose`, `stats` also contains `cache` (`hit`, `filesHashed`, `filesReused`); default output
omits it so cache modes stay byte-identical.

A trimmed JSON result for the example above (the `@repo/ui` package is omitted for brevity):

```json
{
  "schemaVersion": 1,
  "tool": { "name": "impact", "version": "0.1.1" },
  "diff": {
    "base": "origin/main",
    "baseSha": "…",
    "head": "HEAD",
    "headSha": "…",
    "mergeBase": "…",
    "includesWorkingTree": true
  },
  "changedFiles": [
    { "path": "packages/ui/src/button.tsx", "status": "modified" }
  ],
  "packages": [
    {
      "name": "@repo/web",
      "dir": "apps/web",
      "impact": "dependent",
      "confidence": "high",
      "reasons": [
        { "type": "dependency", "via": "@repo/ui", "chain": ["@repo/ui", "@repo/web"] }
      ],
      "test": {
        "scripts": ["test"],
        "commands": ["pnpm --filter @repo/web run test"]
      },
      "testFiles": []
    }
  ],
  "deployables": [
    { "name": "web", "packages": ["@repo/web"], "affected": true, "reasons": [{ "type": "package", "package": "@repo/web" }] }
  ],
  "warnings": [],
  "stats": {
    "changedFiles": 1,
    "packagesTotal": 42,
    "packagesAffected": 2,
    "deployablesAffected": 1,
    "sourceFilesParsed": 120
  }
}
```

Warning codes: `UNRESOLVED_IMPORT`, `PHANTOM_DEPENDENCY`, `DYNAMIC_IMPORT`, `NO_TEST_SCRIPT`, `UNOWNED_CHANGE`, `FILE_TOO_LARGE`, `SHALLOW_CLONE`, `DELETED_PACKAGE`, `NO_WORKSPACE_CONFIG`, `NO_PACKAGE_MANAGER`, `WORKING_TREE_MISMATCH`, `TEST_FILE_LIMIT`, `GENERIC`.

Two workspace manifests declaring the same package `name` are a hard error (exit code 2) that
lists the conflicting directories, because the package graph is keyed by name.

## Impact semantics

- `direct`: the package owns a changed file.
- `dependent`: a reverse dependency chain from a direct or global seed reaches the package.
- `global`: a lockfile, global config file, or unowned change applies to every package.
- `confidence: high` means the graph had a declared manifest edge or a resolved source import.
  `medium` is used for global propagation or when unresolved imports exist.

Default behavior is conservative: it prefers over-reporting to silently missing a dependent.
Use `--depth direct`, `ignoreGlobs`, `alwaysAffected` and `lockfiles: ignore` to narrow results.

## Validation

The [v0.1.0 release notes](https://github.com/whoamiWo/impact/releases/tag/v0.1.0#user-content-real-world-validation-post-release)
record public, post-release analyses of two real workspaces using the published npm package:

- [zod](https://github.com/colinhacks/zod): a committed range with direct and global impacts, test
  suggestions, warnings and cache-mode output comparison. This is a real CLI run, not an upstream
  project endorsement.
- [Turborepo](https://github.com/vercel/turbo): pnpm workspace negation, dependency propagation
  and the `apps/*` deployable fallback, including warnings for unresolved imports and unowned
  non-JS/TS files.

The release notes include repository URLs, base/head commits, result summaries and limitations;
no missed JS/TS dependents were identified in those runs. These are examples, not evidence of
complete coverage for every workspace. Report a public reproduction for incorrect results through
[a bug report](https://github.com/whoamiWo/impact/issues/new?template=bug_report.yml).

For performance context, [docs/benchmark.md](docs/benchmark.md) provides a reproducible synthetic
1000-package, 20,000-source-file fixture. Three cache-hit samples on the documented Linux WSL2 /
i7-12700H / Node 22 host were 2433, 2636 and 2809 ms (median 2636 ms, range 2433–2809 ms). These
machine-specific samples are not a performance guarantee for other repositories.

## Known limitations

- v1 parses only `.ts .tsx .js .jsx .mjs .cjs .mts .cts` source imports; other languages are not analyzed.
- Dynamic imports with non-literal specifiers are not resolved; a `DYNAMIC_IMPORT` warning is emitted.
- Source analysis uses the working tree. If `--head` is not `HEAD` and the tree is dirty, a warning is emitted.
- tsconfig `paths` supports a single `*` per pattern; complex `exports` maps are approximated.
- `tsconfig.json` `extends` is not followed; tsconfig files must declare `baseUrl`/`paths` inline.
- Package-level tsconfigs are rebased on their own directory. Entries are applied in
  `source.tsconfig` order, so a later file (usually the package config) overrides the same path
  pattern from an earlier one (usually the root config).
- pnpm `!` negation entries in `pnpm-workspace.yaml` are treated as exclusions; use
  `workspaces.exclude` for additional exclusions.
- A merge-base failure exits with code 2 and an actionable message; pass `--allow-shallow-fallback`
  to analyze `base..head` anyway (a `SHALLOW_CLONE` warning and `diff.mergeBaseFallback: true` are
  emitted).
- The cache key is a content hash of source files and configured tsconfig files; changes to other
  files do not invalidate it. To avoid re-reading unchanged files, `.git/impact-cache/v1/files.json`
  records each file's size and nanosecond mtime/ctime together with its hash and reuses the hash
  when all three match (any content write changes ctime, which user space cannot back-date). A
  missing or malformed sidecar simply rehashes everything; it can never change results. Cache
  writes are atomic and failures are ignored.
- Deleting `.git/impact-cache/` is always safe and reverts to re-hashing every file.
- Files over `source.maxFileBytes` are skipped with a warning.
- Windows is normalised to POSIX paths; v1 is primarily tested on Linux and macOS.
- Large repositories: only synthetic benchmark samples exist so far; see [docs/benchmark.md](docs/benchmark.md) for the harness and recorded numbers.

## Privacy

- No network access from the CLI. No telemetry, no accounts.
- Read-only for the repository. The only write is the cache under `.git/impact-cache/v1/`.
- Use `--no-cache` to avoid the cache entirely.

## Development

```bash
npm install
npm run build
npm test          # build then run vitest suites
npm run typecheck
npm run check:no-network
npm run bench     # synthetic benchmark; see docs/benchmark.md
npm run smoke:pack  # pack + install the tarball into a temp project (needs npm registry access)
```

## Roadmap

- Provider interfaces for Python, Go and JVM source analysis.
- Coverage-driven test selection.
- Downstream adapters (`--format turbo-filter` and similar) that stay outside the core.
- Optional GitHub Action wrapper and PR summary comment.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions use DCO sign-off (`git commit -s`).

## License

Apache-2.0. See [LICENSE](LICENSE).
