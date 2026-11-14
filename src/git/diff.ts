import path from "node:path";
import { ImpactError } from "../errors.js";
import type { ChangedFile, ChangeStatus, DiffInfo } from "../types.js";
import { assertSafeRef, gitExec, splitNul, toPosix, type GitExec } from "./exec.js";

export interface DiffResult {
  info: DiffInfo;
  files: ChangedFile[];
  warnings: { code: "SHALLOW_CLONE" | "WORKING_TREE_MISMATCH"; message: string }[];
}

export async function repoRoot(cwd: string, exec: GitExec = gitExec): Promise<string> {
  const res = await exec(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
  if (res.code !== 0) {
    throw new ImpactError(
      `Not inside a git repository (from ${cwd}). Run impact inside a git work tree.`,
      2,
    );
  }
  return res.stdout.toString("utf8").trim();
}

async function revParse(
  ref: string,
  cwd: string,
  exec: GitExec,
): Promise<string | null> {
  assertSafeRef(ref);
  const res = await exec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd,
    allowFailure: true,
  });
  if (res.code !== 0) return null;
  return res.stdout.toString("utf8").trim() || null;
}

const BASE_CANDIDATES = ["origin/main", "origin/master", "main", "master"];

export async function resolveBase(
  explicit: string | undefined,
  cwd: string,
  exec: GitExec = gitExec,
): Promise<{ ref: string; sha: string }> {
  if (explicit) {
    const sha = await revParse(explicit, cwd, exec);
    if (!sha) {
      throw new ImpactError(`Cannot resolve base ref: ${explicit}`, 2);
    }
    return { ref: explicit, sha };
  }
  const tried: string[] = [];
  for (const cand of BASE_CANDIDATES) {
    tried.push(cand);
    const sha = await revParse(cand, cwd, exec);
    if (sha) return { ref: cand, sha };
  }
  throw new ImpactError(
    `Could not auto-detect a base ref. Tried: ${tried.join(", ")}. Pass --base <ref> explicitly.`,
    2,
  );
}

async function mergeBase(
  base: string,
  head: string,
  cwd: string,
  exec: GitExec,
): Promise<{ sha: string; shallow: boolean }> {
  const res = await exec(["merge-base", base, head], { cwd, allowFailure: true });
  if (res.code !== 0) {
    return { sha: base, shallow: true };
  }
  return { sha: res.stdout.toString("utf8").trim(), shallow: false };
}

function mapStatus(code: string): ChangeStatus {
  const c = code[0];
  switch (c) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "modified";
    default:
      return "unknown";
  }
}

export function parseNameStatus(buf: Buffer): ChangedFile[] {
  const tokens = splitNul(buf);
  const out: ChangedFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (!status) continue;
    const code = status[0];
    if (code === "R" || code === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath && newPath) {
        out.push({
          path: toPosix(newPath),
          oldPath: toPosix(oldPath),
          status: mapStatus(code),
        });
      }
      continue;
    }
    const p = tokens[i++];
    if (p) {
      out.push({ path: toPosix(p), status: mapStatus(code) });
    }
  }
  return out;
}

export interface CollectDiffOptions {
  root: string;
  base?: string;
  head?: string;
  working: boolean;
  exec?: GitExec;
  /** Opt in to using the base ref when merge-base cannot be computed. */
  allowShallowFallback?: boolean;
}

export async function collectDiff(opts: CollectDiffOptions): Promise<DiffResult> {
  const exec = opts.exec ?? gitExec;
  const cwd = opts.root;
  const warnings: DiffResult["warnings"] = [];

  const base = await resolveBase(opts.base, cwd, exec);
  const headRef = opts.head ?? "HEAD";
  assertSafeRef(headRef);
  const headSha = await revParse(headRef, cwd, exec);
  if (!headSha) {
    throw new ImpactError(`Cannot resolve head ref: ${headRef}`, 2);
  }
  const mb = await mergeBase(base.sha, headSha, cwd, exec);
  const mergeBaseSha = mb.shallow ? base.sha : mb.sha;
  if (mb.shallow && !opts.allowShallowFallback) {
    throw new ImpactError(
      `Cannot compute merge-base between ${base.ref} and ${headRef}. ` +
        `If this is a shallow clone, run "git fetch --unshallow" (or fetch enough history), ` +
        `or pass --base <ref> explicitly. ` +
        `Pass --allow-shallow-fallback to analyze ${base.ref}..${headRef} anyway.`,
      2,
    );
  }
  if (mb.shallow) {
    warnings.push({
      code: "SHALLOW_CLONE",
      message: `merge-base failed between ${base.ref} and ${headRef}; falling back to ${base.ref} because --allow-shallow-fallback was set. The diff may include changes not on this branch.`,
    });
  }

  const files = new Map<string, ChangedFile>();
  const addFile = (f: ChangedFile) => {
    const existing = files.get(f.path);
    if (!existing) {
      files.set(f.path, f);
      return;
    }
    const order: ChangeStatus[] = [
      "unknown",
      "modified",
      "untracked",
      "added",
      "renamed",
      "copied",
      "deleted",
    ];
    const merged: ChangedFile =
      order.indexOf(f.status) > order.indexOf(existing.status)
        ? { ...existing, ...f }
        : existing;
    if (f.oldPath && !merged.oldPath) merged.oldPath = f.oldPath;
    files.set(f.path, merged);
  };

  const committed = await exec(
    ["diff", "--name-status", "-z", "-M", "-C", mergeBaseSha, headSha],
    { cwd },
  );
  for (const f of parseNameStatus(committed.stdout)) addFile(f);

  if (opts.working) {
    const wt = await exec(["diff", "--name-status", "-z", "-M", "-C", mergeBaseSha], {
      cwd,
    });
    for (const f of parseNameStatus(wt.stdout)) addFile(f);

    const untracked = await exec(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd },
    );
    for (const p of splitNul(untracked.stdout)) {
      addFile({ path: toPosix(p), status: "untracked" });
    }

    if (headRef !== "HEAD") {
      const dirty = await exec(["status", "--porcelain"], { cwd, allowFailure: true });
      if (dirty.code === 0 && dirty.stdout.toString("utf8").trim().length > 0) {
        warnings.push({
          code: "WORKING_TREE_MISMATCH",
          message: `Working tree has local changes but --head=${headRef} is not HEAD. The dependency graph is built from the working tree, not ${headRef}.`,
        });
      }
    }
  }

  const list = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));

  return {
    info: {
      base: base.ref,
      baseSha: base.sha,
      head: headRef,
      headSha,
      mergeBase: mergeBaseSha,
      includesWorkingTree: opts.working,
      mergeBaseFallback: mb.shallow ? true : undefined,
    },
    files: list,
    warnings,
  };
}

export async function readFileAtRev(
  rev: string,
  repoRelativePath: string,
  cwd: string,
  exec: GitExec = gitExec,
): Promise<string | null> {
  assertSafeRef(rev);
  const spec = `${rev}:${toPosix(repoRelativePath)}`;
  const res = await exec(["show", spec], { cwd, allowFailure: true });
  if (res.code !== 0) return null;
  return res.stdout.toString("utf8");
}

export async function listWorkTreeFiles(
  cwd: string,
  exec: GitExec = gitExec,
): Promise<string[]> {
  const res = await exec(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd },
  );
  return splitNul(res.stdout).map(toPosix).sort();
}

export function resolveFromRoot(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ImpactError(`Path escapes repository root: ${p}`, 2);
  }
  return abs;
}
