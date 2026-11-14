import { spawn } from "node:child_process";
import fs from "node:fs";
import { ImpactError } from "../errors.js";

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export type GitExec = (
  args: string[],
  opts?: { cwd?: string; allowFailure?: boolean },
) => Promise<ExecResult>;

export function assertSafeRef(ref: string): void {
  if (!ref || ref.startsWith("-")) {
    throw new ImpactError(`Unsafe or empty git ref: ${JSON.stringify(ref)}`, 2);
  }
  if (/[\s\\'"`;|&<>$(){}[\]]/.test(ref)) {
    throw new ImpactError(`Ref contains disallowed characters: ${JSON.stringify(ref)}`, 2);
  }
}

export const gitExec: GitExec = (args, opts = {}) => {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c) => stdoutChunks.push(Buffer.from(c)));
    child.stderr.on("data", (c) => stderrChunks.push(Buffer.from(c)));
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT" && opts.cwd && !fs.existsSync(opts.cwd)) {
        reject(new ImpactError(`Directory does not exist: ${opts.cwd}`, 2));
        return;
      }
      reject(
        new ImpactError(
          `Failed to spawn git: ${err.message}. Is git installed and on PATH?`,
          2,
        ),
      );
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0 && !opts.allowFailure) {
        reject(
          new ImpactError(
            `git ${args.join(" ")} failed (exit ${code}): ${stderr.trim().slice(0, 800)}`,
            1,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
};

export function splitNul(buf: Buffer): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      out.push(buf.toString("utf8", start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.toString("utf8", start));
  return out.filter((s) => s.length > 0);
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}
