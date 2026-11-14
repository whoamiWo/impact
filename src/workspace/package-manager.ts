import type { PackageManager } from "../types.js";
import { parsePackageJson } from "./npm.js";

export interface PackageManagerResult {
  manager: PackageManager;
  evidence: string;
  warning?: string;
}

const LOCKFILES: { file: string; manager: PackageManager }[] = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lockb", manager: "bun" },
  { file: "bun.lock", manager: "bun" },
  { file: "package-lock.json", manager: "npm" },
  { file: "npm-shrinkwrap.json", manager: "npm" },
];

export async function detectPackageManager(
  readFile: (relPath: string) => Promise<string | null>,
): Promise<PackageManagerResult> {
  const rootPkg = await readFile("package.json");
  if (rootPkg) {
    try {
      const parsed = parsePackageJson(rootPkg, "package.json");
      const field = (parsed as { packageManager?: unknown }).packageManager;
      if (typeof field === "string" && field.length > 0) {
        const name = field.split("@")[0].trim();
        if (name === "pnpm" || name === "yarn" || name === "npm" || name === "bun") {
          return {
            manager: name,
            evidence: `package.json packageManager="${field}"`,
          };
        }
      }
    } catch {
      // Fall through to lockfile detection.
    }
  }

  const found: { file: string; manager: PackageManager }[] = [];
  for (const entry of LOCKFILES) {
    const text = await readFile(entry.file);
    if (text !== null) found.push(entry);
  }
  if (found.length > 0) {
    return {
      manager: found[0].manager,
      evidence: `lockfile ${found[0].file}`,
      warning:
        found.length > 1
          ? `Multiple lockfiles found (${found.map((f) => f.file).join(", ")}); using ${found[0].file}.`
          : undefined,
    };
  }

  return {
    manager: "npm",
    evidence: "default (no packageManager field or lockfile found)",
    warning:
      "No package manager evidence found; defaulting to npm. Test commands use npm workspace syntax.",
  };
}

export const LOCKFILE_NAMES = LOCKFILES.map((l) => l.file);
