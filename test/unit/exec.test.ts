import { describe, expect, it } from "vitest";
import { splitNul, toPosix, assertSafeRef } from "../../src/git/exec.js";
import { ImpactError } from "../../src/errors.js";

describe("splitNul", () => {
  it("splits NUL-separated entries", () => {
    const buf = Buffer.from("a\0b\0c\0", "utf8");
    expect(splitNul(buf)).toEqual(["a", "b", "c"]);
  });

  it("handles empty buffer", () => {
    expect(splitNul(Buffer.alloc(0))).toEqual([]);
  });
});

describe("toPosix", () => {
  it("normalizes windows separators and leading ./", () => {
    expect(toPosix("packages\\ui\\x.ts")).toBe("packages/ui/x.ts");
    expect(toPosix("./packages/ui/x.ts")).toBe("packages/ui/x.ts");
  });
});

describe("assertSafeRef", () => {
  it("accepts normal refs", () => {
    expect(() => assertSafeRef("main")).not.toThrow();
    expect(() => assertSafeRef("origin/main")).not.toThrow();
    expect(() => assertSafeRef("v1.2.3")).not.toThrow();
    expect(() => assertSafeRef("9fceb02".repeat(5))).not.toThrow();
  });

  it("rejects refs that start with a dash", () => {
    expect(() => assertSafeRef("--output=/tmp/evil")).toThrow(ImpactError);
    expect(() => assertSafeRef("-m")).toThrow(ImpactError);
  });

  it("rejects empty and whitespace refs", () => {
    expect(() => assertSafeRef("")).toThrow(ImpactError);
    expect(() => assertSafeRef("main master")).toThrow(ImpactError);
  });
});
