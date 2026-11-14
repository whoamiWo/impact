import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SourceGraph, Warning } from "./types.js";

export const PARSER_VERSION = "source-graph-v1";

export const FILES_META_VERSION = "files-v1";

export interface CachePayload {
  graph: SourceGraph;
  warnings: Warning[];
}

/**
 * Stat signature for one file. Content hashes are reused only when size and
 * nanosecond mtime/ctime are unchanged. ctime cannot be back-dated from user
 * space, so any content write invalidates the entry even if mtime is restored.
 */
export interface FileHashEntry {
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  hash: string;
}

interface FilesMeta {
  version: string;
  files: Record<string, FileHashEntry>;
}

const EMPTY_HASHES: ReadonlyMap<string, FileHashEntry> = new Map();

export class SourceGraphCache {
  private readonly dir: string;

  constructor(
    root: string,
    private readonly enabled: boolean,
  ) {
    this.dir = path.join(root, ".git", "impact-cache", "v1");
  }

  private fileFor(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  private metaFile(): string {
    return path.join(this.dir, "files.json");
  }

  /**
   * Stored file hashes used to skip re-reading unchanged files. A missing,
   * malformed or partially invalid sidecar degrades to "rehash everything",
   * so it can never change analysis results.
   */
  async getFileHashes(): Promise<ReadonlyMap<string, FileHashEntry>> {
    if (!this.enabled) return EMPTY_HASHES;
    try {
      const text = await fs.readFile(this.metaFile(), "utf8");
      const data = JSON.parse(text) as FilesMeta;
      if (!isValidFilesMeta(data)) return EMPTY_HASHES;
      return new Map(Object.entries(data.files));
    } catch {
      return EMPTY_HASHES;
    }
  }

  async setFileHashes(entries: Map<string, FileHashEntry>): Promise<void> {
    if (!this.enabled) return;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const payload: FilesMeta = {
        version: FILES_META_VERSION,
        files: Object.fromEntries(entries),
      };
      const target = this.metaFile();
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fs.rename(tmp, target);
    } catch {
      // Cache failures must never break analysis.
    }
  }

  async get(key: string): Promise<CachePayload | null> {
    if (!this.enabled) return null;
    try {
      const text = await fs.readFile(this.fileFor(key), "utf8");
      const data = JSON.parse(text) as CachePayload;
      if (!isValidPayload(data)) return null;
      return data;
    } catch {
      return null;
    }
  }

  async set(key: string, payload: CachePayload): Promise<void> {
    if (!this.enabled) return;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const target = this.fileFor(key);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fs.rename(tmp, target);
    } catch {
      // Cache failures must never break analysis.
    }
  }
}

function isValidPayload(value: unknown): value is CachePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as { graph?: unknown; warnings?: unknown };
  if (!v.graph || typeof v.graph !== "object") return false;
  const g = v.graph as { fileEdges?: unknown; packageEdges?: unknown; filesParsed?: unknown };
  if (!Array.isArray(g.fileEdges) || !Array.isArray(g.packageEdges)) return false;
  if (typeof g.filesParsed !== "number" || !Number.isFinite(g.filesParsed)) return false;
  if (!g.fileEdges.every(isFileEdge)) return false;
  if (!g.packageEdges.every(isPackageEdge)) return false;
  if (!Array.isArray(v.warnings)) return false;
  if (!v.warnings.every(isWarning)) return false;
  return true;
}

function isFileEdge(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const e = value as { from?: unknown; to?: unknown };
  return typeof e.from === "string" && typeof e.to === "string" && e.from.length > 0 && e.to.length > 0;
}

function isPackageEdge(value: unknown): boolean {
  if (!isFileEdge(value)) return false;
  const e = value as { kind?: unknown };
  return e.kind === "manifest" || e.kind === "source";
}

function isWarning(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const w = value as { code?: unknown; message?: unknown };
  return typeof w.code === "string" && typeof w.message === "string";
}

function isValidFilesMeta(value: unknown): value is FilesMeta {
  if (!value || typeof value !== "object") return false;
  const v = value as { version?: unknown; files?: unknown };
  if (v.version !== FILES_META_VERSION) return false;
  if (!v.files || typeof v.files !== "object" || Array.isArray(v.files)) return false;
  for (const [file, entry] of Object.entries(v.files as Record<string, unknown>)) {
    if (file.length === 0) return false;
    if (!isFileHashEntry(entry)) return false;
  }
  return true;
}

function isFileHashEntry(value: unknown): value is FileHashEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as { size?: unknown; mtimeNs?: unknown; ctimeNs?: unknown; hash?: unknown };
  if (typeof e.size !== "number" || !Number.isFinite(e.size) || e.size < 0) return false;
  if (typeof e.mtimeNs !== "string" || !/^\d+$/.test(e.mtimeNs)) return false;
  if (typeof e.ctimeNs !== "string" || !/^\d+$/.test(e.ctimeNs)) return false;
  if (typeof e.hash !== "string" || !/^[0-9a-f]{64}$/.test(e.hash)) return false;
  return true;
}

export function sha256(data: string | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function hashKey(parts: string[]): string {
  const h = crypto.createHash("sha256");
  for (const part of parts) {
    h.update(part);
    h.update("\0");
  }
  return h.digest("hex");
}
