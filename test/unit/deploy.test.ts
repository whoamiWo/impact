import { describe, expect, it } from "vitest";
import { computeDeployables } from "../../src/deploy/units.js";
import { makeMatcher } from "../../src/pipeline.js";
import { defaultConfig } from "../helpers/config.js";
import type { Package } from "../../src/types.js";

const packages: Package[] = [
  {
    name: "@repo/web",
    dir: "apps/web",
    manifestPath: "apps/web/package.json",
    scripts: {},
    private: true,
  },
  {
    name: "@repo/admin",
    dir: "apps/admin",
    manifestPath: "apps/admin/package.json",
    scripts: {},
    private: true,
  },
  {
    name: "@repo/ui",
    dir: "packages/ui",
    manifestPath: "packages/ui/package.json",
    scripts: {},
    private: true,
  },
];

describe("computeDeployables", () => {
  it("falls back to first-level apps/* packages", () => {
    const units = computeDeployables({
      cfg: defaultConfig(),
      packages,
      changedFiles: [{ path: "apps/web/src/index.ts", status: "modified" }],
      affectedPackages: new Set(["@repo/web"]),
      configPath: null,
      root: "/repo",
      matchGlob: makeMatcher(),
    });
    expect(units.map((u) => u.name)).toEqual(["@repo/admin", "@repo/web"]);
    const web = units.find((u) => u.name === "@repo/web")!;
    expect(web.affected).toBe(true);
    expect(web.reasons).toContainEqual({ type: "package", package: "@repo/web" });
    expect(units.find((u) => u.name === "@repo/admin")!.affected).toBe(false);
  });

  it("uses configured deployables with package globs and paths", () => {
    const cfg = defaultConfig({
      deployables: [
        {
          name: "web",
          packages: ["@repo/web"],
          paths: ["deploy/web/**"],
          buildCommand: "pnpm --filter @repo/web build",
          deployCommand: "kubectl apply -k deploy/web",
        },
        {
          name: "platform",
          packages: ["@repo/ui"],
        },
      ],
    });
    const units = computeDeployables({
      cfg,
      packages,
      changedFiles: [{ path: "deploy/web/k8s.yaml", status: "modified" }],
      affectedPackages: new Set(["@repo/ui"]),
      configPath: null,
      root: "/repo",
      matchGlob: makeMatcher(),
    });
    const web = units.find((u) => u.name === "web")!;
    expect(web.affected).toBe(true);
    expect(web.reasons).toContainEqual({ type: "path", path: "deploy/web/k8s.yaml" });
    expect(web.buildCommand).toBe("pnpm --filter @repo/web build");
    const platform = units.find((u) => u.name === "platform")!;
    expect(platform.affected).toBe(true);
    expect(platform.reasons).toContainEqual({ type: "package", package: "@repo/ui" });
  });

  it("marks all deployables when the config file changes", () => {
    const cfg = defaultConfig({
      deployables: [{ name: "web", packages: ["@repo/web"] }],
    });
    const units = computeDeployables({
      cfg,
      packages,
      changedFiles: [{ path: "impact.config.json", status: "modified" }],
      affectedPackages: new Set(),
      configPath: "impact.config.json",
      root: "/repo",
      matchGlob: makeMatcher(),
    });
    expect(units[0].affected).toBe(true);
    expect(units[0].reasons).toContainEqual({ type: "path", path: "impact.config.json" });
  });

  it("marks deployables mapped to removed packages as affected", () => {
    const removedWeb: Package = {
      name: "@repo/web",
      dir: "apps/web",
      manifestPath: "apps/web/package.json",
      scripts: {},
      private: true,
      removed: true,
    };
    const cfg = defaultConfig({
      deployables: [{ name: "web", packages: ["@repo/web"] }],
    });
    const units = computeDeployables({
      cfg,
      packages: [...packages.filter((p) => p.name !== "@repo/web"), removedWeb],
      changedFiles: [{ path: "apps/web/package.json", status: "deleted" }],
      affectedPackages: new Set(["@repo/web"]),
      configPath: null,
      root: "/repo",
      matchGlob: makeMatcher(),
    });
    const web = units.find((u) => u.name === "web")!;
    expect(web.affected).toBe(true);
    expect(web.packages).toEqual([]);
    expect(web.reasons).toContainEqual({ type: "removedPackage", package: "@repo/web" });
  });

  it("keeps a removed apps/* package as an affected fallback deployable", () => {
    const removedAdmin: Package = { ...packages[1], removed: true };
    const units = computeDeployables({
      cfg: defaultConfig(),
      packages: [packages[0], removedAdmin, packages[2]],
      changedFiles: [{ path: "apps/admin/src/index.ts", status: "deleted" }],
      affectedPackages: new Set(["@repo/admin"]),
      configPath: null,
      root: "/repo",
      matchGlob: makeMatcher(),
    });
    const admin = units.find((u) => u.name === "@repo/admin")!;
    expect(admin.affected).toBe(true);
    expect(admin.packages).toEqual([]);
    expect(admin.reasons).toContainEqual({
      type: "removedPackage",
      package: "@repo/admin",
    });
  });

  it("returns nothing when there are no apps and no config", () => {
    const units = computeDeployables({
      cfg: defaultConfig(),
      packages: packages.filter((p) => !p.dir.startsWith("apps/")),
      changedFiles: [],
      affectedPackages: new Set(),
      configPath: null,
      root: "/repo",
      matchGlob: makeMatcher(),
    });
    expect(units).toEqual([]);
  });
});
