import { describe, expect, it } from "vitest";
import { parseNameStatus } from "../../src/git/diff.js";

function buf(entries: string[]): Buffer {
  return Buffer.from(entries.join("\0") + "\0", "utf8");
}

describe("parseNameStatus", () => {
  it("parses A/M/D entries", () => {
    const files = parseNameStatus(buf(["A", "a.ts", "M", "b.ts", "D", "c.ts"]));
    expect(files).toEqual([
      { path: "a.ts", status: "added" },
      { path: "b.ts", status: "modified" },
      { path: "c.ts", status: "deleted" },
    ]);
  });

  it("parses renames with oldPath", () => {
    const files = parseNameStatus(buf(["R100", "old.ts", "new.ts"]));
    expect(files).toEqual([{ path: "new.ts", oldPath: "old.ts", status: "renamed" }]);
  });

  it("parses copies", () => {
    const files = parseNameStatus(buf(["C075", "src.ts", "copy.ts"]));
    expect(files).toEqual([{ path: "copy.ts", oldPath: "src.ts", status: "copied" }]);
  });

  it("normalizes windows paths", () => {
    const files = parseNameStatus(buf(["M", "packages\\ui\\x.ts"]));
    expect(files[0].path).toBe("packages/ui/x.ts");
  });
});
