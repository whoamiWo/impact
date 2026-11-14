# Benchmark

Reproducible harness: `node scripts/bench.mjs [--packages N] [--files M]`.

The script generates a throwaway synthetic monorepo (a linear `workspace:*` chain where each
package depends on the previous one), commits it, modifies one file, and measures three runs of
the CLI with `--format json`:

- **no-cache**: `--no-cache`, full source analysis every time (no cache key is computed).
- **cache-miss**: cache enabled, first run (hashes files, parses, writes the cache).
- **cache-hit**: cache enabled, second run (reuses stored hashes and the cached source graph).

Results depend on the machine, Node version and filesystem cache; the numbers below are
single-run samples recorded during development, not guarantees. Run the harness yourself to
reproduce or update them.

## Sample: 1000 packages x 20 source files (20 000 TS files)

| run | wall time (ms) | files hashed | files reused | source files in graph | packages | affected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| no-cache | 16332 | - | - | 21000 | 1000 | 1 |
| cache-miss | 20125 | 21001 | 0 | 21000 | 1000 | 1 |
| cache-hit | 2784 | 0 | 21001 | 21000 | 1000 | 1 |

JSON output was byte-identical between the `--no-cache` and `cache-hit` runs (ignoring the
verbose-only `stats.cache` counters).

Machine: linux 6.6.87.2-microsoft-standard-WSL2 x64, 12th Gen Intel(R) Core(TM) i7-12700H,
Node v22.23.2.

## Repeated samples: 3 consecutive runs (2026-11-13)

The harness was run three times back to back on the same host and fixture parameters:

| sample | no-cache (ms) | cache-miss (ms) | cache-hit (ms) |
| --- | ---: | ---: | ---: |
| 1 | 15771 | 19871 | 2433 |
| 2 | 15665 | 20040 | 2809 |
| 3 | 16272 | 20096 | 2636 |
| **min / median / max** | **15665 / 15771 / 16272** | **19871 / 20040 / 20096** | **2433 / 2636 / 2809** |

Use the median and range when quoting numbers; a single sample is not a guarantee.

Notes:

- `files hashed` is the number of source and tsconfig files read and hashed to build the cache
  key in that run. A warm run reuses hashes from `.git/impact-cache/v1/files.json` when a file's
  size and nanosecond mtime/ctime are unchanged, so it hashes 0 files and reuses all 21 001
  (`files reused`).
- `source files in graph` is the graph payload's `filesParsed` counter (1000 packages x 20 files
  + 1000 test files = 21 000). It is reported on cache hits too, where no parsing happened, so
  it measures graph size rather than work done in that run.
- The cache hit path runs `git ls-files` once, then `stat` calls with bounded concurrency for
  every candidate file; it does not re-read file contents. Warm runs on this shared host have
  ranged from about 2.4 s to 3.4 s across repeated samples, and earlier samples ranged from about
  2.7 s to 6.4 s, so the 3 s target is not reliably met at 20k files. Warm runs should be expected
  to take a few seconds at that scale. Single-run `no-cache` samples have likewise varied from
  about 7.3 s to 17.7 s with host load.
- The generated graph is a worst-case-ish linear chain; real repositories usually fan out
  differently, so do not extrapolate these times to your own workspace.
- Fixture generation took about 1 s and is excluded from the table.
