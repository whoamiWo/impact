# Contributing

Thanks for considering a contribution. This project keeps one core scenario: read git diff,
manifests and JS/TS source; report affected packages, test suggestions and deployables with reasons.

## Development setup

Requires Node.js >= 20 and git.

```bash
npm install
npm run build
npm test
npm run typecheck
```

`npm test` builds `dist/` and runs the vitest suites. e2e tests create throwaway git repositories
in the OS temporary directory.

## Pull requests

1. Keep changes focused; do not widen the core scope (see "Scope guard" below).
2. Add or update tests for behavior changes. e2e fixtures cover git edge cases.
3. Run `npm run build && npm test`.
4. Sign off your commits: `git commit -s`. This project uses DCO, not a CLA.
5. Update documentation when behavior, options or the JSON schema changes.

Commit messages: short imperative subject, optional body explaining the "why".

## Code conventions

- TypeScript, ESM, strict mode, Node >= 20.
- The runtime never accesses the network. Do not add network, telemetry or account features.
- All git invocations go through `spawn` with argument arrays. Never build shell strings.
- Keep output deterministic: sorted arrays, no timestamps, no absolute paths.
- JSON output is a compatibility surface. Add fields only; breaking changes bump `schemaVersion`.

## Scope guard

A new capability must answer: does it directly serve the diff -> affected packages/test/deployables
chain? If not, it belongs in the roadmap backlog or an external package, not the core CLI.

Explicitly out of scope for the core: running tests/builds/deploys, reading other tools' configs
(Nx/Turborepo/moon/Bazel), remote caches, dashboards, PR bots, watch mode, non-JS/TS source parsing
in v1, and anything requiring a network connection.

## Documentation wording

Documentation changes get the same review as code. Before submitting, confirm:

- No unverified performance numbers; benchmark results must be reproducible from this repository.
- No absolute claims ("fastest", "zero false positives").
- No disparagement of other tools; comparisons must cite verifiable facts and versions.
- Limitations and the local-first/no-telemetry promises are stated where relevant.
- Experimental features are labeled `experimental`.

## Provider extensions

`WorkspaceProvider` (see `src/workspace/provider.ts`) sketches a provider interface for other
workspace ecosystems, but the pipeline currently calls `discoverWorkspaces` directly and treats
`provider.ts` as experimental. There is no `SourceAnalyzer` interface; source analysis lives in
`src/graph/source-graph.ts` and is driven by the `source` config block. Both are backlog work —
discuss the design in an issue before implementing; interfaces are expected to change until 1.0.

## Release checklist

1. Bump `version` in `package.json` (the CLI and JSON output read it from there).
2. Update `CHANGELOG.md`; keep JSON schema changes additive.
3. `npm run typecheck`, `npm test`, `npm run check:no-network`.
4. `npm pack --dry-run` and `npm run smoke:pack` (installs the tarball into a temp project).
5. Re-run `npm run bench` and update `docs/benchmark.md` if performance-relevant code changed.
6. Confirm the npm package name is still available before the first publish.
7. **npm identity gate**:
   - Package name: `@whoamiwo/impact`
   - Registry: `https://registry.npmjs.org`
   - Verify current npm account appears in package maintainers with publish rights:
     ```bash
     npm whoami --registry https://registry.npmjs.org
     npm view @whoamiwo/impact maintainers --registry https://registry.npmjs.org
     ```
   - The account name does not need to match the package scope (`@whoamiwo`); any account listed as a maintainer can publish.
8. Tag the release; publish only after CI is green on Node 20 and 22.

## Security issues

Do not open public issues for vulnerabilities. See `SECURITY.md`.
